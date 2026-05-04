import { auth } from "@/app/(auth)/auth"
import { deleteChatById, getChatById, saveChat, saveMessages } from "@/lib/db/queries"
import { generateUUID, getMostRecentUserMessage } from "@/lib/utils"
import { generateTitleFromUserMessage } from "@/app/(chat)/actions"

export const maxDuration = 1000000000

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

// 1. Return the raw fetch Response so we can tap into its stream
async function callAgentBackend(messages: Array<UIMessage>, model: string, id: string) {
  const response = await fetch("http://localhost:5328/api/chat/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id,
      messages: toCoreMessages(messages),
      model: model 
    })
  })

  if (!response.ok) throw new Error(`Agent backend error: ${response.status}`)
  return response 
}

export async function POST(request: Request) {
  try {
    const { id, messages, selectedChatModel } = await request.json()
    const session = await auth()

    if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })

    const userMessage = getMostRecentUserMessage(messages)
    if (!userMessage) return new Response("No user message found", { status: 400 })

    const chat = await getChatById({ id })

    if (!chat) {
      const title = await generateTitleFromUserMessage({ message: userMessage })
      await saveChat({ id, userId: session.user.id, title })
    } else if (chat.userId !== session.user.id) {
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

    try {
      // Fetch the live stream from Python
      const agentResponse = await callAgentBackend(messages, selectedChatModel, id)
      const assistantMessageId = generateUUID()
      
      const encoder = new TextEncoder()
      const decoder = new TextDecoder()

      let streamFinishedGracefully = false;

      // 2. Build a proxy stream that translates Python SSE into Vercel AI SDK SSE
      const stream = new ReadableStream({
        async start(controller) {
          // Lock in the message ID on the frontend
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "message-annotation", messageIdFromServer: assistantMessageId })}\n\n`))

          const reader = agentResponse.body?.getReader()
          if (!reader) {
            controller.close()
            return
          }

          let buffer = ""
          let finalContent = ""

          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break

              // Decode the chunk and add to our buffer
              buffer += decoder.decode(value, { stream: true })
              const parts = buffer.split("\n\n")
              
              // Keep the last part in the buffer, as it might be an incomplete JSON string
              buffer = parts.pop() || ""

              for (const event of parts) {
                console.log(`🚨 [NEXT PROXY] Raw event from Python:`, event.substring(0, 100))
                if (event.startsWith("data: ")) {
                  try {
                    const data = JSON.parse(event.replace("data: ", ""))

                    // If it's a thought/metric, send it as a message annotation!
                    if (["status", "tool_intent", "tool_result"].includes(data.type)) {
                      const annotation = {
                        type: "message-annotation",
                        thought: data.message,
                        metrics: data.metrics
                      }
                      controller.enqueue(encoder.encode(`data: ${JSON.stringify(annotation)}\n\n`))
                    }

                    if (data.type === "text-delta") {
                      finalContent = data.content // Keep track so we can save to DB at the end
                      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "text-delta", content: data.content })}\n\n`))
                    }
                    
                    // If it's text, pipe it as a delta
                    if (data.type === "text_response") {
                      finalContent = data.text
                      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "text-delta", content: finalContent })}\n\n`))
                    }

                    if (data.type === "error") {
                      finalContent += `\n\n❌ **Backend Error:** ${data.message}`
                      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "text-delta", content: finalContent })}\n\n`))
                    }

                    if (data.type === "done") {
                      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "finish", content: "" })}\n\n`))
                      streamFinishedGracefully = true;
                    }
                  } catch (e) {
                    // Silently ignore incomplete JSON parses from mangled chunks
                  }
                } else if (event.startsWith(":")) {
                  // Forward the invisible keep-alive comment!
                  controller.enqueue(encoder.encode(`${event}\n\n`))
                }
              }
            }
          } finally {
            console.log(`🚨 [NEXT PROXY] Stream closed. Final content length: ${finalContent.length}`)

            if (!streamFinishedGracefully) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "finish", content: "" })}\n\n`))
            }
            // 3. Once the stream completely finishes, save the final text to the database
            if (finalContent) {
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
            }
            console.log(`🚨 [NEXT PROXY] messages saved, controller closing!`)
            controller.close()
          }
        }
      })

      // Return the proxy stream immediately. No more timeouts!
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no"
        },
      })
      
    } catch (error) {
      console.error("Agent error:", error)
      return new Response("Error with Agent orchestration", { status: 500 })
    }
  } catch (error) {
    return new Response("Server Error", { status: 500 })
  }
}