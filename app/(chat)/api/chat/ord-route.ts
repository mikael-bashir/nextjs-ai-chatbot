// import { type UIMessage, appendResponseMessages, createDataStreamResponse, streamText } from "ai"
// import { auth } from "@/app/(auth)/auth"
// import { systemPrompt } from "@/lib/ai/prompts"
// import { deleteChatById, getChatById, saveChat, saveMessages } from "@/lib/db/queries"
// import { generateUUID, getMostRecentUserMessage, getTrailingMessageId } from "@/lib/utils"
// import { generateTitleFromUserMessage } from "../../actions"
// import { createDocument } from "@/lib/ai/tools/create-document"
// import { updateDocument } from "@/lib/ai/tools/update-document"
// import { requestSuggestions } from "@/lib/ai/tools/request-suggestions"
// import { getWeather } from "@/lib/ai/tools/get-weather"
// import { getMCPTools } from "@/lib/ai/tools/mcp-tool-wrapper"
// import { isProductionEnvironment } from "@/lib/constants"
// import { myProvider } from "@/lib/ai/providers"

// export const maxDuration = 60

// // Normalize UI messages (which may carry content in `parts`) into core messages with string content
// function toCoreMessages(messages: Array<UIMessage>) {
//   return messages
//     .filter((m) => m.role === "user" || m.role === "assistant")
//     .map((m) => {
//       // Prefer explicit string content; otherwise, extract any text parts
//       const textFromParts = Array.isArray((m as any).parts)
//         ? (m as any).parts
//             .filter((p: any) => p && p.type === "text" && typeof p.text === "string")
//             .map((p: any) => p.text)
//             .join("")
//         : ""
//       const content =
//         typeof (m as any).content === "string" && (m as any).content.length > 0 ? (m as any).content : textFromParts
//       return { role: m.role as "user" | "assistant", content }
//     })
// }

// async function callLangChainBackend(messages: Array<UIMessage>) {
//   try {
//     const response = await fetch("http://localhost:5328/api/chat/langchain", {
//       method: "POST",
//       headers: {
//         "Content-Type": "application/json",
//       },
//       body: JSON.stringify({
//         messages: toCoreMessages(messages),
//       }),
//     })

//     if (!response.ok) {
//       throw new Error(`LangChain backend error: ${response.status}`)
//     }

//     const data = await response.json()
//     return data
//   } catch (error) {
//     console.error("Error calling LangChain backend:", error)
//     throw error
//   }
// }

// export async function POST(request: Request) {
//   try {
//     const {
//       id,
//       messages,
//       selectedChatModel,
//       useLangChain = false, // Added optional flag to use LangChain orchestration
//     }: {
//       id: string
//       messages: Array<UIMessage>
//       selectedChatModel: string
//       useLangChain?: boolean
//     } = await request.json()
//     console.log("THIS IS THE MESSAGE SENT:", messages)
//     console.log("[POST /api/chat] Incoming request", {
//       id,
//       selectedChatModel,
//       messagesCount: messages.length,
//       useLangChain,
//     })

//     const session = await auth()

//     if (!session?.user?.id) {
//       console.warn("[POST /api/chat] Unauthorized access attempt")
//       return new Response("Unauthorized", { status: 401 })
//     }

//     const userMessage = getMostRecentUserMessage(messages)

//     if (!userMessage) {
//       console.warn("[POST /api/chat] No user message found in messages", { messages })
//       return new Response("No user message found", { status: 400 })
//     }

//     const chat = await getChatById({ id })

//     if (!chat) {
//       const title = await generateTitleFromUserMessage({
//         message: userMessage,
//       })
//       await saveChat({ id, userId: session.user.id, title })
//       console.log("[POST /api/chat] Created new chat", { id, userId: session.user.id, title })
//     } else {
//       if (chat.userId !== session.user.id) {
//         console.warn("[POST /api/chat] Forbidden: user does not own chat", {
//           chatUserId: chat.userId,
//           sessionUserId: session.user.id,
//         })
//         return new Response("Forbidden", { status: 403 })
//       }
//     }

//     await saveMessages({
//       messages: [
//         {
//           chatId: id,
//           id: userMessage.id,
//           role: "user",
//           parts: userMessage.parts,
//           attachments: userMessage.experimental_attachments ?? [],
//           createdAt: new Date(),
//         },
//       ],
//     })

//     if (useLangChain) {
//       try {
//         const langchainResponse = await callLangChainBackend(messages)

//         return createDataStreamResponse({
//           execute: (dataStream) => {
//             const assistantMessage = {
//               id: generateUUID(),
//               role: "assistant" as const,
//               content: langchainResponse.response,
//             }

//             const content = langchainResponse.response || ""

//             // Write the message annotation first
//             dataStream.writeMessageAnnotation({
//               messageIdFromServer: assistantMessage.id,
//             })

//             // Write the complete text as a single delta (not character by character)
//             dataStream.writeData({
//               type: "text-delta",
//               content: content,
//             })

//             // Write finish message
//             dataStream.writeData({
//               type: "finish",
//               content: "",
//             })

