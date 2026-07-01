import type { NextRequest } from "next/server"
import { verifyRelayToken } from "@/lib/local-claude/relay-token"
import { resolveBridgeResult, failBridgeResult } from "@/lib/local-claude/relay-registry"

// The bridge POSTs a completion result back here, keyed by requestId. Auth is
// the relay token (allowlisted in auth.config.ts).
export async function POST(request: NextRequest) {
  const token =
    request.headers.get("x-relay-token") ||
    new URL(request.url).searchParams.get("token")
  const userId = verifyRelayToken(token)
  if (!userId) return new Response("invalid_relay_token", { status: 401 })

  const body = await request.json().catch(() => null)
  const requestId = body?.requestId
  if (typeof requestId !== "string") {
    return new Response("requestId required", { status: 400 })
  }

  if (body.error) {
    failBridgeResult(requestId, String(body.error))
  } else {
    resolveBridgeResult(requestId, body.response)
  }

  return Response.json({ ok: true })
}
