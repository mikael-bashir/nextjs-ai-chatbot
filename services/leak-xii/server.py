"""Leak XII — the Goedel-Architect `lean_compile` gateway.

One HTTP tool, three modes, mirroring the paper's compile gate exactly:

  mode="blueprint"  Structural pre-checks (Safeguard) -> Lean compile against
                    a warm Mathlib+Architect environment -> post-compile
                    graph-validity checks over the parsed `@[blueprint]`
                    declarations. Success reads "Compilation SUCCESSFUL.
                    Validation SUCCESSFUL." and returns the dependency graph.

  mode="node"       Per-lemma proving compile. If the submission contains the
                    node's theorem, the system REBUILDS it under the canonical
                    statement (only the submitted `:= by ...` body is kept)
                    on top of a caller-supplied topological prefix (parent
                    defs real, parent lemmas sorried). Only this path can
                    register a solve. A `<name>_neg` submission is rebuilt
                    against the canonical negated signature and registers a
                    formal disproof. Anything else is an exploration compile:
                    raw feedback, no solve.

  mode="explore"    Bare snippet compile against the warm environment.

State lives entirely in the caller (the bridge orchestrator); this service is
stateless per-request on purpose — daemons hold Mathlib in RAM, nothing else.
"""

import os
import re
import sys

sys.path.insert(0, os.environ.get("SHARED_DIR", "/opt/shared"))

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import blueprint as bp
from repl_pool import ReplPool

BLUEPRINT_TIMEOUT_S = float(os.environ.get("BLUEPRINT_TIMEOUT_S", "600"))
NODE_TIMEOUT_S = float(os.environ.get("NODE_TIMEOUT_S", "300"))

app = FastAPI(title="Leak XII", version="1.0")

# Optional shared-secret gate. When LEAK_SERVICE_TOKEN is set, every request
# except /health must carry `Authorization: Bearer <token>`. These services
# compile arbitrary Lean, which can perform IO at elaboration time — so an
# open port without this is an unauthenticated code-execution surface.
SERVICE_TOKEN = os.environ.get("LEAK_SERVICE_TOKEN", "")


@app.middleware("http")
async def _require_token(request, call_next):
    if SERVICE_TOKEN and request.url.path != "/health":
        if request.headers.get("authorization", "") != f"Bearer {SERVICE_TOKEN}":
            return JSONResponse({"error": "unauthorized"}, status_code=401)
    return await call_next(request)


pool = ReplPool()


@app.on_event("startup")
async def _boot():
    await pool.boot()


@app.get("/health")
async def health():
    return {"service": "leak-xii", **pool.status()}


class Target(BaseModel):
    name: str
    signature: str          # full 'theorem <name> <binders> : <concl>' text
    negSignature: str | None = None


class CompileReq(BaseModel):
    mode: str               # blueprint | node | explore
    code: str               # the model's submission
    target: Target | None = None
    prefix: str | None = None    # node mode: topological parent context
    prelude: str | None = None   # node mode: open/set_option lines


SORRY_WARN = re.compile(r"declaration uses 'sorry'")
# Lean's "a tactic ran after its goal was already closed" family ("No goals to
# be solved", "no goals") — drives the auto-repair in `_compile_node`'s
# run_snippet.
NO_GOALS = re.compile(r"no goals", re.I)


def _messages(resp: dict):
    errs, warns = [], []
    for m in resp.get("messages", []) or []:
        entry = {
            "line": (m.get("pos") or {}).get("line"),
            "col": (m.get("pos") or {}).get("column"),
            "msg": m.get("data", ""),
        }
        (errs if m.get("severity") == "error" else warns).append(entry)
    return errs, warns


