import { auth } from '@/app/(auth)/auth';
import { stripe, appUrl } from '@/lib/stripe';
import { getStripeCustomerId } from '@/lib/db/queries';

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const customerId = await getStripeCustomerId({ userId: session.user.id });
  if (!customerId) {
    return Response.json({ error: 'No billing account found' }, { status: 404 });
  }

  try {
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appUrl()}/account`,
    });
    return Response.json({ url: portalSession.url });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[stripe/portal]', message);
    return Response.json({ error: message }, { status: 500 });
  }
}
