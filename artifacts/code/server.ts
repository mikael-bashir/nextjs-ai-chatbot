import { createDocumentHandler } from "@/lib/artifacts/server"

export const codeDocumentHandler = createDocumentHandler<"code">({
  kind: "code",
  onCreateDocument: async ({ title, dataStream }) => {
    const code = `// ${title}\n// This is a placeholder code document\n\nfunction main() {\n  console.log("Hello, ${title}!");\n}\n\nmain();`

    dataStream.writeData({
      type: "code-delta",
      content: code,
    })

    return code
  },
  onUpdateDocument: async ({ document, description, dataStream }) => {
    const updatedCode = `${document.content}\n\n// Update: ${description}\n// Additional functionality would be added here`

    dataStream.writeData({
      type: "code-delta",
      content: updatedCode,
    })

    return updatedCode
  },
})
