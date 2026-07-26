"""Leak XIV — the assembly verifier (certification gate).

The Goedel-Architect endgame: when every blueprint node is solved, the
orchestrator splices the recorded proof bodies into the dependency graph and
sends the assembled, attribute-stripped Lean file here. XIV compiles it
end-to-end against a warm Mathlib environment and certifies it only if it is
error-free AND sorry-free AND axiom/native_decide-free AND actually proves
the targeted theorem signature.

Like Leak IV in the original stack, this service is the sole authority on
success — the orchestrator's bookkeeping, the per-node solves, and the
model's prose are all advisory until this gate passes. Runs LAZY by default:
the daemon warms on first use and is reaped after idling, since assembly
happens once per solved blueprint.
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

VERIFY_TIMEOUT_S = float(os.environ.get("VERIFY_TIMEOUT_S", "600"))

app = FastAPI(title="Leak XIV", version="1.0")

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
    return {"service": "leak-xiv", **pool.status()}


class VerifyReq(BaseModel):
    code: str                     # fully assembled final Lean file
    targetName: str | None = None
    targetSignature: str | None = None


@app.post("/verify")
async def verify(req: VerifyReq):
    stripped = bp.strip_comments(req.code)

    violations: list[str] = []
    fb = bp.FORBIDDEN.search(stripped)
    if fb:
        violations.append(f"forbidden construct '{fb.group(1)}'")
    if re.search(r"(?<![A-Za-z0-9_'])sorry(_using)?(?![A-Za-z0-9_'])", stripped):
        violations.append("assembled proof still contains 'sorry'")
    if req.targetName and req.targetSignature:
        chunks, spans = bp.split_decls(req.code)
        decls = [d for d in (bp.parse_decl(c, s) for c, s in zip(chunks, spans)) if d]
        main = next((d for d in decls if d.name == req.targetName), None)
        if main is None:
            violations.append(f"assembled file does not declare the target '{req.targetName}'")
        elif bp.normalize_sig(main.signature) != bp.normalize_sig(req.targetSignature):
            violations.append("target theorem signature drifted during assembly")
    if violations:
        return {"ok": False, "phase": "precheck", "violations": violations,
                "report": "Certification REFUSED:\n" + "\n".join(f"  - {x}" for x in violations)}

    body = "\n".join(ln for ln in req.code.split("\n")
                     if not re.match(r"^\s*import\s+\S+", ln))
    try:
        resp = await pool.run(body, timeout=VERIFY_TIMEOUT_S)
    except RuntimeError as e:
        return {"ok": False, "phase": "compile", "report": f"Verifier backend error: {e}"}

    errors, sorry_warns = [], []
    for m in resp.get("messages", []) or []:
        if m.get("severity") == "error":
            errors.append({"line": (m.get("pos") or {}).get("line"), "msg": m.get("data", "")})
        elif "declaration uses 'sorry'" in (m.get("data") or ""):
            sorry_warns.append(m.get("data"))
    if errors:
        return {"ok": False, "phase": "compile", "errors": errors,
                "report": "Certification FAILED — Lean errors:\n" +
                          "\n".join(f"  line {e['line']}: {e['msg']}" for e in errors[:30])}
    if sorry_warns or (resp.get("sorries") or []):
        return {"ok": False, "phase": "compile",
                "report": "Certification FAILED — the assembled proof still elaborates a sorry."}

    return {"ok": True, "phase": "certified",
            "report": "CERTIFIED: assembled proof compiles clean — no errors, no sorry.",
            "certificate": req.code}
