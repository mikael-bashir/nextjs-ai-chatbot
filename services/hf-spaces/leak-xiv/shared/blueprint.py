"""Blueprint parsing, structural safeguards, and graph validation.

Implements the `lean_compile` gates of Goedel-Architect (arXiv 2606.06468,
Appendix C.1): structural PRE-checks that reject a raw file before Lean is
ever invoked (returned as `Safeguard rejected`), and POST-compile
graph-validity checks over the parsed `@[blueprint]` declarations. The
concrete annotation syntax is the real LeanArchitect package
(github.com/hanwenzhu/LeanArchitect):

    @[blueprint
      (statement := /-- closed, typed NL proposition -/)
      (proof := /-- NL sketch citing parents by backticked name -/)]
    lemma name (binders) : conclusion := by sorry_using [p1, p2]

Blueprint files are machine-generated under a strict format contract, which
is what makes text-level parsing here sound: anything the parser cannot
recognise is itself a safeguard violation, never silently accepted.
"""

import os
import re
from dataclasses import dataclass, field

DECL_KINDS = ("theorem", "lemma", "def", "abbrev", "structure", "instance", "inductive")
DECL_START = re.compile(
    r"^\s*(?:@\[|(?:private\s+|protected\s+|noncomputable\s+|public\s+)*(?:theorem|lemma|def|abbrev|structure|instance|inductive)\b)"
)

# ---------------------------------------------------------------------------
# Forbidden constructs — `axiom` and `native_decide` are NOT the same hazard
# ---------------------------------------------------------------------------
# The paper (App. C.1) lists both together, and this stack originally banned
# them with one regex. They are different things and deserve different rules.
#
#   `axiom`         is a HOLE. It lets a model assume its way to the target
#                   ("axiom foo : <the goal>") and produce a file that compiles
#                   while proving nothing. Never allowed, in any mode.
#
#   `native_decide` is an ORACLE. It decides a closed decidable proposition by
#                   compiling and RUNNING it. It cannot be pointed at an open
#                   goal, and it cannot assume anything the evaluator does not
#                   actually compute. What it costs is kernel purity: the
#                   resulting proof term depends on `Lean.ofReduceBool` /
#                   `Lean.trustCompiler` rather than being checked by the
#                   kernel alone.
#
# Banning the oracle left this pipeline with NO way to check a number. With
# `decide`/`norm_num` also walled off by maxRecDepth on anything the size of
# `2026!`, every numeric claim in a blueprint was the backbone model's mental
# arithmetic — and it was repeatedly wrong (`12 = 4 * 9`, a little-endian
# `Nat.digits` list, `2^2018 ≤ …` for `2018 ≤ …`), each error costing a whole
# refinement iteration. So `native_decide` is allowed by default here, and the
# purity it costs is not hidden: Leak XIV records the certified proof's actual
# axiom dependencies (see `verify_full_script`), so a native_decide-backed
# certificate is distinguishable from a kernel-only one instead of silently
# passing as the same thing.
#
# Set ARCHITECT_ALLOW_NATIVE_DECIDE=0 to restore strict paper fidelity.
FORBIDDEN_AXIOM = re.compile(r"(?<![A-Za-z0-9_'.])axiom(?![A-Za-z0-9_'])")
FORBIDDEN_NATIVE = re.compile(r"(?<![A-Za-z0-9_'.])native_decide(?![A-Za-z0-9_'])")


def _env_flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in ("0", "false", "no", "off")


def allow_native_decide() -> bool:
    """Read live so a redeploy-free env change takes effect on the next call."""
    return _env_flag("ARCHITECT_ALLOW_NATIVE_DECIDE", True)


def forbidden_violations(stripped: str) -> list[str]:
    """Violations for a COMMENT-STRIPPED source. `axiom` always; the oracle
    only when explicitly disabled."""
    v: list[str] = []
    if FORBIDDEN_AXIOM.search(stripped):
        v.append("forbidden construct 'axiom' (it assumes rather than proves — never permitted)")
    if not allow_native_decide() and FORBIDDEN_NATIVE.search(stripped):
        v.append("forbidden construct 'native_decide' (ARCHITECT_ALLOW_NATIVE_DECIDE=0)")
    return v


def uses_native_decide(stripped: str) -> bool:
    return bool(FORBIDDEN_NATIVE.search(stripped))


