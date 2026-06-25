"use client"

import type React from "react"
import { useState, useCallback, useRef } from "react"
import { generateUUID } from "@/lib/utils"
import { toast } from "sonner"
import { useApiClient } from "@/lib/hooks/useApiClient"

export interface UIMessage {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  createdAt?: Date
  parts: Array<{ type: "text"; text: string }>
  experimental_attachments?: Array<any>
  annotations?: Array<any>
}

export interface Attachment {
  name: string
  contentType: string
  size: number
  url: string
}

export type ChatStatus = "ready" | "streaming" | "submitted" | "error"

interface UseLeakChatOptions {
  id: string
  initialMessages: UIMessage[]
  body?: Record<string, any>
  onFinish?: () => void
  onError?: () => void
}

export interface Message {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  createdAt?: Date
}

export function useLeakChat({ id, initialMessages, body = {}, onFinish, onError }: UseLeakChatOptions) {
  const [messages, setMessages] = useState<UIMessage[]>(initialMessages)
  const [input, setInput] = useState("")
  const [status, setStatus] = useState<ChatStatus>("ready")

  const abortControllerRef = useRef<AbortController | null>(null)

  const apiClient = useApiClient();

  // Shared streaming logic — called by both handleSubmit and append.
  const sendMessages = useCallback(
    async (currentMessages: UIMessage[]): Promise<string | null | undefined> => {
      setStatus("streaming")
      abortControllerRef.current = new AbortController()

      try {
        const response = await apiClient("/api/chat/canary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: abortControllerRef.current.signal,
          body: JSON.stringify({
            id,
            messages: currentMessages,
            ...body,
          }),
        })

        if (response.status === 429) {
          const resBody = await response.json().catch(() => ({}))
          const resetAt = resBody.resetAt ? new Date(resBody.resetAt) : null
          const mins = resetAt
            ? Math.ceil((resetAt.getTime() - Date.now()) / 60000)
            : null
          toast.error(
            mins != null
              ? `Rate limit reached — try again in ${mins} minute${mins === 1 ? "" : "s"}.`
              : "Rate limit reached — please wait before sending another message.",
          )
          setStatus("ready")
          // Remove the optimistically-added user message
          const lastUserMsg = [...currentMessages].reverse().find((m) => m.role === "user")
          if (lastUserMsg) {
            setMessages((prev) => prev.filter((m) => m.id !== lastUserMsg.id))
          }
          return null
        }

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`)
        }

        const reader = response.body?.getReader()
        if (!reader) {
          throw new Error("No response body")
        }

        let assistantMessage: UIMessage = {
          id: generateUUID(),
          role: "assistant",
          content: "",
          createdAt: new Date(),
          parts: [{ type: "text", text: "" }],
          annotations: [],
        }

        setMessages((prev) => [...prev, assistantMessage])

        const decoder = new TextDecoder()
        let buffer = ""

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })

          const events = buffer.split("\n\n")
          buffer = events.pop() || ""

          for (const event of events) {
            if (event.startsWith("data: ")) {
              try {
                const dataString = event.replace(/^data:\s*/, "")
                if (!dataString) continue

                const data = JSON.parse(dataString)

                console.log(`🚨 [FRONTEND] Received type: ${data.type}`, data)

                if (data.type === "text-delta") {
                  const newContent = data.content
                  assistantMessage = {
                    ...assistantMessage,
                    content: newContent,
                    parts: [{ type: "text", text: newContent }]
                  }
                }

                if (data.type === "message-annotation") {
                  assistantMessage = {
                    ...assistantMessage,
                    annotations: [...(assistantMessage.annotations || []), data]
                  }
                }

                setMessages((prev) => prev.map((msg) => (msg.id === assistantMessage.id ? assistantMessage : msg)))

              } catch (e) {
                // Silently ignore incomplete JSON chunks
              }
            }
          }
        }

        setStatus("ready")
        onFinish?.()
        return assistantMessage.content
      } catch (error: any) {
        if (error?.name === "AbortError") {
          console.log("Chat cancelled by user.")
          setStatus("ready")
          return null
        }
        console.error("Chat error:", error)
        setStatus("error")
        onError?.()
        toast.error("An error occurred, please try again!")
        return null
      }
    },
    [id, body, onFinish, onError, apiClient],
  )

  const handleSubmit = useCallback(
    async (
      e?: React.FormEvent,
      options?: { experimental_attachments?: Attachment[] },
    ): Promise<string | null | undefined> => {
      if (e) e.preventDefault()

      if (!input.trim() && !options?.experimental_attachments?.length) return null

      const userMessage: UIMessage = {
        id: generateUUID(),
        role: "user",
        content: input,
        createdAt: new Date(),
        parts: [{ type: "text", text: input }],
        experimental_attachments: options?.experimental_attachments,
      }

      const updatedMessages = [...messages, userMessage]
      setMessages(updatedMessages)
      setInput("")

      return sendMessages(updatedMessages)
    },
    [input, messages, sendMessages],
  )

  const append = useCallback(
    async (message: UIMessage): Promise<string | null | undefined> => {
      const updatedMessages = [...messages, message]
      setMessages(updatedMessages)
      return sendMessages(updatedMessages)
    },
    [messages, sendMessages],
  )

  const stop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    setStatus("ready")
  }, [])

  const setMessagesWrapper = useCallback(
    (messagesOrUpdater: UIMessage[] | ((messages: UIMessage[]) => UIMessage[])) => {
      if (typeof messagesOrUpdater === "function") {
        setMessages(messagesOrUpdater)
      } else {
        setMessages(messagesOrUpdater)
      }
    },
    [],
  )

  const reload = useCallback(async (): Promise<string | null | undefined> => {
    console.log("Reload not implemented yet")
    return null
  }, [])

  return {
    messages,
    setMessages: setMessagesWrapper,
    input,
    setInput,
    handleSubmit,
    append,
    reload,
    stop,
    status,
  }
}
