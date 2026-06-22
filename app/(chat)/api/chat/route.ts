import { auth } from "@/app/(auth)/auth"
import { deleteChatById, deductCredits, getChatById, getOrCreateCreditBalance, saveChat, saveMessages } from "@/lib/db/queries"
import { checkRateLimit } from "@/lib/ratelimit"
import { generateUUID, getMostRecentUserMessage } from "@/lib/utils"
import { generateTitleFromUserMessage } from "../../actions"
import { calculateCreditCost, seedPricingIfEmpty } from "@/lib/pricing"
import { isPaidModel } from "@/lib/ai/models"

export const maxDuration = 100000000000000


interface UIMessage {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  createdAt?: Date
  parts: Array<{ type: "text"; text: string }>
  experimental_attachments?: Array<any>
}

// Normalize UI messages (which may carry content in `parts`) into core messages with string content
function toCoreMessages(messages: Array<UIMessage>) {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      // Prefer explicit string content; otherwise, extract any text parts
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

// Proxies the Python SSE stream to the client.
// Intercepts text_response and usage events to persist the assistant message
// and deduct token-based credits once the stream closes.
function proxyAgentStream({
  agentRes,
  chatId,
  userId,
  assistantMessageId,
  modelId,
  paid,
}: {
  agentRes: Response
  chatId: string
  userId: string
  assistantMessageId: string
  modelId: string
  paid: boolean
}): Response {
  let finalContent = ""
  let usageData: { tokensInput: number; tokensOutput: number; model: string } | null = null

  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = new TextDecoder().decode(chunk)
      for (const line of text.split("\n")) {
        if (line.startsWith("data: ")) {
          try {
            const event = JSON.parse(line.slice(6))
            if (event.type === "text_response" && event.text) {
              finalContent += event.text
            }
            if (event.type === "usage" && event.data) {
              usageData = JSON.parse(event.data)
            }
          } catch {
            // SSE comment / keep-alive lines — ignore
          }
        }
      }
      controller.enqueue(chunk)
    },
    flush() {
      if (finalContent) {
        saveMessages({
          messages: [{
            id: assistantMessageId,
            chatId,
            role: "assistant",
            parts: [{ type: "text", text: finalContent }],
            attachments: [],
            createdAt: new Date(),
          }],
        }).catch((err) => console.error("[POST /api/chat] Failed to save assistant message:", err))
      }

      if (paid) {
        // Token-based credit deduction with full audit trail
        const resolvedModel = usageData?.model ?? modelId
        const tokensIn = usageData?.tokensInput ?? 0
        const tokensOut = usageData?.tokensOutput ?? 0

        if (tokensIn > 0 || tokensOut > 0) {
          calculateCreditCost({ modelId: resolvedModel, tokensInput: tokensIn, tokensOutput: tokensOut })
            .then(({ credits, rawCostGbp, markupFactor }) => {
              if (credits <= 0) return
              return deductCredits({
                userId,
                amount: credits,
                description: `${resolvedModel} — ${tokensIn} in / ${tokensOut} out tokens`,
                tokensInput: tokensIn,
                tokensOutput: tokensOut,
                modelId: resolvedModel,
                rawCostGbp,
                markupFactor,
              })
            })
            .catch((err) => console.error("[POST /api/chat] Failed to deduct token-based credits:", err))
        } else {
          deductCredits({
            userId,
            amount: 0.001,
            description: `${modelId} — token usage unavailable`,
            modelId,
          }).catch((err) => console.error("[POST /api/chat] Failed to deduct fallback credits:", err))
        }
      }
    },
  })

  agentRes.body!.pipeTo(stream.writable)

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
}

export async function POST(request: Request) {
  try {
    const {
      id,
      messages,
      selectedChatModel,
    }: {
      id: string
      messages: Array<UIMessage>
      selectedChatModel: string
    } = await request.json()


    const session = await auth()

    if (!session?.user?.id) {
      console.warn("[POST /api/chat] Unauthorized access attempt")
      return new Response("Unauthorized", { status: 401 })
    }

    const userId = session.user.id

    const paid = isPaidModel(selectedChatModel)

    if (paid) {
      // Paid model: enforce minimum balance, skip rate limit
      const balance = await getOrCreateCreditBalance({ userId })
      if (balance < 0.5) {
        return Response.json(
          { error: "Insufficient credits", required: 0.5, balance },
          { status: 402 },
        )
      }
    } else {
      // Free model: enforce rate limit, no credit check
      const rateLimit = await checkRateLimit({ userId })
      if (!rateLimit.allowed) {
        return Response.json(
          { error: "Rate limit exceeded", resetAt: rateLimit.resetAt },
          { status: 429 },
        )
      }
    }

    const userMessage = getMostRecentUserMessage(messages)

    if (!userMessage) {
      console.warn("[POST /api/chat] No user message found in messages", { messages })
      return new Response("No user message found", { status: 400 })
    }

    const chat = await getChatById({ id })

    if (!chat) {
      const title = await generateTitleFromUserMessage({
        message: userMessage,
      })
      await saveChat({ id, userId, title })
    } else {
      if (chat.userId !== userId) {
        console.warn("[POST /api/chat] Forbidden: user does not own chat", {
          chatUserId: chat.userId,
          sessionUserId: session.user.id,
        })
        return new Response("Forbidden", { status: 403 })
      }
    }

    await saveMessages({
      messages: [
        {
          chatId: id,
          id: userMessage.id,
          role: "user",
          parts: userMessage.parts,
          attachments: userMessage.experimental_attachments ?? [],
          createdAt: new Date(),
        },
      ],
    })


    try {
      const agentRes = await fetch("http://localhost:5328/api/chat/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: toCoreMessages(messages),
          id,
          model: selectedChatModel,
        }),
      })

      if (!agentRes.ok) {
        throw new Error(`Agent backend error: ${agentRes.status}`)
      }

      if (paid) seedPricingIfEmpty().catch(() => {})

      return proxyAgentStream({
        agentRes,
        chatId: id,
        userId,
        assistantMessageId: generateUUID(),
        modelId: selectedChatModel,
        paid,
      })
    } catch (error) {
      console.error("[POST /api/chat] Agent error:", error)
      return new Response("Error with agent orchestration", { status: 500 })
    }
  } catch (error) {
    console.error("[POST /api/chat] Caught error in POST handler", error)
    return new Response("An error occurred while processing your request!", {
      status: 500,
    })
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url)
  const id = searchParams.get("id")

  if (!id) {
    return new Response("Not Found", { status: 404 })
  }

  const session = await auth()

  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 })
  }

  try {
    const chat = await getChatById({ id })

    if (chat.userId !== session.user.id) {
      return new Response("Forbidden", { status: 403 })
    }

    const deletedChat = await deleteChatById({ id })

    return Response.json(deletedChat, { status: 200 })
  } catch (error) {
    return new Response("An error occurred while processing your request!", {
      status: 500,
    })
  }
}
