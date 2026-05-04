export const chatModel = {
  doGenerate: async () => ({
    rawCall: { rawPrompt: null, rawSettings: {} },
    finishReason: "stop",
    usage: { promptTokens: 10, completionTokens: 20 },
    text: `Hello, world!`,
  }),
  doStream: async ({ prompt }: { prompt: any }) => ({
    stream: createMockStream([
      { type: "text-delta", textDelta: "Hello, world!" },
      {
        type: "finish",
        finishReason: "stop",
        logprobs: undefined,
        usage: { completionTokens: 10, promptTokens: 3 },
      },
    ]),
    rawCall: { rawPrompt: null, rawSettings: {} },
  }),
}

export const reasoningModel = {
  doGenerate: async () => ({
    rawCall: { rawPrompt: null, rawSettings: {} },
    finishReason: "stop",
    usage: { promptTokens: 10, completionTokens: 20 },
    text: `Hello, world!`,
  }),
  doStream: async ({ prompt }: { prompt: any }) => ({
    stream: createMockStream([
      { type: "text-delta", textDelta: "Hello, world!" },
      {
        type: "finish",
        finishReason: "stop",
        logprobs: undefined,
        usage: { completionTokens: 10, promptTokens: 3 },
      },
    ]),
    rawCall: { rawPrompt: null, rawSettings: {} },
  }),
}

export const titleModel = {
  doGenerate: async () => ({
    rawCall: { rawPrompt: null, rawSettings: {} },
    finishReason: "stop",
    usage: { promptTokens: 10, completionTokens: 20 },
    text: `This is a test title`,
  }),
  doStream: async () => ({
    stream: createMockStream([
      { type: "text-delta", textDelta: "This is a test title" },
      {
        type: "finish",
        finishReason: "stop",
        logprobs: undefined,
        usage: { completionTokens: 10, promptTokens: 3 },
      },
    ]),
    rawCall: { rawPrompt: null, rawSettings: {} },
  }),
}

export const artifactModel = {
  doGenerate: async () => ({
    rawCall: { rawPrompt: null, rawSettings: {} },
    finishReason: "stop",
    usage: { promptTokens: 10, completionTokens: 20 },
    text: `Hello, world!`,
  }),
  doStream: async ({ prompt }: { prompt: any }) => ({
    stream: createMockStream([
      { type: "text-delta", textDelta: "Hello, world!" },
      {
        type: "finish",
        finishReason: "stop",
        logprobs: undefined,
        usage: { completionTokens: 10, promptTokens: 3 },
      },
    ]),
    rawCall: { rawPrompt: null, rawSettings: {} },
  }),
}

function createMockStream(chunks: any[]) {
  let index = 0
  return new ReadableStream({
    start(controller) {
      const sendChunk = () => {
        if (index < chunks.length) {
          controller.enqueue(chunks[index])
          index++
          setTimeout(sendChunk, 100)
        } else {
          controller.close()
        }
      }
      setTimeout(sendChunk, 500)
    },
  })
}
