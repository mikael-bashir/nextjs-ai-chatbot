import { z } from "zod"
import type { Session } from "next-auth"
import { getDocumentById, saveSuggestions } from "@/lib/db/queries"
import type { Suggestion } from "@/lib/db/schema"
import { generateUUID } from "@/lib/utils"
import { createTool, type Tool } from "./get-weather"

interface DataStreamWriter {
  writeData: (data: { type: string; content: any }) => void
}

interface RequestSuggestionsProps {
  session: Session
  dataStream: DataStreamWriter
}

export const requestSuggestions = ({ session, dataStream }: RequestSuggestionsProps): Tool =>
  createTool({
    description: "Request suggestions for a document",
    parameters: z.object({
      documentId: z.string().describe("The ID of the document to request edits"),
    }),
    execute: async ({ documentId }) => {
      const document = await getDocumentById({ id: documentId })

      if (!document || !document.content) {
        return {
          error: "Document not found",
        }
      }

      const suggestions: Array<Omit<Suggestion, "userId" | "createdAt" | "documentCreatedAt">> = []

      const mockSuggestions = [
        {
          originalSentence: "This is a sample sentence.",
          suggestedSentence: "This is an improved sample sentence.",
          description: "Made the sentence more descriptive",
        },
        {
          originalSentence: "Another example text.",
          suggestedSentence: "Another well-crafted example text.",
          description: "Enhanced clarity and flow",
        },
      ]

      for (const element of mockSuggestions) {
        const suggestion = {
          originalText: element.originalSentence,
          suggestedText: element.suggestedSentence,
          description: element.description,
          id: generateUUID(),
          documentId: documentId,
          isResolved: false,
        }

        dataStream.writeData({
          type: "suggestion",
          content: suggestion,
        })

        suggestions.push(suggestion)
      }

      if (session.user?.id) {
        const userId = session.user.id

        await saveSuggestions({
          suggestions: suggestions.map((suggestion) => ({
            ...suggestion,
            userId,
            createdAt: new Date(),
            documentCreatedAt: document.createdAt,
          })),
        })
      }

      return {
        id: documentId,
        title: document.title,
        kind: document.kind,
        message: "Suggestions have been added to the document",
      }
    },
  })