# ---------------------------------------------------------------------------
# set_option whitelist — resource knobs are not soundness knobs
# ---------------------------------------------------------------------------
# The canonical node rebuild keeps only the submitted `:= by` body, so a
# `set_option ... in` the prover wrote was silently discarded. That made
# maxRecDepth walls unclimbable: on `factorial_base12_trailing_zeros` the
# prover wrote `set_option maxRecDepth 2000 in` six separate times, watched it
# vanish, and forfeited nodes whose ONLY failure was the recursion limit.
#
# These options change how much work the elaborator is willing to do. None of
# them can make a false proof typecheck, so they pass through the rebuild.
# Anything else still does not: `set_option` can also disable safety-relevant
# checks, and an open whitelist would be a real hole.
SET_OPTION_WHITELIST = (
    "maxRecDepth",
    "maxHeartbeats",
    "synthInstance.maxHeartbeats",
    "synthInstance.maxSize",
)
SET_OPTION_RE = re.compile(
    r"^[ \t]*set_option[ \t]+([A-Za-z_][A-Za-z0-9_.']*)[ \t]+(true|false|[0-9]+)[ \t]*(\bin\b)?[ \t]*$",
    re.M,
)


def extract_set_options(code: str) -> tuple[list[str], list[str]]:
    """Scan a submission for `set_option` commands.

    Returns (accepted-as-standalone-commands, violations). Accepted options are
    re-emitted by the caller ahead of the rebuilt declaration, so a prover can
    raise a resource ceiling without being able to smuggle anything else in."""
    accepted: list[str] = []
    violations: list[str] = []
    for m in SET_OPTION_RE.finditer(strip_comments(code)):
        name, value = m.group(1), m.group(2)
        if name in SET_OPTION_WHITELIST:
            cmd = f"set_option {name} {value}"
            if cmd not in accepted:
                accepted.append(cmd)
        else:
            violations.append(
                f"set_option '{name}' is not permitted (only resource limits pass through: "
                f"{', '.join(SET_OPTION_WHITELIST)})"
            )
    return accepted, violations


@dataclass
class Node:
    name: str
    kind: str                      # theorem | lemma | def | ...
    text: str                      # full declaration text incl. attribute
    attr_text: str                 # inside of @[...]
    signature: str                 # "<kind> <name> <binders> : <conclusion>" (no body)
    body: str                      # text after the top-level ":="
    statement_doc: str | None
    proof_doc: str | None
    deps: list[str] = field(default_factory=list)  # sorry_using ∪ (uses := [...])
    start_line: int = 0            # 1-based, in the stripped-of-imports code
    end_line: int = 0


# ---------------------------------------------------------------------------
# Lexical helpers
# ---------------------------------------------------------------------------

def strip_comments(src: str) -> str:
    """Replace comments with spaces (preserving newlines/offsets)."""
    out = list(src)
    i, n = 0, len(src)
    depth = 0
    while i < n:
        c2 = src[i : i + 2]
        if depth == 0 and c2 == "--":
            j = src.find("\n", i)
            j = n if j < 0 else j
            for k in range(i, j):
                out[k] = " "
            i = j
        elif c2 == "/-":
            depth += 1
            out[i] = out[i + 1] = " "
            i += 2
        elif depth > 0 and c2 == "-/":
            depth -= 1
            out[i] = out[i + 1] = " "
            i += 2
        elif depth > 0:
            if src[i] != "\n":
                out[i] = " "
            i += 1
        else:
            i += 1
    return "".join(out)


def block_comments_balanced(src: str) -> bool:
    depth = 0
    i, n = 0, len(src)
    while i < n:
        c2 = src[i : i + 2]
        if depth == 0 and c2 == "--":
            j = src.find("\n", i)
            i = n if j < 0 else j
            continue
        if c2 == "/-":
            depth += 1
            i += 2
            continue
        if c2 == "-/":
            depth -= 1
            if depth < 0:
                return False
            i += 2
            continue
        i += 1
    return depth == 0


def _match_attr_block(src: str, start: int) -> int:
    """Given index of '@[' return index just past the matching ']'."""
    assert src[start : start + 2] == "@["
    depth = 0
    i = start + 1
    n = len(src)
    while i < n:
        c = src[i]
        if c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return -1


def normalize_sig(sig: str) -> str:
    """Whitespace-insensitive normal form ('verbatim modulo whitespace')."""
    s = re.sub(r"\s+", " ", sig).strip()
    # `lemma` and `theorem` are interchangeable keywords for signature identity.
    s = re.sub(r"^lemma\b", "theorem", s)
    return s


