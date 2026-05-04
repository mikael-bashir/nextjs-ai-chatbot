import { auth } from "@/app/(auth)/auth"
import { deleteChatById, getChatById, saveChat, saveMessages } from "@/lib/db/queries"
import { generateUUID, getMostRecentUserMessage } from "@/lib/utils"
import { generateTitleFromUserMessage } from "../../actions"

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

async function callGeminiBackend(messages: Array<UIMessage>) {
  try {
    const response = await fetch("http://localhost:5328/api/chat/gemini", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: toCoreMessages(messages),
      }),
    })

    if (!response.ok) {
      throw new Error(`Gemini backend error: ${response.status}`)
    }

    const data = await response.json()
    return data
  } catch (error) {
    console.error("Error calling Gemini backend:", error)
    throw error
  }
}

function createCustomStreamResponse(content: string, messageId: string) {
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      // Send message annotation
      const annotation = `data: ${JSON.stringify({ type: "message-annotation", messageIdFromServer: messageId })}\n\n`
      controller.enqueue(encoder.encode(annotation))

      // Send text content
      const textDelta = `data: ${JSON.stringify({ type: "text-delta", content })}\n\n`
      controller.enqueue(encoder.encode(textDelta))

      // Send finish signal
      const finish = `data: ${JSON.stringify({ type: "finish", content: "" })}\n\n`
      controller.enqueue(encoder.encode(finish))

      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
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

    console.log("THIS IS THE MESSAGE SENT:", messages)
    console.log("[POST /api/chat] Incoming request", {
      id,
      selectedChatModel,
      messagesCount: messages.length,
    })

    const session = await auth()

    if (!session?.user?.id) {
      console.warn("[POST /api/chat] Unauthorized access attempt")
      return new Response("Unauthorized", { status: 401 })
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
      await saveChat({ id, userId: session.user.id, title })
      console.log("[POST /api/chat] Created new chat", { id, userId: session.user.id, title })
    } else {
      if (chat.userId !== session.user.id) {
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
      const geminiResponse = await callGeminiBackend(messages)
      const assistantMessageId = generateUUID()
      const content = geminiResponse.response || ""

      // Save the assistant message to database
      saveMessages({
        messages: [
          {
            id: assistantMessageId,
            chatId: id,
            role: "assistant",
            parts: [{ type: "text", text: content }],
            attachments: [],
            createdAt: new Date(),
          },
        ],
      }).catch((error) => {
        console.error("[POST /api/chat] Failed to save Gemini message:", error)
      })

      return createCustomStreamResponse(content, assistantMessageId)
    } catch (error) {
      console.error("[POST /api/chat] Gemini error:", error)
      return new Response("Error with Gemini orchestration", { status: 500 })
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
