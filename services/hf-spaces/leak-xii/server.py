"""Leak XII — the Goedel-Architect `lean_compile` gateway.

Real FastMCP server (matching Leak-I/II's own wrapper architecture exactly:
mcp.server.fastmcp.FastMCP, @mcp.tool(), served via mcp.sse_app() + uvicorn
on 7860) rather than a bespoke REST API, so the app's existing "Add Server"
flow can register and live-handshake against it like every other Leak
server. All compile logic below is unchanged from the REST version — only
the outer interface changed.

One tool, three modes, mirroring the paper's compile gate exactly:

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
stateless per-call on purpose — daemons hold Mathlib in RAM, nothing else.
The `mode`/`target_*`/`prefix`/`prelude` arguments are bridge-supplied, not
model-supplied: the calling model only ever emits `code` (matching the
paper's own tool contract) — the bridge fills in the rest per call site
before issuing the actual MCP tools/call request.
"""

import asyncio
import json
import logging
import os
import re
import sys

sys.path.insert(0, os.environ.get("SHARED_DIR", "/opt/shared"))

import nest_asyncio
import uvicorn
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from starlette.middleware.cors import CORSMiddleware

import blueprint as bp
from repl_pool import ReplPool

nest_asyncio.apply()

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("leak-xii")

BLUEPRINT_TIMEOUT_S = float(os.environ.get("BLUEPRINT_TIMEOUT_S", "600"))
NODE_TIMEOUT_S = float(os.environ.get("NODE_TIMEOUT_S", "300"))

mcp = FastMCP(
    "Leak-XII",
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=False,
    ),
)

pool = ReplPool()

SORRY_WARN = re.compile(r"declaration uses 'sorry'")
# Failures that are about the elaborator running out of ROOM, not about the
# proof being wrong. The bridge treats these differently: a resource failure is
# grounds for raising a limit and retrying the SAME submission, never for
# rewriting the blueprint around a node that was never really refuted.
RESOURCE_LIMIT = re.compile(
    r"maximum recursion depth|deterministic timeout|maximum number of heartbeats"
    r"|\(deterministic\) timeout|maxHeartbeats",
    re.I,
)


def _is_resource_limit(errs: list[dict]) -> bool:
    return bool(errs) and all(RESOURCE_LIMIT.search(e.get("msg") or "") for e in errs)
# Lean's "a tactic ran after its goal was already closed" family ("No goals to
# be solved", "no goals"). When these are the ONLY errors in a node submission,
# the proof is complete modulo stray trailing tactics — see the auto-repair in
# `_compile_node.run_snippet`.
NO_GOALS = re.compile(r"no goals", re.I)


def _messages(resp: dict):
    errs, warns = [], []
    for m in resp.get("messages", []) or []:
        entry = {
            "line": (m.get("pos") or {}).get("line"),
            "col": (m.get("pos") or {}).get("column"),
            "msg": m.get("data", ""),
            "severity": m.get("severity", ""),
        }
        (errs if m.get("severity") == "error" else warns).append(entry)
    return errs, warns


def _info_output(warns: list[dict]) -> list[str]:
    """`#eval` / `#check` / `#print` results.

    Lean returns these at severity "info", which this service used to lump in
    with warnings and then never report. That silently disabled the pipeline's
    only numeric oracle: on `factorial_base12_trailing_zeros` the prover ran
    `#eval Nat.digits 3 2026` and was told, verbatim, "No errors." — the actual
    digit list discarded — after which the blueprint went on asserting a
    guessed (and wrong) one. Surfacing info output is what makes `#eval` an
    oracle instead of a no-op."""
    out = []
    for w in warns:
        if w.get("severity") == "info" and (w.get("msg") or "").strip():
            if SORRY_WARN.search(w["msg"] or ""):
                continue
            out.append(str(w["msg"]).strip())
    return out