# ---------------------------------------------------------------------------
# Declaration parsing
# ---------------------------------------------------------------------------

def split_decls(code: str) -> tuple[list[str], list[tuple[int, int]]]:
    """Split file body into top-level chunks by declaration starts.
    Returns (chunks, [(start_line, end_line)]) — 1-based inclusive lines."""
    stripped = strip_comments(code)
    lines = code.split("\n")
    slines = stripped.split("\n")
    # Chunk boundaries. Two subtleties: (1) a `lemma foo ...` line at bracket
    # depth > 0 sits INSIDE a still-open multi-line `@[...]` attribute; (2) an
    # attribute typically closes on the line BEFORE the keyword line, so a
    # keyword line only starts a new chunk if the current chunk already
    # carries its declaration keyword — otherwise it is the payload of the
    # pending attribute block.
    attr_start = re.compile(r"^\s*@\[")
    kw_start = re.compile(
        r"^\s*(?:private\s+|protected\s+|noncomputable\s+|public\s+)*"
        r"(?:theorem|lemma|def|abbrev|structure|instance|inductive)\b")
    starts: list[int] = []
    depth = 0
    chunk_has_kw = True  # so the first decl-keyword line opens a chunk
    for i, sl in enumerate(slines):
        if depth == 0:
            if attr_start.match(sl):
                starts.append(i)
                chunk_has_kw = False
            elif kw_start.match(sl):
                if chunk_has_kw:
                    starts.append(i)
                chunk_has_kw = True
        elif kw_start.match(sl):
            chunk_has_kw = True  # keyword absorbed inside an open attribute
        depth += sl.count("[") - sl.count("]")
        depth = max(depth, 0)
    if not starts:
        return [], []
    chunks, spans = [], []
    for idx, s in enumerate(starts):
        e = starts[idx + 1] - 1 if idx + 1 < len(starts) else len(lines) - 1
        chunks.append("\n".join(lines[s : e + 1]))
        spans.append((s + 1, e + 1))
    return chunks, spans


def _extract_docfield(attr: str, key: str) -> str | None:
    m = re.search(rf"\(\s*{key}\s*:=\s*/--([\s\S]*?)-/\s*\)", attr)
    return m.group(1).strip() if m else None


def _extract_uses(attr: str) -> list[str]:
    m = re.search(r"\(\s*uses\s*:=\s*\[([^\]]*)\]\s*\)", attr)
    if not m:
        return []
    return [x.strip().strip("`") for x in m.group(1).split(",") if x.strip()]


