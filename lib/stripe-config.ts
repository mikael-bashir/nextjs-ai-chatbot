// Shared plan/pack constants — safe to import from client components.
// 1 credit = £1. unitAmount is in pence (GBP × 100).

export const CREDIT_PACKS = [
  { credits: 5,   unitAmount: 500,   label: '£5',   description: '5 credits' },
  { credits: 10,  unitAmount: 1000,  label: '£10',  description: '10 credits' },
  { credits: 25,  unitAmount: 2500,  label: '£25',  description: '25 credits', popular: true as const },
  { credits: 100, unitAmount: 10000, label: '£100', description: '100 credits' },
];

export const SUBSCRIPTION_PLANS = [
  {
    id: 'starter',
    name: 'Starter',
    description: '20 credits/month — light usage',
    credits: 20,
    unitAmount: 2000, // £20/month
  },
  {
    id: 'pro',
    name: 'Pro',
    description: '60 credits/month — regular users',
    credits: 60,
    unitAmount: 5000, // £50/month (~17% saving vs pay-as-you-go)
    popular: true as const,
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    description: '200 credits/month — power users',
    credits: 200,
    unitAmount: 15000, // £150/month (25% saving)
  },
];

export type CreditPack = (typeof CREDIT_PACKS)[number];
export type SubscriptionPlan = (typeof SUBSCRIPTION_PLANS)[number];
