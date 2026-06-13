export const DEFAULT_CHAT_MODEL: string = 'gemini/gemini-2.5-pro';

interface ChatModel {
  id: string;
  name: string;
  description: string;
}

export const chatModels: Array<ChatModel> = [
{ 
  //   id: "gemini/gemini-2.5-pro", 
  //   name: "Gemini 2.5 Pro", 
  //   description: "Google's best model for complex reasoning" 
  // },
  // { 
  //   id: "openai/o3-mini", 
  //   name: "o3-mini", 
  //   description: "OpenAI's fast reasoning model" 
  // },
  // { 
  //   id: "anthropic/claude-3-7-sonnet-20250219", 
  //   name: "Claude 3.7 Sonnet", 
  //   description: "Anthropic's smartest model" 
  // },
    id: "grok-free-pool", 
    name: "Grok 4.1", 
    description: "xAI's frontier model" 
  }
];

//  "model_name": "grok-free-pool",