def parse_decl(chunk: str, span: tuple[int, int]) -> Node | None:
    """Parse one declaration chunk into a Node (None if unrecognisable)."""
    attr_text = ""
    rest = chunk
    stripped = strip_comments(chunk)
    at = stripped.find("@[")
    if at >= 0 and re.match(r"^\s*@\[", stripped):
        end = _match_attr_block(chunk, chunk.find("@["))
        if end < 0:
            return None
        attr_text = chunk[chunk.find("@[") + 2 : end - 1]
        rest = chunk[end:]
    m = re.search(
        r"(?:private\s+|protected\s+|noncomputable\s+|public\s+)*"
        r"(theorem|lemma|def|abbrev|structure|instance|inductive)\s+([A-Za-z_][A-Za-z0-9_'.]*)",
        strip_comments(rest),
    )
    if not m:
        return None
    kind, name = m.group(1), m.group(2)
    # Split signature / body at the top-level `:=` that actually introduces the
    # BODY. "First top-level `:=`" — what this used to do — is wrong whenever
    # the STATEMENT itself contains a term-level binder, because `let x : T := v`
    # and `have h : T := v` each put a `:=` at bracket depth 0 ahead of it.
    #
    # Observed live on `enclosing_circle_radius`, whose statement opens
    # `let k1 : ℚ := 1`: the signature was cut to
    # `theorem enclosing_circle_radius : let k1 : ℚ`, so the verbatim-signature
    # gate could never pass, and the remainder was read as the body, so the
    # `:= by sorry_using [...]` shape check failed too. Both safeguard errors,
    # every attempt, with no edit the model could make to escape — it burned the
    # whole stage probing (`Rat` for `ℚ`, one-lining, even a trivial `(1:ℚ) = 1`)
    # against a parser that was never going to look past the first `let`.
    #
    # Each `let`/`have` binder consumes exactly one `:=`, so count them and skip
    # that many. Binders nested inside brackets are already excluded by `depth`.
    srest = strip_comments(rest)
    depth = 0
    body_at = -1
    pending_binders = 0
    i = m.end()
    n = len(srest)
    while i < n - 1:
        c = srest[i]
        if c in "([{⟨":
            depth += 1
        elif c in ")]}⟩":
            depth -= 1
        elif depth == 0:
            if srest[i : i + 2] == ":=":
                if pending_binders:
                    pending_binders -= 1
                    i += 2
                    continue
                body_at = i
                break
            for kw in ("let", "have"):
                if not srest.startswith(kw, i):
                    continue
                prev = srest[i - 1] if i else " "
                nxt = srest[i + len(kw)] if i + len(kw) < n else " "
                # Real keyword, not a substring of an identifier ("complete").
                if not (prev.isalnum() or prev in "_'.") and not (nxt.isalnum() or nxt in "_'."):
                    pending_binders += 1
                break
        i += 1
    if body_at < 0:
        # structure/inductive bodies use `where`/`|` instead of `:=` — accept.
        signature = rest[m.start() : ].strip()
        body = ""
    else:
        signature = rest[m.start() : body_at].strip()
        body = rest[body_at + 2 :].strip()

    deps: list[str] = []
    su = re.search(r"sorry_using\s*\[([^\]]*)\]", strip_comments(rest))
    if su:
        deps += [x.strip().strip("`") for x in su.group(1).split(",") if x.strip()]
    deps += _extract_uses(attr_text)
    # de-dup, keep order
    seen, uniq = set(), []
    for d in deps:
        if d not in seen:
            seen.add(d)
            uniq.append(d)

    return Node(
        name=name,
        kind=kind,
        text=chunk.strip(),
        attr_text=attr_text,
        signature=signature,
        body=body,
        statement_doc=_extract_docfield(attr_text, "statement"),
        proof_doc=_extract_docfield(attr_text, "proof"),
        deps=uniq,
        start_line=span[0],
        end_line=span[1],
    )


# ---------------------------------------------------------------------------
# Safeguard pre-checks (before Lean is invoked)  — Appendix C.1
# ---------------------------------------------------------------------------

def precheck_blueprint(code: str, target_name: str, target_signature: str) -> list[str]:
    """Returns a list of violations; empty = pass. The file is never sent to
    Lean if this fails."""
    v: list[str] = []
    if not block_comments_balanced(code):
        v.append("unbalanced '/- ... -/' block comments")
    stripped = strip_comments(code)
    if not re.search(r"^\s*import\s+Mathlib\s*$", stripped, re.M):
        v.append("missing 'import Mathlib'")
    if not re.search(r"^\s*import\s+Architect\s*$", stripped, re.M):
        v.append("missing 'import Architect'")
    v += forbidden_violations(stripped)
    _, opt_violations = extract_set_options(code)
    v += opt_violations

    chunks, spans = split_decls(code)
    nodes = [n for n in (parse_decl(c, s) for c, s in zip(chunks, spans)) if n]

    main = [n for n in nodes if n.kind in ("theorem", "lemma") and n.name == target_name]
    if not main:
        v.append(f"missing main theorem '{target_name}'")
    else:
        want = normalize_sig(target_signature)
        got = normalize_sig(main[0].signature)
        if want != got:
            v.append(
                "main theorem signature does not match the targeted signature verbatim "
                f"(modulo whitespace).\n  expected: {want}\n  got:      {got}"
            )

    for n in nodes:
        sbody = strip_comments(n.body)
        if n.kind in ("theorem", "lemma"):
            if "blueprint" not in n.attr_text:
                v.append(f"'{n.name}': Lemma/Theorem without an '@[blueprint]' attribute")
            if not re.fullmatch(r"by\s+sorry_using\s*\[[^\]]*\]\s*", sbody.strip()):
                v.append(
                    f"'{n.name}': body must be exactly ':= by sorry_using [...]' "
                    "(bare 'sorry' or a real proof breaks dependency tracking)"
                )
        else:  # def / abbrev / structure / instance / inductive
            if re.search(r"(?<![A-Za-z0-9_'])sorry(_using)?(?![A-Za-z0-9_'])", sbody):
                v.append(f"'{n.name}': Definitions get a real Lean body, not 'sorry_using'/'sorry'")
    return v


# ---------------------------------------------------------------------------
# Post-compile graph validity  — Appendix C.1
# ---------------------------------------------------------------------------

