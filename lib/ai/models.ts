export const DEFAULT_CHAT_MODEL: string = 'grok-free-pool';

interface ChatModel {
  id: string;
  name: string;
  description: string;
  paid: boolean; // true = deduct credits; false = free tier key, no deduction
}

export const chatModels: Array<ChatModel> = [
  {
    id: 'grok-free-pool',
    name: 'Grok 4.1 Fast (Free)',
    description: 'Free tier — daily limits apply',
    paid: false,
  },
  {
    id: 'grok-3-fast',
    name: 'Grok 3 Fast',
    description: 'Paid — fast responses, credits deducted',
    paid: true,
  },
  {
    id: 'grok-4-fast',
    name: 'Grok 4 Fast',
    description: 'Paid — xAI\'s fastest frontier model, credits deducted',
    paid: true,
  },
  {
    id: 'claude-local',
    name: 'Claude (your machine)',
    description: 'Runs on your own Claude Code via the local bridge — no credits used',
    paid: false, // user's own subscription powers it; we deduct nothing
  },
];

export function isPaidModel(modelId: string): boolean {
  return chatModels.find((m) => m.id === modelId)?.paid ?? false;
}
