import { auth } from '@/app/(auth)/auth';
import { stripe, CREDIT_PACKS, SUBSCRIPTION_PLANS, appUrl } from '@/lib/stripe';
import {
  getStripeCustomerId,
  saveStripeCustomer,
} from '@/lib/db/queries';

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body) return Response.json({ error: 'Invalid JSON' }, { status: 400 });

  const { type, credits, planId } = body as {
    type: 'one_time' | 'subscription';
    credits?: number;
    planId?: string;
  };

  // Ensure a Stripe customer exists for this user
  let customerId = await getStripeCustomerId({ userId: session.user.id });
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: session.user.email!,
      name: session.user.name ?? undefined,
      metadata: { userId: session.user.id },
    });
    customerId = customer.id;
    await saveStripeCustomer({ userId: session.user.id, stripeCustomerId: customerId });
  }

  const base = appUrl();

  if (type === 'one_time') {
    const pack = CREDIT_PACKS.find((p) => p.credits === credits);
    if (!pack) return Response.json({ error: 'Invalid credits value' }, { status: 400 });

    const checkoutSession = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `${pack.credits} Leak Credits`,
              description: `Add ${pack.credits} credits to your Leak account`,
            },
            unit_amount: pack.unitAmount,
          },
          quantity: 1,
        },
      ],
      metadata: {
        userId: session.user.id,
        credits: pack.credits.toString(),
        type: 'one_time',
      },
      success_url: `${base}/account?payment=success`,
      cancel_url: `${base}/account?payment=cancelled`,
    });

    return Response.json({ url: checkoutSession.url });
  }

  if (type === 'subscription') {
    const plan = SUBSCRIPTION_PLANS.find((p) => p.id === planId);
    if (!plan) return Response.json({ error: 'Invalid plan' }, { status: 400 });

    const checkoutSession = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Leak ${plan.name} Plan`,
              description: `${plan.credits} credits per month`,
            },
            unit_amount: plan.unitAmount,
            recurring: { interval: 'month' },
          },
          quantity: 1,
        },
      ],
      subscription_data: {
        metadata: {
          userId: session.user.id,
          planId: plan.id,
          planName: plan.name,
          credits: plan.credits.toString(),
        },
      },
      metadata: {
        userId: session.user.id,
        planId: plan.id,
        type: 'subscription',
      },
      success_url: `${base}/account?payment=success`,
      cancel_url: `${base}/account?payment=cancelled`,
    });

    return Response.json({ url: checkoutSession.url });
  }

  return Response.json({ error: 'Invalid type' }, { status: 400 });
}
