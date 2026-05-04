import { cookies } from "next/headers"
import { notFound } from "next/navigation"

import { auth } from "@/app/(auth)/auth"
import { Chat } from "@/components/chat"
import { getChatById, getMessagesByChatId } from "@/lib/db/queries"
import { DataStreamHandler } from "@/components/data-stream-handler"
import { DEFAULT_CHAT_MODEL } from "@/lib/ai/models"
import type { DBMessage } from "@/lib/db/schema"
import type { UIMessage, Attachment } from "@/hooks/use-leak-chat"

export default async function Page(props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const { id } = params
  const chat = await getChatById({ id })

  if (!chat) {
    notFound()
  }

  const session = await auth()

  if (chat.visibility === "private") {
    if (!session || !session.user) {
      return notFound()
    }

    if (session.user.id !== chat.userId) {
      return notFound()
    }
  }

  const messagesFromDb = await getMessagesByChatId({
    id,
  })

  function extractTextFromParts(parts: UIMessage["parts"] | undefined): string {
    if (!parts || !Array.isArray(parts)) return ""
    return parts.map((p: any) => (p && p.type === "text" && typeof p.text === "string" ? p.text : "")).join("")
  }

  function convertToUIMessages(messages: Array<DBMessage>): Array<UIMessage> {
    return messages.map((message) => ({
      id: message.id,
      parts: message.parts as UIMessage["parts"],
      role: message.role as UIMessage["role"],
      // Populate `content` from `parts` for better server compatibility
      content: extractTextFromParts(message.parts as UIMessage["parts"]),
      createdAt: message.createdAt,
      experimental_attachments: (message.attachments as Array<Attachment>) ?? [],
    }))
  }

  const cookieStore = await cookies()
  const chatModelFromCookie = cookieStore.get("chat-model")

  if (!chatModelFromCookie) {
    return (
      <>
        <Chat
          id={chat.id}
          initialMessages={convertToUIMessages(messagesFromDb)}
          selectedChatModel={DEFAULT_CHAT_MODEL}
          selectedVisibilityType={chat.visibility}
          isReadonly={session?.user?.id !== chat.userId}
        />
        <DataStreamHandler id={id} />
      </>
    )
  }

  return (
    <>
      <Chat
        id={chat.id}
        initialMessages={convertToUIMessages(messagesFromDb)}
        selectedChatModel={chatModelFromCookie.value}
        selectedVisibilityType={chat.visibility}
        isReadonly={session?.user?.id !== chat.userId}
      />
      <DataStreamHandler id={id} />
    </>
  )
}