def _fmt_info(infos: list[str], limit: int = 12) -> str:
    if not infos:
        return ""
    shown = infos[:limit]
    more = f"\n  ... and {len(infos) - limit} more" if len(infos) > limit else ""
    return "\nOutput (#eval / #check / #print):\n" + "\n".join(
        "  " + i.replace("\n", "\n  ") for i in shown) + more


def _strip_imports(code: str) -> tuple[str, list[str]]:
    """Remove import lines (the REPL env already has Mathlib+Architect);
    return (code-without-imports, list-of-import-lines)."""
    imports, kept = [], []
    for ln in code.split("\n"):
        if re.match(r"^\s*import\s+\S+", ln):
            imports.append(ln.strip())
        else:
            kept.append(ln)
    return "\n".join(kept), imports


def _fmt_errors(errs: list[dict], limit: int = 30) -> str:
    lines = [f"  line {e['line']}, col {e['col']}: {e['msg']}" for e in errs[:limit]]
    if len(errs) > limit:
        lines.append(f"  ... and {len(errs) - limit} more errors")
    return "\n".join(lines)


async def _compile_blueprint(code: str, target_name: str, target_signature: str) -> dict:
    # --- Phase 0: a scratch computation is not a blueprint. Both stage prompts
    # promise a bare `#eval` works here; without this it did not, and the model
    # guessed the constant instead of checking it.
    if bp.is_exploration_only(code):
        r = await _compile_explore(code)
        # `ok` is the blueprint stage's ACCEPTANCE signal — the bridge reads it as
        # "a validated graph is attached" and finishes the stage. _compile_explore
        # sets ok=True to mean "Lean reported no errors", which is a different
        # claim and carries no `graph`. Leaving it True ended the blueprint stage
        # on a bare #eval and crashed the run with `bp.graph is not iterable`.
        r["ok"] = False
        r["report"] = ("[exploration compile — no blueprint submitted, nothing validated; "
                       "resubmit the full annotated graph to finish]\n" + r.get("report", ""))
        return r

    # --- Phase 1: structural pre-checks (file never reaches Lean on failure).
    violations = bp.precheck_blueprint(code, target_name, target_signature)
    if violations:
        report = "Safeguard rejected — fix these and call lean_compile again:\n" + \
            "\n".join(f"  - {x}" for x in violations)
        return {"ok": False, "phase": "precheck", "violations": violations, "report": report}

    # --- Phase 2: Lean compile.
    body, _ = _strip_imports(code)
    try:
        resp = await pool.run(body, timeout=BLUEPRINT_TIMEOUT_S)
    except RuntimeError as e:
        return {"ok": False, "phase": "compile", "errors": [],
                "report": f"Compile backend error: {e}"}
    errs, warns = _messages(resp)
    # `#eval`/`#check`/`#print` output arrives as info messages. Node mode has
    # surfaced them since the numeric-oracle work; blueprint mode threw them
    # away, so a blueprint file carrying an `#eval` compiled, validated, and
    # returned nothing the model could read the value back from. Observed live
    # on shuffled_tables_mod: "The `#eval` output got suppressed."
    infos = _info_output(warns)
    if errs:
        return {"ok": False, "phase": "compile", "errors": errs, "info": infos,
                "report": "Compilation FAILED. Lean errors:\n" + _fmt_errors(errs) + _fmt_info(infos)}

    # --- Phase 3: graph validity.
    violations, nodes = bp.validate_graph(code, target_name)
    if violations:
        report = "Compilation SUCCESSFUL. Validation FAILED:\n" + \
            "\n".join(f"  - {x}" for x in violations) + _fmt_info(infos)
        return {"ok": False, "phase": "validation", "violations": violations,
                "info": infos, "report": report}

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
        "ok": True, "phase": "validated", "info": infos,
        "report": "Compilation SUCCESSFUL. Validation SUCCESSFUL." + _fmt_info(infos),
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


