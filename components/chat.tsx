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
      // Update URL to the permanent chat route once the first response completes.
      // Done here (not on click) so Next.js doesn't navigate before the chat exists in the DB.
      if (window.location.pathname !== `/chat/${id}`) {
        window.history.replaceState(window.history.state, "", `/chat/${id}`)
      }
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
  const [isThoughtsExpanded, setIsThoughtsExpanded] = useState(false)

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
          {/* 2. The Agent HUD (Persistent) */}
          {annotations.length > 0 && (
            <div className="flex flex-col w-full gap-2 transition-all duration-300">
              
              <div className="flex items-center justify-between w-full">
                {/* Expand/Collapse Button */}
                <button
                  type="button"
                  onClick={() => setIsThoughtsExpanded(!isThoughtsExpanded)}
                  className={`flex items-center gap-2 text-xs text-muted-foreground px-3 py-1.5 bg-muted/50 hover:bg-muted/80 rounded-md border border-border/50 shadow-sm transition-colors w-fit`}
                >
                  <span 
                    className={`w-2 h-2 rounded-full ${
                      status === "streaming" ? "bg-blue-500 animate-pulse" : "bg-green-500"
                    }`}
                  />
                  <span className="font-medium max-w-[200px] md:max-w-sm truncate text-left">
                    {latestStatus?.thought || "Agent Activity"}
                  </span>
                  <span className="opacity-50">|</span>
                  <span>{localTime}s elapsed</span>
                  <span className="opacity-50">|</span>
                  <span>{latestStatus?.metrics?.tools_invoked || 0} Tools</span>
                  <span className="opacity-50">|</span>
                  <span>{latestStatus?.metrics?.llm_invocations || 0} LLMs</span>
                  
                  {/* Simple Dropdown Arrow */}
                  <span className="ml-1 opacity-70">
                    {isThoughtsExpanded ? "▲" : "▼"}
                  </span>
                </button>

                {/* 🚨 NEW: Explicit Stop Button */}
                {status === "streaming" && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      stop();
                    }}
                    className="flex items-center gap-1 text-xs font-semibold text-red-500 hover:text-red-600 bg-red-50 hover:bg-red-100 px-3 py-1.5 rounded-md border border-red-200 transition-colors"
                  >
                    <span className="w-2 h-2 bg-red-500 rounded-sm" />
                    Stop Agent
                  </button>
                )}
              </div>

              {/* 🚨 NEW: The Full Receipt of Thoughts (Scrollable) */}
              {isThoughtsExpanded && (
                <div className="flex flex-col gap-1 p-3 bg-muted/30 border border-border/50 rounded-md max-h-64 overflow-y-auto text-xs font-mono text-muted-foreground shadow-inner">
                  {annotations.map((ann, idx) => (
                    <div key={idx} className="flex gap-3 border-b border-border/20 last:border-0 pb-1 last:pb-0">
                      <span className="opacity-40 min-w-[24px]">[{idx + 1}]</span>
                      <span className={`${ann.type === 'error' ? 'text-red-500' : ''} ${ann.type === 'status' ? 'text-blue-500/80 font-semibold' : ''}`}>
                        {ann.thought || ann.message || (ann.tool ? `Executed tool: ${ann.tool}` : JSON.stringify(ann))}
                      </span>
                    </div>
                  ))}
                </div>
              )}
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
