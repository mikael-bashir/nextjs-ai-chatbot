"use server"

import { cookies } from "next/headers"

import { deleteMessagesByChatIdAfterTimestamp, getMessageById, updateChatVisiblityById } from "@/lib/db/queries"
import type { VisibilityType } from "@/components/visibility-selector"
import type { UIMessage } from "@/hooks/use-leak-chat"

export async function saveChatModelAsCookie(model: string) {
  const cookieStore = await cookies()
  cookieStore.set("chat-model", model)
}

export async function generateTitleFromUserMessage({ message }: { message: UIMessage }) {
  const content = message.content || "New Chat"
  const title = content.length > 80 ? content.substring(0, 77) + "..." : content

  return title
}

export async function deleteTrailingMessages({ id }: { id: string }) {
  const [message] = await getMessageById({ id })

  await deleteMessagesByChatIdAfterTimestamp({
    chatId: message.chatId,
    timestamp: message.createdAt,
  })
}

export async function updateChatVisibility({
  chatId,
  visibility,
}: {
  chatId: string
  visibility: VisibilityType
}) {
  await updateChatVisiblityById({ chatId, visibility })
}
