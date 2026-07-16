import type { NextRequest } from "next/server"
import { randomUUID } from "node:crypto"
import { dispatchToBridge, isBridgeConnected } from "@/lib/local-claude/relay-registry"

// OpenAI-compatible Chat Completions endpoint. LiteLLM (in the Python tree)
// calls this as an `openai/` provider with `api_base` pointing here. We route
// the request to the requesting user's connected bridge and return the result.
//
// Routing key: OpenAI's `user` field (LiteLLM forwards `user=` verbatim), set
// by the tree to the user_id. This path is allowlisted in auth.config.ts and is
// intended for internal calls from the backend.

interface OpenAIMessage {
  role: string
  content?: unknown
  tool_calls?: unknown
}

interface BridgeCompletion {
  content?: string
  tool_calls?: {
    id?: string
    type?: string
    function?: { name?: string; arguments?: string }
  }[]
  finish_reason?: string
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return openaiError("invalid_request", "malformed body", 400)
  }

  // Routing key: prefer the x-relay-user header (LiteLLM forwards extra_headers
  // reliably); fall back to the OpenAI `user` body field.
  const userId: string | undefined = request.headers.get("x-relay-user") ?? body.user
  const model: string = body.model || "claude-local"
  const messages: OpenAIMessage[] = Array.isArray(body.messages) ? body.messages : []
  const tools = Array.isArray(body.tools) ? body.tools : []
  const wantStream = body.stream === true
  // The tree's timeout headroom; keep generous for long proofs.
  const timeoutMs = 1800000

  if (!userId) {
    return openaiError("no_user", "request is missing a `user` routing key", 400)
  }
  if (!isBridgeConnected(userId)) {
    // 503 → LiteLLM raises → the tree's try/except (or router fallback) can
    // recover, e.g. fall back to a hosted model.
    return openaiError("no_provider", "user's local Claude bridge is not connected", 503)
  }

  let completion: BridgeCompletion
  try {
    completion = (await dispatchToBridge(userId, randomUUID(), { model, messages, tools }, timeoutMs)) as BridgeCompletion
  } catch (error) {
    const reason = error instanceof Error ? error.message : "bridge_error"
    return openaiError("bridge_error", reason, 502)
  }

  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const usage = {
    prompt_tokens: completion.usage?.prompt_tokens ?? 0,
    completion_tokens: completion.usage?.completion_tokens ?? 0,
    total_tokens:
      (completion.usage?.prompt_tokens ?? 0) + (completion.usage?.completion_tokens ?? 0),
  }
  const hasToolCalls = Array.isArray(completion.tool_calls) && completion.tool_calls.length > 0
  const finishReason = completion.finish_reason ?? (hasToolCalls ? "tool_calls" : "stop")

  if (!wantStream) {
    return Response.json({
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: completion.content ?? "",
            ...(hasToolCalls ? { tool_calls: completion.tool_calls } : {}),
          },
          finish_reason: finishReason,
        },
      ],
      usage,
    })
  }

  // Stream translation → the exact shape chat_model iterates:
  // choices[0].delta.content / .tool_calls, and usage on the final chunk.
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) => {
        const data = { id, object: "chat.completion.chunk", created, model, choices, ...extra }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      }

      chunk([{ index: 0, delta: { role: "assistant" }, finish_reason: null }])

      if (completion.content) {
        chunk([{ index: 0, delta: { content: completion.content }, finish_reason: null }])
      }

      if (hasToolCalls) {
        completion.tool_calls?.forEach((tc, i) => {
          chunk([
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: i,
                    id: tc.id ?? `call_${randomUUID().slice(0, 8)}`,
                    type: "function",
                    function: {
                      name: tc.function?.name ?? "",
                      arguments: tc.function?.arguments ?? "{}",
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ])
        })
      }

      // Final chunk carries both finish_reason and usage so the tree's
      // `chunk.choices[0].delta` and `chunk.usage` reads both succeed.
      chunk([{ index: 0, delta: {}, finish_reason: finishReason }], { usage })
      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      controller.close()
    },
  })

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" },
  })
}

function openaiError(code: string, message: string, status: number) {
  return Response.json({ error: { message, type: code, code } }, { status })
}