def _strip_imports(code: str) -> tuple[str, list[str]]:
    """Blank out import lines in place (the REPL env already has
    Mathlib+Architect) rather than deleting them; return
    (code-with-imports-blanked, list-of-import-lines).

    Deleting the lines outright — the previous behavior — shifted every
    line BELOW an import upward by one for each import removed. Blueprint
    mode and explore mode compile this function's returned body directly,
    so every diagnostic Lean reported for those modes was silently off by
    the stripped-import count from the very first declaration onward.
    Blanking instead of deleting keeps every other line's position
    identical to the original submission, so Lean's own line numbers need
    no further correction. See the FastMCP twin's identical fix
    (services/hf-spaces/leak-xii/server.py) for the full incident writeup."""
    imports, kept = [], []
    for ln in code.split("\n"):
        if re.match(r"^\s*import\s+\S+", ln):
            imports.append(ln.strip())
            kept.append("")
        else:
            kept.append(ln)
    return "\n".join(kept), imports


def _fmt_errors(errs: list[dict], limit: int = 30) -> str:
    lines = [f"  line {e['line']}, col {e['col']}: {e['msg']}" for e in errs[:limit]]
    if len(errs) > limit:
        lines.append(f"  ... and {len(errs) - limit} more errors")
    return "\n".join(lines)


@app.post("/compile")
async def compile_ep(req: CompileReq):
    if req.mode == "blueprint":
        return await compile_blueprint(req)
    if req.mode == "node":
        return await compile_node(req)
    return await compile_explore(req)


async def compile_blueprint(req: CompileReq):
    assert req.target is not None, "blueprint mode requires target"
    # --- Phase 1: structural pre-checks (file never reaches Lean on failure).
    violations = bp.precheck_blueprint(req.code, req.target.name, req.target.signature)
    if violations:
        report = "Safeguard rejected — fix these and call lean_compile again:\n" + \
            "\n".join(f"  - {x}" for x in violations)
        return {"ok": False, "phase": "precheck", "violations": violations, "report": report}

    # --- Phase 2: Lean compile.
    body, _ = _strip_imports(req.code)
    try:
        resp = await pool.run(body, timeout=BLUEPRINT_TIMEOUT_S)
    except RuntimeError as e:
        return {"ok": False, "phase": "compile", "errors": [],
                "report": f"Compile backend error: {e}"}
    errs, _warns = _messages(resp)
    if errs:
        return {"ok": False, "phase": "compile", "errors": errs,
                "report": "Compilation FAILED. Lean errors:\n" + _fmt_errors(errs)}

    # --- Phase 3: graph validity.
    violations, nodes = bp.validate_graph(req.code, req.target.name)
    if violations:
        report = "Compilation SUCCESSFUL. Validation FAILED:\n" + \
            "\n".join(f"  - {x}" for x in violations)
        return {"ok": False, "phase": "validation", "violations": violations, "report": report}

    ordered = bp.topo_order(nodes)
    graph = [{
        "name": n.name,
        "kind": n.kind,
        "signature": n.signature,
        "signatureNorm": bp.normalize_sig(n.signature),
        "declText": n.text,
        "declTextNoAttr": bp.strip_blueprint_attr(n.text),
        "statement": n.statement_doc,
        "proofSketch": n.proof_doc,
        "deps": n.deps,
    } for n in ordered]
    return {
        "ok": True, "phase": "validated",
        "report": "Compilation SUCCESSFUL. Validation SUCCESSFUL.",
        "graph": graph,
    }


def _negate_signature(signature: str) -> str:
    """theorem n (b1) (b2) : C   ->   theorem n_neg : ¬ (∀ (b1) (b2), C)"""
    m = re.match(r"\s*(theorem|lemma)\s+([A-Za-z_][A-Za-z0-9_'.]*)", signature)
    if not m:
        return signature
    rest = signature[m.end():]
    depth, i = 0, 0
    colon = -1
    while i < len(rest):
        c = rest[i]
        if c in "([{⟨":
            depth += 1
        elif c in ")]}⟩":
            depth -= 1
        elif c == ":" and depth == 0 and rest[i:i+2] != ":=":
            colon = i
            break
        i += 1
    if colon < 0:
        return signature
    binders = rest[:colon].strip()
    concl = rest[colon + 1:].strip()
    inner = f"∀ {binders}, {concl}" if binders else concl
    return f"theorem {m.group(2)}_neg : ¬ ({inner})"


