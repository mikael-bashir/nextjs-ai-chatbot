// Shared plan/pack constants — safe to import from client components

export const CREDIT_PACKS = [
  { credits: 10, unitAmount: 99, label: '10 credits' },
  { credits: 50, unitAmount: 349, label: '50 credits' },
  { credits: 100, unitAmount: 599, label: '100 credits', popular: true as const },
  { credits: 500, unitAmount: 1999, label: '500 credits' },
];

export const SUBSCRIPTION_PLANS = [
  {
    id: 'starter',
    name: 'Starter',
    description: 'Perfect for light usage',
    credits: 100,
    unitAmount: 799,
  },
  {
    id: 'pro',
    name: 'Pro',
    description: 'For regular users',
    credits: 500,
    unitAmount: 2499,
    popular: true as const,
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    description: 'For power users',
    credits: 2000,
    unitAmount: 7999,
  },
];

export type CreditPack = (typeof CREDIT_PACKS)[number];
export type SubscriptionPlan = (typeof SUBSCRIPTION_PLANS)[number];
