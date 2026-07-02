import { auth } from "@/app/(auth)/auth"
import { getChatById, saveChat, saveMessages, deductCredits, getOrCreateCreditBalance } from "@/lib/db/queries"
import { generateUUID, getMostRecentUserMessage } from "@/lib/utils"
import { generateTitleFromUserMessage } from "@/app/(chat)/actions"
import { checkRateLimit } from "@/lib/ratelimit"
import { calculateCreditCost, seedPricingIfEmpty } from "@/lib/pricing"
import { isPaidModel } from "@/lib/ai/models"

export const maxDuration = 1000000000

const PYTHON_BACKEND = process.env.PYTHON_BACKEND_URL ?? 'http://localhost:5328'

interface UIMessage {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  createdAt?: Date
  parts: Array<{ type: "text"; text: string }>
  experimental_attachments?: Array<any>
}

function toCoreMessages(messages: Array<UIMessage>) {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const textFromParts = Array.isArray((m as any).parts)
        ? (m as any).parts
            .filter((p: any) => p && p.type === "text" && typeof p.text === "string")
            .map((p: any) => p.text)
            .join("")
        : ""
      const content =
        typeof (m as any).content === "string" && (m as any).content.length > 0 ? (m as any).content : textFromParts
      return { role: m.role as "user" | "assistant", content }
    })
}

async function callAgentBackend(
  messages: Array<UIMessage>,
  model: string,
  id: string,
  userId: string,
  signal: AbortSignal,
) {
  const response = await fetch(`${PYTHON_BACKEND}/api/chat/agent`, {
    method: "POST",
    signal, // propagate client disconnect → kills Python task immediately
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id,
      user_id: userId,
      messages: toCoreMessages(messages),
      model,
    }),
  })

  if (!response.ok) throw new Error(`Agent backend error: ${response.status}`)
  return response
}