//             // Save the assistant message to database
//             saveMessages({
//               messages: [
//                 {
//                   id: assistantMessage.id,
//                   chatId: id,
//                   role: "assistant",
//                   parts: [{ type: "text", text: content }],
//                   attachments: [],
//                   createdAt: new Date(),
//                 },
//               ],
//             }).catch((error) => {
//               console.error("[POST /api/chat] Failed to save LangChain message:", error)
//             })
//           },
//           onError: (err) => {
//             console.error("[POST /api/chat] LangChain dataStream error:", err)
//             return "Error with LangChain orchestration"
//           },
//         })
//       } catch (error) {
//         console.error("[POST /api/chat] LangChain error:", error)
//         return new Response("Error with LangChain orchestration", { status: 500 })
//       }
//     }

//     const mcpTools = await getMCPTools()
//     const staticTools = {
//       getWeather,
//       createDocument: createDocument({ session, dataStream: null as any }),
//       updateDocument: updateDocument({ session, dataStream: null as any }),
//       requestSuggestions: requestSuggestions({
//         session,
//         dataStream: null as any,
//       }),
//     }

//     return createDataStreamResponse({
//       execute: (dataStream) => {
//         console.log("[POST /api/chat] Starting streamText", { selectedChatModel })

//         const toolsWithDataStream = {
//           getWeather,
//           createDocument: createDocument({ session, dataStream }),
//           updateDocument: updateDocument({ session, dataStream }),
//           requestSuggestions: requestSuggestions({
//             session,
//             dataStream,
//           }),
//           ...mcpTools, // Add MCP tools
//         }

//         const result = streamText({
//           model: myProvider.languageModel(selectedChatModel),
//           system: systemPrompt({ selectedChatModel }),
//           // Ensure the model receives string content (Gemini ignores unknown fields like `parts`)
//           messages: toCoreMessages(messages) as any,
//           maxSteps: 5,
//           experimental_activeTools:
//             selectedChatModel === "chat-model-reasoning"
//               ? []
//               : ([
//                   "getWeather",
//                   "createDocument",
//                   "updateDocument",
//                   "requestSuggestions",
//                   ...Object.keys(mcpTools), // Add MCP tool names to active tools
//                 ] as any),
//           experimental_generateMessageId: generateUUID,
//           tools: toolsWithDataStream, // Use tools with MCP integration
//           onFinish: async ({ response }) => {
//             try {
//               console.log("[POST /api/chat] streamText onFinish", { response })
//               console.log("[POST /api/chat] Gemini response messages:", JSON.stringify(response.messages, null, 2))
//               if (!response || !response.messages || response.messages.length === 0) {
//                 console.error("[POST /api/chat] Empty response from model", { response })
//               }
//               if (session.user?.id) {
//                 try {
//                   const assistantId = getTrailingMessageId({
//                     messages: response.messages.filter((message) => message.role === "assistant"),
//                   })
//                   if (!assistantId) {
//                     throw new Error("No assistant message found!")
//                   }
//                   const [, assistantMessage] = appendResponseMessages({
//                     messages: [userMessage],
//                     responseMessages: response.messages,
//                   })
//                   await saveMessages({
//                     messages: [
//                       {
//                         id: assistantId,
//                         chatId: id,
//                         role: assistantMessage.role,
//                         parts: assistantMessage.parts,
//                         attachments: assistantMessage.experimental_attachments ?? [],
//                         createdAt: new Date(),
//                       },
//                     ],
//                   })
//                 } catch (err) {
//                   console.error("[POST /api/chat] Failed to save chat", err)
//                 }
//               }
//             } catch (err) {
//               console.error("[POST /api/chat] Error in onFinish", err)
//             }
//           },
//           onError: (err) => {
//             console.error("[POST /api/chat] streamText onError", err)
//           },
//           experimental_telemetry: {
//             isEnabled: isProductionEnvironment,
//             functionId: "stream-text",
//           },
//         })

//         result.consumeStream()

//         result.mergeIntoDataStream(dataStream, {
//           sendReasoning: true,
//         })
//       },
//       onError: (err) => {
//         console.error("[POST /api/chat] createDataStreamResponse onError", err)
//         return "Oops, an error occurred!"
//       },
//     })
//   } catch (error) {
//     console.error("[POST /api/chat] Caught error in POST handler", error)
//     return new Response("An error occurred while processing your request!", {
//       status: 500,
//     })
//   }
// }

// export async function DELETE(request: Request) {
//   const { searchParams } = new URL(request.url)
//   const id = searchParams.get("id")

//   if (!id) {
//     return new Response("Not Found", { status: 404 })
//   }

//   const session = await auth()

//   if (!session?.user?.id) {
//     return new Response("Unauthorized", { status: 401 })
//   }

//   try {
//     const chat = await getChatById({ id })

//     if (chat.userId !== session.user.id) {
//       return new Response("Forbidden", { status: 403 })
//     }

//     const deletedChat = await deleteChatById({ id })

//     return Response.json(deletedChat, { status: 200 })
//   } catch (error) {
//     return new Response("An error occurred while processing your request!", {
//       status: 500,
//     })
//   }
// }