def validate_graph(code: str, target_name: str) -> tuple[list[str], list[Node]]:
    """Graph-validity check over the parsed '@[blueprint]' decls. Assumes the
    file already compiled clean. Returns (violations, nodes-in-file-order)."""
    v: list[str] = []
    chunks, spans = split_decls(code)
    nodes = [n for n in (parse_decl(c, s) for c, s in zip(chunks, spans)) if n]
    byname = {n.name: n for n in nodes}

    if len(byname) != len(nodes):
        names = [n.name for n in nodes]
        dupes = sorted({x for x in names if names.count(x) > 1})
        v.append(f"duplicate node names: {', '.join(dupes)}")

    mains = [n for n in nodes if n.kind in ("theorem",) and n.name == target_name]
    # `lemma`-keyword main also acceptable as long as the name matches.
    mains += [n for n in nodes if n.kind == "lemma" and n.name == target_name]
    if len(mains) != 1:
        v.append(f"exactly one main Theorem named '{target_name}' must exist (found {len(mains)})")

    for n in nodes:
        if not n.statement_doc:
            v.append(f"'{n.name}': empty or missing '(statement := /-- ... -/)' field")
        if n.kind in ("theorem", "lemma") and not n.proof_doc:
            v.append(f"'{n.name}': Lemma/Theorem missing a non-empty '(proof := /-- ... -/)' field")
        for d in n.deps:
            if d == n.name:
                v.append(f"'{n.name}': self-loop in sorry_using")
            elif d not in byname:
                v.append(f"'{n.name}': dependency '{d}' does not resolve to a declared '@[blueprint]' node")

    # Acyclicity (Kahn) over resolvable edges.
    indeg = {n.name: 0 for n in nodes}
    for n in nodes:
        for d in n.deps:
            if d in indeg and d != n.name:
                indeg[n.name] += 1
    queue = [k for k, deg in indeg.items() if deg == 0]
    seen = 0
    rev: dict[str, list[str]] = {n.name: [] for n in nodes}
    for n in nodes:
        for d in n.deps:
            if d in rev and d != n.name:
                rev[d].append(n.name)
    while queue:
        x = queue.pop()
        seen += 1
        for y in rev.get(x, []):
            indeg[y] -= 1
            if indeg[y] == 0:
                queue.append(y)
    if seen != len(nodes):
        v.append("the sorry_using graph must be acyclic (a dependency cycle exists)")

    # Reverse-reachability from the main theorem: no isolated/dead nodes.
    if mains and len(mains) == 1:
        reach: set[str] = set()
        stack = [mains[0].name]
        while stack:
            x = stack.pop()
            if x in reach:
                continue
            reach.add(x)
            stack.extend(d for d in byname[x].deps if d in byname)
        dead = [n.name for n in nodes if n.name not in reach]
        if dead:
            v.append(
                "every node must be reachable, in reverse, from the main Theorem "
                f"(isolated/dead nodes: {', '.join(dead)})"
            )
    return v, nodes


def topo_order(nodes: list[Node]) -> list[Node]:
    byname = {n.name: n for n in nodes}
    out: list[Node] = []
    state: dict[str, int] = {}

    def visit(n: Node):
        st = state.get(n.name, 0)
        if st == 1 or st == 2:
            return
        state[n.name] = 1
        for d in n.deps:
            if d in byname:
                visit(byname[d])
        state[n.name] = 2
        out.append(n)

    for n in nodes:
        visit(n)
    return out


def strip_blueprint_attr(decl_text: str) -> str:
    """Remove the @[blueprint ...] attribute (keeping other attributes like
    @[simp] if co-listed) from a declaration's text."""
    at = decl_text.find("@[")
    if at < 0:
        return decl_text
    end = _match_attr_block(decl_text, at)
    if end < 0:
        return decl_text
    inner = decl_text[at + 2 : end - 1]
    parts, depth, cur = [], 0, []
    for ch in inner:
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    parts.append("".join(cur))
    kept = [p.strip() for p in parts if p.strip() and not p.strip().startswith(("blueprint", '"'))
            and not re.match(r"^\((statement|proof|uses|title|proofUses|notReady|discussion)\b", p.strip())]
    prefix = decl_text[:at]
    suffix = decl_text[end:].lstrip("\n")
    if kept:
        return f"{prefix}@[{', '.join(kept)}]\n{suffix}"
    return prefix + suffix