export async function POST(request: Request) {
  try {
    const { id, messages, selectedChatModel } = await request.json()
    const session = await auth()

    if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })

    const userId = session.user.id
    const paid = isPaidModel(selectedChatModel)

    // --- Credit / rate-limit guard ---
    if (paid) {
      const balance = await getOrCreateCreditBalance({ userId })
      if (balance < 0.5) {
        return Response.json(
          { error: "Insufficient credits", required: 0.5, balance },
          { status: 402 },
        )
      }
    } else {
      const rateLimit = await checkRateLimit({ userId })
      if (!rateLimit.allowed) {
        return Response.json(
          { error: "Rate limit exceeded", resetAt: rateLimit.resetAt },
          { status: 429 },
        )
      }
    }

    const userMessage = getMostRecentUserMessage(messages)
    if (!userMessage) return new Response("No user message found", { status: 400 })

    const chat = await getChatById({ id })

    if (!chat) {
      const title = await generateTitleFromUserMessage({ message: userMessage })
      await saveChat({ id, userId, title })
    } else if (chat.userId !== userId) {
      return new Response("Forbidden", { status: 403 })
    }

    await saveMessages({
      messages: [{
        chatId: id,
        id: userMessage.id,
        role: "user",
        parts: userMessage.parts,
        attachments: userMessage.experimental_attachments ?? [],
        createdAt: new Date(),
      }],
    })

    if (paid) seedPricingIfEmpty().catch(() => {})

    try {
      const agentResponse = await callAgentBackend(
        messages,
        selectedChatModel,
        id,
        userId,
        request.signal, // tied to client connection
      )
      const assistantMessageId = generateUUID()

      const encoder = new TextEncoder()
      const decoder = new TextDecoder()

      let streamFinishedGracefully = false

      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "message-annotation", messageIdFromServer: assistantMessageId })}\n\n`,
            ),
          )

          const reader = agentResponse.body?.getReader()
          if (!reader) {
            controller.close()
            return
          }

          // When the client disconnects, cancel the Python reader immediately.
          // The Python task is already being killed via the fetch signal above, but
          // cancelling the reader also unblocks any pending reader.read() awaits.
          const abortHandler = () => {
            reader.cancel().catch(() => {})
          }
          request.signal.addEventListener("abort", abortHandler, { once: true })

          let buffer = ""
          let finalContent = ""
          let usageTokens: { tokensInput: number; tokensOutput: number; model: string } | null = null

          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break

              buffer += decoder.decode(value, { stream: true })
              const parts = buffer.split("\n\n")
              buffer = parts.pop() || ""

              for (const event of parts) {
                if (event.startsWith("data: ")) {
                  try {
                    const data = JSON.parse(event.replace("data: ", ""))

                    if (["status", "tool_intent", "tool_result"].includes(data.type)) {
                      controller.enqueue(
                        encoder.encode(
                          `data: ${JSON.stringify({
                            type: "message-annotation",
                            subtype: data.type,
                            thought: data.message,
                            tool: data.tool,
                            input: data.input,
                            output: data.output,
                            metrics: data.metrics,
                          })}\n\n`,
                        ),
                      )
                    }

                    if (data.type === "text-delta") {
                      finalContent = data.content
                      controller.enqueue(
                        encoder.encode(`data: ${JSON.stringify({ type: "text-delta", content: data.content })}\n\n`),
                      )
                    }

                    if (data.type === "text_response") {
                      finalContent = data.text
                      controller.enqueue(
                        encoder.encode(`data: ${JSON.stringify({ type: "text-delta", content: finalContent })}\n\n`),
                      )
                    }

                    if (data.type === "error") {
                      finalContent += `\n\n❌ **Backend Error:** ${data.message}`
                      controller.enqueue(
                        encoder.encode(`data: ${JSON.stringify({ type: "text-delta", content: finalContent })}\n\n`),
                      )
                    }

                    // Intercept token usage for credit deduction
                    if (data.type === "usage" && data.data) {
                      try {
                        usageTokens = JSON.parse(data.data)
                      } catch {}
                    }

                    if (data.type === "done") {
                      controller.enqueue(
                        encoder.encode(`data: ${JSON.stringify({ type: "finish", content: "" })}\n\n`),
                      )
                      streamFinishedGracefully = true
                    }
                  } catch (_e) {
                    // Silently ignore incomplete JSON
                  }
                } else if (event.startsWith(":")) {
                  controller.enqueue(encoder.encode(`${event}\n\n`))
                }
              }
            }
          } catch (err: any) {
            // AbortError = client disconnected; anything else is unexpected
            if (err?.name !== "AbortError") {
              console.error("[canary] reader error:", err)
            }
          } finally {
            request.signal.removeEventListener("abort", abortHandler)

            if (!streamFinishedGracefully) {
              try { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "finish", content: "" })}\n\n`)) } catch {}
            }

            // Save assistant message only on graceful completion
            if (streamFinishedGracefully && finalContent) {
              saveMessages({
                messages: [{
                  id: assistantMessageId,
                  chatId: id,
                  role: "assistant",
                  parts: [{ type: "text", text: finalContent }],
                  attachments: [],
                  createdAt: new Date(),
                }],
              }).catch((error) => console.error("Failed to save message:", error))

              // Deduct credits only for paid models and only on graceful completion
              if (paid && usageTokens) {
                const { tokensInput, tokensOutput, model: resolvedModel } = usageTokens
                if (tokensInput > 0 || tokensOutput > 0) {
                  calculateCreditCost({ modelId: resolvedModel, tokensInput, tokensOutput })
                    .then(({ credits, rawCostGbp, markupFactor }) => {
                      if (credits <= 0) return
                      return deductCredits({
                        userId,
                        amount: credits,
                        description: `${resolvedModel} — ${tokensInput} in / ${tokensOutput} out tokens`,
                        tokensInput,
                        tokensOutput,
                        modelId: resolvedModel,
                        rawCostGbp,
                        markupFactor,
                      })
                    })
                    .catch((err) => console.error("[canary] Failed to deduct credits:", err))
                }
              }
            } else if (!streamFinishedGracefully) {
              console.log(`[canary] Stream aborted for chat ${id} — no credits deducted`)
            }

            try { controller.close() } catch {}
          }
        },
      })

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      })

    } catch (error: any) {
      if (error?.name === "AbortError") {
        // Client disconnected before we even got a response from Python — that's fine
        return new Response(null, { status: 499 })
      }
      console.error("Agent error:", error)
      return new Response("Error with Agent orchestration", { status: 500 })
    }
  } catch (error) {
    return new Response("Server Error", { status: 500 })
  }
}
