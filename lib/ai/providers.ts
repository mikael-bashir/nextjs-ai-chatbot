import { artifactModel, chatModel, reasoningModel, titleModel } from "./models.test"
import { isTestEnvironment } from "../constants"

// Simple provider structure without AI SDK dependencies
export const myProvider = isTestEnvironment
  ? {
      languageModels: {
        "chat-model": chatModel,
        "chat-model-reasoning": reasoningModel,
        "title-model": titleModel,
        "artifact-model": artifactModel,
      },
    }
  : {
      languageModels: {
        "chat-model": "grok-2-vision-1212",
        "chat-model-reasoning": "grok-3-mini-beta",
        "title-model": "grok-2-1212",
        "artifact-model": "grok-2-1212",
      },
      imageModels: {
        "small-model": "grok-2-image",
      },
    }
