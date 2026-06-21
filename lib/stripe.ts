import 'server-only';
import Stripe from 'stripe';

if (!process.env.STRIPE_SECRET) throw new Error('STRIPE_SECRET is not set');

export const stripe = new Stripe(process.env.STRIPE_SECRET, {
  apiVersion: '2026-05-27.dahlia',
});

export { CREDIT_PACKS, SUBSCRIPTION_PLANS } from './stripe-config';
export type { CreditPack, SubscriptionPlan } from './stripe-config';

export function appUrl() {
  return process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3002';
}