async def _compile_node(code: str, target_name: str, target_signature: str,
                         target_neg_signature: str, prefix: str, prelude: str) -> dict:
    sub, sub_imports = _strip_imports(code)
    violations = []
    if sub_imports:
        violations.append(
            f"submission adds import lines ({', '.join(sub_imports)}) — imports come from the canonical statement; this is a safeguard violation")
    violations += bp.forbidden_violations(bp.strip_comments(sub))
    # Resource-limit `set_option`s survive the canonical rebuild (see
    # bp.SET_OPTION_WHITELIST); anything else is still a violation.
    set_opts, opt_violations = bp.extract_set_options(sub)
    violations += opt_violations
    prelude_opens = set(re.findall(r"^\s*open\s+.*$", prelude or "", re.M))
    for o in re.findall(r"^\s*open\s+.*$", bp.strip_comments(sub), re.M):
        if o.strip() not in {p.strip() for p in prelude_opens}:
            violations.append(f"submission adds '{o.strip()}' — 'open' lines come from the canonical statement")

    chunks, spans = bp.split_decls(sub)
    decls = [d for d in (bp.parse_decl(c, s) for c, s in zip(chunks, spans)) if d]
    main = next((d for d in decls if d.name == target_name), None)
    neg = next((d for d in decls if d.name == target_name + "_neg"), None)

    if violations:
        return {"ok": False, "solve": False, "phase": "precheck", "violations": violations,
                "report": "Safeguard rejected:\n" + "\n".join(f"  - {x}" for x in violations)}

    prelude = (prelude or "").strip()
    prefix = (prefix or "").strip()
    # Whitelisted resource options are re-emitted ahead of everything else, so
    # they govern the sorried parent prefix and the rebuilt declaration alike.
    opts_block = ("\n".join(set_opts) + "\n\n") if set_opts else ""
    header = opts_block + (prelude + "\n\n" if prelude else "") + (prefix + "\n\n" if prefix else "")
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
        # Observed live (cyclotomic_2026_eval_one): a COMPLETE proof was
        # resubmitted ~15 times across two attempts and ultimately forfeited
        # because one trailing tactic (`norm_num` after a goal-closing `rw`)
        # errored with "No goals to be solved" — a state one line-deletion away
        # from a registered solve. When EVERY error is of that family and sits
        # inside the rebuilt declaration, drop exactly those lines and compile
        # once more. Single retry, never recursive, and strictly no-worse: if
        # the repaired snippet does not fully solve, the ORIGINAL result is
        # returned (plus a hint telling the model which lines to delete).
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

        infos = _info_output(warns)
        if errs:
            report = "Compilation FAILED. Lean errors:\n" + _fmt_errors(errs) + _fmt_info(infos)
        elif not solve:
            report = ("Compiles, but the proof still contains sorry — NOT registered as a solve.\n"
                      + ("Open goals:\n" + "\n---\n".join(goals[:6]) if goals else "")
                      + _fmt_info(infos))
        else:
            report = ("DISPROOF registered: the negated statement is proven. "
                      if negated else
                      "Proof COMPLETE — solve registered. ") + "Compilation SUCCESSFUL."
        return {"ok": solve, "solve": solve, "negated": negated, "phase": "compile",
                "errors": errs, "openGoals": goals, "info": infos,
                "resourceLimit": _is_resource_limit(errs), "report": report}

    if main is not None:
        body = main.body.strip()
        if not body:
            return {"ok": False, "solve": False, "phase": "precheck",
                    "report": "Safeguard rejected: main theorem has no ':=' proof body"}
        rebuilt = f"{target_signature.strip()} :=\n  {body}"
        snippet = header + rebuilt
        r = await run_snippet(snippet, header_lines + 1, negated=False)
        # If the no-goals auto-repair fired, the registered proof must be the
        # REPAIRED text (what actually compiled), not the submission.
        r["rebuilt"] = ("\n".join(r["repairedSnippet"].split("\n")[header_lines:])
                        if r.get("repairedSnippet") else rebuilt)
        return r

    if neg is not None:
        neg_sig = target_neg_signature or _negate_signature(target_signature)
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
    infos = _info_output(warns)
    report = ("[exploration compile — cannot register a solve; resubmit WITH the main theorem to finish]\n"
              + ("Lean errors:\n" + _fmt_errors(errs) if errs else "No errors.")
              + ("\nOpen goals:\n" + "\n---\n".join(goals[:6]) if goals else "")
              + _fmt_info(infos))
    return {"ok": not errs, "solve": False, "phase": "explore",
            "errors": errs, "openGoals": goals, "info": infos,
            "resourceLimit": _is_resource_limit(errs), "report": report}


