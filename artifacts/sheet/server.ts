import { createDocumentHandler } from "@/lib/artifacts/server"

export const sheetDocumentHandler = createDocumentHandler<"sheet">({
  kind: "sheet",
  onCreateDocument: async ({ title, dataStream }) => {
    const csv = `Name,Value,Description\n${title},1,Sample data for ${title}\nExample,2,Another row of data\nTest,3,Third row of sample data`

    dataStream.writeData({
      type: "sheet-delta",
      content: csv,
    })

    return csv
  },
  onUpdateDocument: async ({ document, description, dataStream }) => {
    const updatedCsv = `${document.content}\nUpdate,4,${description}`

    dataStream.writeData({
      type: "sheet-delta",
      content: updatedCsv,
    })

    return updatedCsv
  },
})