async def compile_node(req: CompileReq):
    assert req.target is not None, "node mode requires target"
    sub, sub_imports = _strip_imports(req.code)
    violations = []
    if sub_imports:
        violations.append(
            f"submission adds import lines ({', '.join(sub_imports)}) — imports come from the canonical statement; this is a safeguard violation")
    if bp.FORBIDDEN.search(bp.strip_comments(sub)):
        violations.append("submission uses a forbidden construct ('axiom' or 'native_decide')")
    prelude_opens = set(re.findall(r"^\s*open\s+.*$", req.prelude or "", re.M))
    for o in re.findall(r"^\s*open\s+.*$", bp.strip_comments(sub), re.M):
        if o.strip() not in {p.strip() for p in prelude_opens}:
            violations.append(f"submission adds '{o.strip()}' — 'open' lines come from the canonical statement")

    # Locate the main (or negation) declaration in the submission.
    chunks, spans = bp.split_decls(sub)
    decls = [d for d in (bp.parse_decl(c, s) for c, s in zip(chunks, spans)) if d]
    main = next((d for d in decls if d.name == req.target.name), None)
    neg = next((d for d in decls if d.name == req.target.name + "_neg"), None)

    if violations:
        return {"ok": False, "solve": False, "phase": "precheck", "violations": violations,
                "report": "Safeguard rejected:\n" + "\n".join(f"  - {x}" for x in violations)}

    prelude = (req.prelude or "").strip()
    prefix = (req.prefix or "").strip()
    header = (prelude + "\n\n" if prelude else "") + (prefix + "\n\n" if prefix else "")
    header_lines = header.count("\n")

    async def run_snippet(snippet: str, decl_start_line: int, *, negated: bool,
                          repair: bool = True):
        try:
            resp = await pool.run(snippet, timeout=NODE_TIMEOUT_S)
        except RuntimeError as e:
            return {"ok": False, "solve": False, "phase": "compile", "errors": [],
                    "report": f"Compile backend error: {e}"}
        errs, warns = _messages(resp)
        node_sorries = [w for w in warns
                        if SORRY_WARN.search(w["msg"]) and (w["line"] or 0) >= decl_start_line]
        goals = [s.get("goal", "") for s in resp.get("sorries", []) or []
                 if ((s.get("pos") or {}).get("line") or 0) >= decl_start_line]
        solve = not errs and not node_sorries and not goals

        # ── Deterministic auto-repair (no LLM): "no goals to be solved" only ──
        # When EVERY error says a tactic ran after its goal was already closed
        # and all of them sit inside the rebuilt declaration, the proof is
        # complete modulo stray trailing tactics: drop exactly those lines and
        # compile once more. Single retry, never recursive, strictly no-worse —
        # if the repaired snippet does not fully solve, the ORIGINAL failure is
        # returned (plus a hint naming the fix). See the FastMCP twin
        # (services/hf-spaces/leak-xii/server.py) for the observed motivating run.
        if (repair and errs
                and all(NO_GOALS.search(e["msg"] or "") for e in errs)
                and all((e.get("line") or 0) >= decl_start_line for e in errs)):
            drop = {e["line"] for e in errs}
            kept = [ln for i, ln in enumerate(snippet.split("\n"), start=1)
                    if i not in drop]
            repaired = "\n".join(kept)
            r2 = await run_snippet(repaired, decl_start_line, negated=negated,
                                   repair=False)
            if r2.get("solve"):
                n = len(drop)
                r2["repairedSnippet"] = repaired
                r2["report"] = (
                    f"⚙️ Harness auto-repair: {n} stray tactic line(s) that ran after "
                    "their goal was already closed (\"no goals to be solved\") were "
                    "deleted; the remaining proof is complete.\n" + r2["report"])
                return r2
            hint = ("\nNote: every error above says a tactic ran AFTER its goal was "
                    "already closed — the proof is likely complete once those tactic "
                    "lines are deleted. Resubmit WITHOUT them; do not restructure.")
            report = "Compilation FAILED. Lean errors:\n" + _fmt_errors(errs) + hint
            return {"ok": False, "solve": False, "negated": negated, "phase": "compile",
                    "errors": errs, "openGoals": goals, "report": report}

        if errs:
            report = "Compilation FAILED. Lean errors:\n" + _fmt_errors(errs)
        elif not solve:
            report = ("Compiles, but the proof still contains sorry — NOT registered as a solve.\n"
                      + ("Open goals:\n" + "\n---\n".join(goals[:6]) if goals else ""))
        else:
            report = ("DISPROOF registered: the negated statement is proven. "
                      if negated else
                      "Proof COMPLETE — solve registered. ") + "Compilation SUCCESSFUL."
        return {"ok": solve, "solve": solve, "negated": negated, "phase": "compile",
                "errors": errs, "openGoals": goals, "report": report}

    if main is not None:
        body = main.body.strip()
        if not body:
            return {"ok": False, "solve": False, "phase": "precheck",
                    "report": "Safeguard rejected: main theorem has no ':=' proof body"}
        rebuilt = f"{req.target.signature.strip()} :=\n  {body}"
        snippet = header + rebuilt
        r = await run_snippet(snippet, header_lines + 1, negated=False)
        # If the no-goals auto-repair fired, register the REPAIRED text (what
        # actually compiled), not the submission.
        r["rebuilt"] = ("\n".join(r["repairedSnippet"].split("\n")[header_lines:])
                        if r.get("repairedSnippet") else rebuilt)
        return r

    if neg is not None:
        neg_sig = req.target.negSignature or _negate_signature(req.target.signature)
        body = neg.body.strip()
        if not body:
            return {"ok": False, "solve": False, "phase": "precheck",
                    "report": "Safeguard rejected: negation theorem has no ':=' proof body"}
        rebuilt = f"{neg_sig.strip()} :=\n  {body}"
        snippet = header + rebuilt
        r = await run_snippet(snippet, header_lines + 1, negated=True)
        r["rebuilt"] = ("\n".join(r["repairedSnippet"].split("\n")[header_lines:])
                        if r.get("repairedSnippet") else rebuilt)
        return r

    # Exploration compile: no main theorem in the submission -> raw feedback.
    snippet = header + sub
    try:
        resp = await pool.run(snippet, timeout=NODE_TIMEOUT_S)
    except RuntimeError as e:
        return {"ok": False, "solve": False, "phase": "compile", "errors": [],
                "report": f"Compile backend error: {e}"}
    errs, warns = _messages(resp)
    goals = [s.get("goal", "") for s in resp.get("sorries", []) or []
             if ((s.get("pos") or {}).get("line") or 0) > header_lines]
    report = ("[exploration compile — cannot register a solve; resubmit WITH the main theorem to finish]\n"
              + ("Lean errors:\n" + _fmt_errors(errs) if errs else "No errors.")
              + ("\nOpen goals:\n" + "\n---\n".join(goals[:6]) if goals else ""))
    return {"ok": not errs, "solve": False, "phase": "explore",
            "errors": errs, "openGoals": goals, "report": report}


async def compile_explore(req: CompileReq):
    body, _ = _strip_imports(req.code)
    try:
        resp = await pool.run(body, timeout=NODE_TIMEOUT_S)
    except RuntimeError as e:
        return {"ok": False, "phase": "compile", "errors": [], "report": f"Compile backend error: {e}"}
    errs, warns = _messages(resp)
    return {"ok": not errs, "phase": "explore", "errors": errs,
            "report": ("No errors." if not errs else "Lean errors:\n" + _fmt_errors(errs))}
