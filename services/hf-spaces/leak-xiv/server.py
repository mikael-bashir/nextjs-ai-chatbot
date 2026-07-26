"""Leak XIV — the assembly verifier (certification gate).

Real FastMCP server (matching Leak-I/II's own wrapper architecture exactly:
mcp.server.fastmcp.FastMCP, @mcp.tool(), served via mcp.sse_app() + uvicorn
on 7860) rather than a bespoke REST API. All certification logic below is
unchanged from the REST version — only the outer interface changed.

The Goedel-Architect endgame: when every blueprint node is solved, the
orchestrator splices the recorded proof bodies into the dependency graph and
sends the assembled, attribute-stripped Lean file here. XIV compiles it
end-to-end against a warm Mathlib environment and certifies it only if it is
error-free AND sorry-free AND axiom/native_decide-free AND actually proves
the targeted theorem signature.

Like Leak IV in the original stack, this service is the sole authority on
success — the orchestrator's bookkeeping, the per-node solves, and the
model's prose are all advisory until this gate passes. The daemon warms
lazily on first call (POOL_SIZE=1, LAZY=1), since assembly happens once per
solved blueprint.
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
logger = logging.getLogger("leak-xiv")

VERIFY_TIMEOUT_S = float(os.environ.get("VERIFY_TIMEOUT_S", "600"))

mcp = FastMCP(
    "Leak-XIV",
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=False,
    ),
)

pool = ReplPool()


@mcp.tool()
async def verify_full_script(code: str, target_name: str = "", target_signature: str = "") -> str:
    """
    Compile a FULLY ASSEMBLED Lean 4 file end-to-end and certify it. This is
    the final gate: certification succeeds only if the file has no compiler
    errors, no `sorry` anywhere, no `axiom`/`native_decide`, and (when
    target_name/target_signature are given) actually declares that exact
    theorem. This is the ONLY way a proof gets certified -- nothing else in
    the pipeline can register success.
    """
    logger.info(f"verify_full_script target={target_name!r} len={len(code)}")
    stripped = bp.strip_comments(code)

    violations: list[str] = []
    fb = bp.FORBIDDEN.search(stripped)
    if fb:
        violations.append(f"forbidden construct '{fb.group(1)}'")
    if re.search(r"(?<![A-Za-z0-9_'])sorry(_using)?(?![A-Za-z0-9_'])", stripped):
        violations.append("assembled proof still contains 'sorry'")
    if target_name and target_signature:
        chunks, spans = bp.split_decls(code)
        decls = [d for d in (bp.parse_decl(c, s) for c, s in zip(chunks, spans)) if d]
        main = next((d for d in decls if d.name == target_name), None)
        if main is None:
            violations.append(f"assembled file does not declare the target '{target_name}'")
        elif bp.normalize_sig(main.signature) != bp.normalize_sig(target_signature):
            violations.append("target theorem signature drifted during assembly")
    if violations:
        result = {"ok": False, "phase": "precheck", "violations": violations,
                   "report": "Certification REFUSED:\n" + "\n".join(f"  - {x}" for x in violations)}
        return json.dumps(result, ensure_ascii=False)

    body = "\n".join(ln for ln in code.split("\n") if not re.match(r"^\s*import\s+\S+", ln))
    try:
        resp = await pool.run(body, timeout=VERIFY_TIMEOUT_S)
    except RuntimeError as e:
        return json.dumps({"ok": False, "phase": "compile", "report": f"Verifier backend error: {e}"})

    errors, sorry_warns = [], []
    for m in resp.get("messages", []) or []:
        if m.get("severity") == "error":
            errors.append({"line": (m.get("pos") or {}).get("line"), "msg": m.get("data", "")})
        elif "declaration uses 'sorry'" in (m.get("data") or ""):
            sorry_warns.append(m.get("data"))
    if errors:
        result = {"ok": False, "phase": "compile", "errors": errors,
                   "report": "Certification FAILED — Lean errors:\n" +
                             "\n".join(f"  line {e['line']}: {e['msg']}" for e in errors[:30])}
        return json.dumps(result, ensure_ascii=False)
    if sorry_warns or (resp.get("sorries") or []):
        result = {"ok": False, "phase": "compile",
                  "report": "Certification FAILED — the assembled proof still elaborates a sorry."}
        return json.dumps(result, ensure_ascii=False)

    result = {"ok": True, "phase": "certified",
              "report": "CERTIFIED: assembled proof compiles clean — no errors, no sorry.",
              "certificate": code}
    return json.dumps(result, ensure_ascii=False)


async def main_serve():
    logger.info("Booting Leak XIV (assembly verifier)…")
    asyncio.create_task(pool.boot())

    http_app = mcp.sse_app()
    http_app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*", "mcp-protocol-version", "mcp-session-id"],
        expose_headers=["mcp-session-id"],
    )
    logger.info("Serving Leak XIV MCP (SSE) on 0.0.0.0:7860")
    config = uvicorn.Config(
        http_app, host="0.0.0.0", port=7860,
        proxy_headers=True, forwarded_allow_ips="*",
        log_level="info", loop="asyncio",
    )
    await uvicorn.Server(config).serve()


if __name__ == "__main__":
    asyncio.run(main_serve())
