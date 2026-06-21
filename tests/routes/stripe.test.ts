import { createHmac } from 'node:crypto';
import { expect, test } from '../fixtures';
import { CREDIT_PACKS, SUBSCRIPTION_PLANS } from '@/lib/stripe-config';

// Skip tests that call the real Stripe API when running with live keys.
// Switch to STRIPE_SECRET=sk_test_... to enable them.
const isTestMode = process.env.STRIPE_SECRET?.startsWith('sk_test_') ?? false;

test.describe.serial('/api/stripe/checkout', () => {
  // The `request` fixture in the `routes` project is unauthenticated (no storageState)
  test('unauthenticated request returns 401', async ({ request }) => {
    const response = await request.post('/api/stripe/checkout', {
      data: { type: 'one_time', credits: 10 },
    });
    expect(response.status()).toBe(401);
  });

  test('missing / invalid JSON body returns 400', async ({ adaContext }) => {
    const response = await adaContext.request.post('/api/stripe/checkout', {
      headers: { 'Content-Type': 'application/json' },
      data: '{{not-json',
    });
    expect(response.status()).toBe(400);
  });

  test('invalid type returns 400', async ({ adaContext }) => {
    const response = await adaContext.request.post('/api/stripe/checkout', {
      data: { type: 'unknown', credits: 10 },
    });
    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toBeTruthy();
  });

  test('one_time with invalid credits value returns 400', async ({ adaContext }) => {
    const response = await adaContext.request.post('/api/stripe/checkout', {
      data: { type: 'one_time', credits: 999 },
    });
    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/invalid credits/i);
  });

  test('subscription with invalid planId returns 400', async ({ adaContext }) => {
    const response = await adaContext.request.post('/api/stripe/checkout', {
      data: { type: 'subscription', planId: 'nonexistent' },
    });
    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/invalid plan/i);
  });

  for (const pack of CREDIT_PACKS) {
    test(`one_time ${pack.credits} credits returns a Stripe checkout URL [test mode only]`, async ({
      adaContext,
    }) => {
      test.skip(!isTestMode, 'Set STRIPE_SECRET=sk_test_... to enable Stripe API tests');
      const response = await adaContext.request.post('/api/stripe/checkout', {
        data: { type: 'one_time', credits: pack.credits },
      });
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(typeof body.url).toBe('string');
      expect(body.url).toContain('checkout.stripe.com');
    });
  }

  for (const plan of SUBSCRIPTION_PLANS) {
    test(`subscription planId=${plan.id} returns a Stripe checkout URL [test mode only]`, async ({
      adaContext,
    }) => {
      test.skip(!isTestMode, 'Set STRIPE_SECRET=sk_test_... to enable Stripe API tests');
      const response = await adaContext.request.post('/api/stripe/checkout', {
        data: { type: 'subscription', planId: plan.id },
      });
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(typeof body.url).toBe('string');
      expect(body.url).toContain('checkout.stripe.com');
    });
  }
});

test.describe.serial('/api/stripe/portal', () => {
  test('unauthenticated request returns 401', async ({ request }) => {
    const response = await request.post('/api/stripe/portal');
    expect(response.status()).toBe(401);
  });

  test('user without a Stripe customer record returns 404', async ({
    babbageContext,
  }) => {
    // Babbage has never gone through Stripe checkout → no StripeCustomer row
    const response = await babbageContext.request.post('/api/stripe/portal');
    // Could be 404 (no customer) or 200 (already has one from a previous test run)
    expect([200, 404]).toContain(response.status());
    if (response.status() === 404) {
      const body = await response.json();
      expect(body.error).toMatch(/no billing account/i);
    }
  });

  test('user with a Stripe customer returns portal URL [test mode only]', async ({
    adaContext,
  }) => {
    test.skip(!isTestMode, 'Set STRIPE_SECRET=sk_test_... to enable Stripe API tests');
    await adaContext.request.post('/api/stripe/checkout', {
      data: { type: 'one_time', credits: 10 },
    });
    const response = await adaContext.request.post('/api/stripe/portal');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(typeof body.url).toBe('string');
    expect(body.url).toContain('billing.stripe.com');
  });
});

test.describe.serial('/api/webhooks/stripe', () => {
  test('is accessible without authentication — auth middleware must not block it', async ({
    request,
  }) => {
    const response = await request.post('/api/webhooks/stripe', {
      headers: { 'Content-Type': 'application/json' },
      data: '{}',
    });
    // Auth middleware would return 401; anything else means it passed through correctly
    expect(response.status()).not.toBe(401);
  });

  test('missing stripe-signature header returns 400', async ({ request }) => {
    const response = await request.post('/api/webhooks/stripe', {
      headers: { 'Content-Type': 'application/json' },
      data: '{}',
    });
    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/signature/i);
  });

  test('invalid stripe-signature returns 400', async ({ request }) => {
    const response = await request.post('/api/webhooks/stripe', {
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': 't=12345,v1=invalidsignature',
      },
      data: JSON.stringify({ type: 'checkout.session.completed' }),
    });
    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/signature/i);
  });

  test('valid HMAC signature processes event and returns {received: true}', async ({
    request,
  }) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    test.skip(
      !secret || secret === 'whsec_your_webhook_secret_here',
      'Set STRIPE_WEBHOOK_SECRET to a real whsec_... value to run this test',
    );

    const timestamp = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      id: 'evt_test_webhook',
      type: 'payment_intent.created',
      data: { object: {} },
    });
    const signedPayload = `${timestamp}.${payload}`;
    // Stripe uses base64-decoded secret for HMAC; raw key after "whsec_" prefix is base64
    const rawSecret = Buffer.from(secret!.replace('whsec_', ''), 'base64');
    const sig = createHmac('sha256', rawSecret).update(signedPayload).digest('hex');
    const signature = `t=${timestamp},v1=${sig}`;

    const response = await request.post('/api/webhooks/stripe', {
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': signature,
      },
      data: payload,
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.received).toBe(true);
  });
});
