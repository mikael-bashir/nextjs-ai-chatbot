"use client"

import { useState, useEffect } from "react"
import useSWR, { useSWRConfig } from "swr"
import { ChatHeader } from "@/components/chat-header"
import type { Vote } from "@/lib/db/schema"
import { fetcher } from "@/lib/utils"
import { Artifact } from "./artifact"
import { MultimodalInput } from "./multimodal-input"
import { Messages } from "./messages"
import type { VisibilityType } from "./visibility-selector"
import { useArtifactSelector } from "@/hooks/use-artifact"
import { unstable_serialize } from "swr/infinite"
import { getChatHistoryPaginationKey } from "./sidebar-history"
import { useLeakChat, type UIMessage, type Attachment } from "@/hooks/use-leak-chat"

export function Chat({
  id,
  initialMessages,
  selectedChatModel,
  selectedVisibilityType,
  isReadonly,
}: {
  id: string
  initialMessages: Array<UIMessage>
  selectedChatModel: string
  selectedVisibilityType: VisibilityType
  isReadonly: boolean
}) {
  const { mutate } = useSWRConfig()

  const { messages, setMessages, handleSubmit, input, setInput, append, status, stop, reload } = useLeakChat({
    id,
    initialMessages,
    body: { id, selectedChatModel },
    onFinish: () => {
      mutate(unstable_serialize(getChatHistoryPaginationKey))
    },
  })

  const { data: votes } = useSWR<Array<Vote>>(messages.length >= 2 ? `/api/vote?chatId=${id}` : null, fetcher)

  const [attachments, setAttachments] = useState<Array<Attachment>>([])
  const isArtifactVisible = useArtifactSelector((state) => state.isVisible)

  // 1. Extract the latest metrics from the active agent stream
  const lastAssistantMsg = [...messages].reverse().find((m) => m.role === "assistant")
  const annotations = (lastAssistantMsg?.annotations || []) as Array<any>
  const latestStatus = annotations.length > 0 ? annotations[annotations.length - 1] : null

  const [localTime, setLocalTime] = useState(0)

  useEffect(() => {
    let interval: NodeJS.Timeout
    if (status === "streaming") {
      interval = setInterval(() => {
        setLocalTime((prev) => prev + 1)
      }, 1000)
    } else if (status === "ready" && messages.length <= 1) {
      setLocalTime(0) // Only reset if the chat is cleared
    }
    return () => clearInterval(interval)
  }, [status, messages.length])

  useEffect(() => {
    if (latestStatus?.metrics?.time_elapsed !== undefined) {
      setLocalTime(Math.floor(latestStatus.metrics.time_elapsed))
    }
  }, [latestStatus?.metrics?.time_elapsed])

  return (
    <>
      <div className="flex flex-col min-w-0 h-dvh bg-background">
        <ChatHeader
          chatId={id}
          selectedModelId={selectedChatModel}
          selectedVisibilityType={selectedVisibilityType}
          isReadonly={isReadonly}
        />

        <Messages
          chatId={id}
          status={status}
          votes={votes}
          messages={messages}
          setMessages={setMessages}
          reload={reload}
          isReadonly={isReadonly}
          isArtifactVisible={isArtifactVisible}
        />

        <form className="flex flex-col mx-auto px-4 bg-background pb-4 md:pb-6 gap-2 w-full md:max-w-3xl">
          {/* 2. The Real-Time Agent HUD */}
          {/* 2. The Agent HUD (Persistent) */}
          {latestStatus && latestStatus.thought && (
            <div 
              className={`flex items-center gap-2 text-xs text-muted-foreground px-3 py-1.5 bg-muted/50 rounded-md w-fit border border-border/50 shadow-sm transition-all duration-300 ${
                status === "streaming" ? "animate-pulse" : "opacity-80"
              }`}
            >
              {/* Dynamic Status Dot: Blue when thinking, Green when done */}
              <span 
                className={`w-2 h-2 rounded-full ${
                  status === "streaming" ? "bg-blue-500" : "bg-green-500"
                }`}
              ></span>
              
              <span className="font-medium">{latestStatus.thought}</span>
              <span className="opacity-50">|</span>

              <span>{localTime}s elapsed</span>
              <span className="opacity-50">|</span>
              <span>{latestStatus.metrics?.tools_invoked || 0} Tool calls</span>
              <span className="opacity-50">|</span>
              <span>{latestStatus.metrics?.llm_invocations || 0} LLM calls</span>
            </div>
          )}

          {!isReadonly && (
            <MultimodalInput
              chatId={id}
              input={input}
              setInput={setInput}
              handleSubmit={handleSubmit}
              status={status}
              stop={stop}
              attachments={attachments}
              setAttachments={setAttachments}
              messages={messages}
              setMessages={setMessages}
              append={append}
            />
          )}
        </form>
      </div>

      <Artifact
        chatId={id}
        input={input}
        setInput={setInput}
        handleSubmit={handleSubmit}
        status={status}
        stop={stop}
        attachments={attachments}
        setAttachments={setAttachments}
        append={append}
        messages={messages}
        setMessages={setMessages}
        reload={reload}
        votes={votes}
        isReadonly={isReadonly}
      />
    </>
  )
}
