import { createDocumentHandler } from "@/lib/artifacts/server"

export const textDocumentHandler = createDocumentHandler<"text">({
  kind: "text",
  onCreateDocument: async ({ title, dataStream }) => {
    const content = `# ${title}\n\nThis is a placeholder text document. The content would be generated based on the title: "${title}".`

    dataStream.writeData({
      type: "text-delta",
      content: content,
    })

    return content
  },
  onUpdateDocument: async ({ document, description, dataStream }) => {
    const updatedContent = `${document.content}\n\n## Update\n\n${description}`

    dataStream.writeData({
      type: "text-delta",
      content: updatedContent,
    })

    return updatedContent
  },
})