async def _compile_explore(code: str) -> dict:
    body, _ = _strip_imports(code)
    try:
        resp = await pool.run(body, timeout=NODE_TIMEOUT_S)
    except RuntimeError as e:
        return {"ok": False, "phase": "compile", "errors": [], "report": f"Compile backend error: {e}"}
    errs, warns = _messages(resp)
    infos = _info_output(warns)
    return {"ok": not errs, "phase": "explore", "errors": errs, "info": infos,
            "resourceLimit": _is_resource_limit(errs),
            "report": ("No errors." if not errs else "Lean errors:\n" + _fmt_errors(errs))
                      + _fmt_info(infos)}


@mcp.tool()
async def lean_compile(
    code: str,
    mode: str = "explore",
    target_name: str = "",
    target_signature: str = "",
    target_neg_signature: str = "",
    prefix: str = "",
    prelude: str = "",
) -> str:
    """
    Compile Lean 4 code. `mode` is bridge-controlled per call site, not
    something you normally set yourself — you will typically only ever pass
    `code`. Returns a text report: safeguard violations, real Lean compiler
    errors, open goals, or a success/solve confirmation.

    In the default (node-proving) mode: submit your code EARLY, even with a
    partial proof using `sorry` as a placeholder for sub-goals you cannot yet
    discharge, and iterate (compile -> read errors / open goals -> patch ->
    compile). If your code includes the MAIN theorem with the canonical
    statement followed by `:= by ...`, the system rebuilds it under the
    original theorem statement -- only your proof body is kept; imports,
    `set_option`, and `open` lines come from the canonical statement, and any
    other top-level declarations are dropped. Only this case can register a
    solve. Do not use `axiom`; use `have` for helper lemmas inside your proof,
    not top-level declarations; do not add `import`/`open` lines beyond what
    the canonical statement already has -- extras are flagged as a safeguard
    violation, not silently kept. `set_option` is kept only for resource
    limits (maxRecDepth, maxHeartbeats, synthInstance.*).

    If your code does NOT include the main theorem (e.g. `#check`, `example`,
    `#print`, `#eval`, helper-lemma prototypes), the system compiles the
    snippet as-given and returns raw feedback INCLUDING the output of any
    `#eval`/`#check`/`#print`. This is exploration only -- it cannot register
    a solve, so resubmit with the main theorem once you have a full proof.
    """
    logger.info(f"lean_compile mode={mode!r} code={code[:120]!r}...")
    if mode == "blueprint":
        result = await _compile_blueprint(code, target_name, target_signature)
    elif mode == "node":
        result = await _compile_node(code, target_name, target_signature, target_neg_signature, prefix, prelude)
    else:
        result = await _compile_explore(code)
    # MCP tools return text content; the bridge needs the structured fields
    # (ok/solve/graph/...) too, so ship the full result as a JSON string the
    # bridge parses, with `report` as the human-readable summary up top.
    return json.dumps(result, ensure_ascii=False)


async def main_serve():
    logger.info("Booting Leak XII (lean_compile gateway)…")
    asyncio.create_task(pool.boot())

    http_app = mcp.sse_app()
    http_app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*", "mcp-protocol-version", "mcp-session-id"],
        expose_headers=["mcp-session-id"],
    )
    logger.info("Serving Leak XII MCP (SSE) on 0.0.0.0:7860")
    config = uvicorn.Config(
        http_app, host="0.0.0.0", port=7860,
        proxy_headers=True, forwarded_allow_ips="*",
        log_level="info", loop="asyncio",
    )
    await uvicorn.Server(config).serve()


if __name__ == "__main__":
    asyncio.run(main_serve())
