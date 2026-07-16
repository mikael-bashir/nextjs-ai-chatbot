import type { NextRequest } from "next/server"
import { verifyRelayToken } from "@/lib/local-claude/relay-token"
import { registerBridge } from "@/lib/local-claude/relay-registry"

// The user's bridge dials in here (SSE) to receive completion requests. Auth is
// the relay token (not a session cookie), so this path is allowlisted in
// auth.config.ts and verified here.
export async function GET(request: NextRequest) {
  const token = new URL(request.url).searchParams.get("token")
  const userId = verifyRelayToken(token)
  if (!userId) return new Response("invalid_relay_token", { status: 401 })

  const encoder = new TextEncoder()
  let unregister: () => void = () => {}
  let ping: ReturnType<typeof setInterval> | undefined

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
          /* controller closed */
        }
      }

      send("ready", { ok: true })
      unregister = registerBridge(userId, send)
      ping = setInterval(() => send("ping", { t: Date.now() }), 15000)

      // Clean up when the bridge disconnects.
      request.signal.addEventListener("abort", () => {
        if (ping) clearInterval(ping)
        unregister()
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      })
    },
    cancel() {
      if (ping) clearInterval(ping)
      unregister()
    },
  })

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  })
}
