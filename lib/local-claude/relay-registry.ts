import "server-only"

// In-process registry connecting the OpenAI relay endpoint to the user bridges
// that dialed in. Single-container deployment, so a module-level map is the
// whole coordination layer — no external broker needed.
//
// Flow:
//   bridge  --SSE subscribe-->  registerBridge(userId, send)
//   LiteLLM --POST /v1/chat-->  dispatchToBridge(userId, ...) --send--> bridge
//   bridge  --POST result --->  resolveBridgeResult(requestId, ...)

type BridgeSend = (event: string, data: unknown) => void

interface Deferred {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

const bridges = new Map<string, BridgeSend>()
const pending = new Map<string, Deferred>()

export function registerBridge(userId: string, send: BridgeSend): () => void {
  bridges.set(userId, send)
  return () => {
    if (bridges.get(userId) === send) bridges.delete(userId)
  }
}

export function isBridgeConnected(userId: string): boolean {
  return bridges.has(userId)
}

// Hand a request to the user's bridge and wait for its POSTed result.
export function dispatchToBridge(
  userId: string,
  requestId: string,
  payload: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const send = bridges.get(userId)
  if (!send) return Promise.reject(new Error("no_bridge_connected"))

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error("bridge_timeout"))
    }, timeoutMs)

    pending.set(requestId, {
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    })

    send("request", { requestId, payload })
  })
}

export function resolveBridgeResult(requestId: string, result: unknown): boolean {
  const deferred = pending.get(requestId)
  if (!deferred) return false
  pending.delete(requestId)
  deferred.resolve(result)
  return true
}

export function failBridgeResult(requestId: string, error: string): boolean {
  const deferred = pending.get(requestId)
  if (!deferred) return false
  pending.delete(requestId)
  deferred.reject(new Error(error))
  return true
}
