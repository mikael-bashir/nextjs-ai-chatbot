import type Stripe from 'stripe';
import { stripe } from '@/lib/stripe';
import { sendPurchaseConfirmationEmail } from '@/lib/email';
import {
  addCredits,
  saveOrUpdateSubscription,
  markSubscriptionCancelled,
  getUserById,
} from '@/lib/db/queries';

function subscriptionPeriodEnd(sub: Stripe.Subscription): Date {
  // In API v2026-05-27.dahlia, current_period_end lives on each SubscriptionItem
  const itemEnd = sub.items?.data[0]?.current_period_end;
  return itemEnd ? new Date(itemEnd * 1000) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  // In API v2026-05-27.dahlia, Invoice.subscription was replaced by Invoice.parent.subscription_details.subscription
  const fromParent = invoice.parent?.subscription_details?.subscription;
  if (fromParent) return typeof fromParent === 'string' ? fromParent : fromParent.id;
  return null;
}

export async function POST(req: Request) {
  const body = await req.text();
  const signature = req.headers.get('stripe-signature');

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('[Webhook] STRIPE_WEBHOOK_SECRET is not set');
    return Response.json({ error: 'Webhook secret not configured' }, { status: 500 });
  }

  if (!signature) {
    return Response.json({ error: 'Missing stripe-signature header' }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch {
    return Response.json({ error: 'Invalid webhook signature' }, { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const { userId, type } = session.metadata ?? {};
        if (!userId) break;

        if (type === 'one_time' && session.mode === 'payment') {
          const credits = Number(session.metadata?.credits ?? 0);
          if (credits > 0) {
            await addCredits({
              userId,
              amount: credits,
              description: `Purchased ${credits} credits`,
              type: 'purchase',
            });
            const user = await getUserById({ id: userId });
            if (user?.email) {
              await sendPurchaseConfirmationEmail({
                to: user.email,
                name: user.email.split('@')[0],
                credits,
                amountPaidCents: session.amount_total ?? 0,
                isSubscription: false,
              });
            }
          }
        } else if (type === 'subscription' && session.mode === 'subscription') {
          // Save subscription record; credits granted via invoice.payment_succeeded
          if (session.subscription) {
            const subId =
              typeof session.subscription === 'string'
                ? session.subscription
                : session.subscription.id;
            const sub = await stripe.subscriptions.retrieve(subId, {
              expand: ['items.data'],
            });
            await saveOrUpdateSubscription({
              userId,
              stripeSubscriptionId: sub.id,
              planId: sub.metadata.planId ?? 'unknown',
              status: 'active',
              currentPeriodEnd: subscriptionPeriodEnd(sub),
            });
          }
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = invoiceSubscriptionId(invoice);
        if (!subscriptionId) break;

        const sub = await stripe.subscriptions.retrieve(subscriptionId, {
          expand: ['items.data'],
        });
        const { userId, credits, planId, planName } = sub.metadata;
        if (!userId || !credits) break;

        const creditsNum = Number(credits);
        await addCredits({
          userId,
          amount: creditsNum,
          description: `${planName ?? planId} plan — monthly credits`,
          type: 'purchase',
        });

        await saveOrUpdateSubscription({
          userId,
          stripeSubscriptionId: sub.id,
          planId: planId ?? 'unknown',
          status: 'active',
          currentPeriodEnd: subscriptionPeriodEnd(sub),
        });

        const user = await getUserById({ id: userId });
        if (user?.email) {
          await sendPurchaseConfirmationEmail({
            to: user.email,
            name: user.email.split('@')[0],
            credits: creditsNum,
            amountPaidCents: invoice.amount_paid,
            isSubscription: true,
            planName: planName ?? planId,
          });
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const { userId, planId } = sub.metadata;
        if (!userId) break;

        const status =
          sub.status === 'active'
            ? 'active'
            : sub.status === 'past_due'
              ? 'past_due'
              : sub.status === 'canceled'
                ? 'cancelled'
                : 'incomplete';

        await saveOrUpdateSubscription({
          userId,
          stripeSubscriptionId: sub.id,
          planId: planId ?? 'unknown',
          status,
          currentPeriodEnd: subscriptionPeriodEnd(sub),
        });
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        await markSubscriptionCancelled({ stripeSubscriptionId: sub.id });
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.error(`[Webhook] Error handling ${event.type}:`, err);
    return Response.json({ error: 'Internal error processing webhook' }, { status: 500 });
  }

  return Response.json({ received: true });
}
