import { createHmac } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { CREDIT_PACKS, SUBSCRIPTION_PLANS } from '@/lib/stripe-config';

// This app uses Google OAuth — there is no email/password registration.
// All tests here use the `request` fixture (no browser, no auth session needed).
// Tests that require an authenticated session are marked skip with the reason below.
// To enable them: implement a test auth bypass or run with a real OAuth session.

const AUTH_SKIP = 'Requires authenticated session — app uses OAuth, no test user provisioning';
const LIVE_SKIP = 'Requires STRIPE_SECRET=sk_test_... (currently set to live key)';
const isTestMode = process.env.STRIPE_SECRET?.startsWith('sk_test_') ?? false;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const hasWebhookSecret =
  !!webhookSecret && webhookSecret !== 'whsec_your_webhook_secret_here';

// ─── /api/stripe/checkout ────────────────────────────────────────────────────

test.describe('/api/stripe/checkout', () => {
  test('unauthenticated request returns 401', async ({ request }) => {
    const res = await request.post('/api/stripe/checkout', {
      data: { type: 'one_time', credits: 10 },
    });
    expect(res.status()).toBe(401);
  });

  // The following validation tests reach the route only after auth passes.
  // They need a real authenticated session to return 400 instead of 401.
  test('invalid type returns 400 [needs auth session]', async ({ request }) => {
    test.skip(true, AUTH_SKIP);
    const res = await request.post('/api/stripe/checkout', {
      data: { type: 'unknown', credits: 10 },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  test('one_time with unknown credits returns 400 [needs auth session]', async ({ request }) => {
    test.skip(true, AUTH_SKIP);
    const res = await request.post('/api/stripe/checkout', {
      data: { type: 'one_time', credits: 999 },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/invalid credits/i);
  });

  test('subscription with unknown planId returns 400 [needs auth session]', async ({ request }) => {
    test.skip(true, AUTH_SKIP);
    const res = await request.post('/api/stripe/checkout', {
      data: { type: 'subscription', planId: 'nonexistent' },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/invalid plan/i);
  });

  for (const pack of CREDIT_PACKS) {
    test(`one_time ${pack.credits} credits → checkout URL [needs auth + test key]`, async ({
      request,
    }) => {
      test.skip(!isTestMode, LIVE_SKIP);
      test.skip(true, AUTH_SKIP);
      const res = await request.post('/api/stripe/checkout', {
        data: { type: 'one_time', credits: pack.credits },
      });
      expect(res.status()).toBe(200);
      expect((await res.json()).url).toContain('checkout.stripe.com');
    });
  }

  for (const plan of SUBSCRIPTION_PLANS) {
    test(`subscription planId=${plan.id} → checkout URL [needs auth + test key]`, async ({
      request,
    }) => {
      test.skip(!isTestMode, LIVE_SKIP);
      test.skip(true, AUTH_SKIP);
      const res = await request.post('/api/stripe/checkout', {
        data: { type: 'subscription', planId: plan.id },
      });
      expect(res.status()).toBe(200);
      expect((await res.json()).url).toContain('checkout.stripe.com');
    });
  }
});

// ─── /api/stripe/portal ──────────────────────────────────────────────────────

test.describe('/api/stripe/portal', () => {
  test('unauthenticated request returns 401', async ({ request }) => {
    const res = await request.post('/api/stripe/portal');
    expect(res.status()).toBe(401);
  });

  test('user without Stripe customer returns 404 [needs auth session]', async ({ request }) => {
    test.skip(true, AUTH_SKIP);
    const res = await request.post('/api/stripe/portal');
    expect([200, 404]).toContain(res.status());
  });
});

// ─── /api/webhooks/stripe ────────────────────────────────────────────────────

test.describe('/api/webhooks/stripe', () => {
  test('accessible without authentication — not blocked by auth middleware', async ({
    request,
  }) => {
    const res = await request.post('/api/webhooks/stripe', {
      headers: { 'Content-Type': 'application/json' },
      data: '{}',
    });
    expect(res.status()).not.toBe(401);
  });

  test('missing stripe-signature header returns 400', async ({ request }) => {
    const res = await request.post('/api/webhooks/stripe', {
      headers: { 'Content-Type': 'application/json' },
      data: '{}',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/signature/i);
  });

  test('invalid stripe-signature returns 400', async ({ request }) => {
    const res = await request.post('/api/webhooks/stripe', {
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': 't=12345,v1=invalidsignature',
      },
      data: JSON.stringify({ type: 'checkout.session.completed' }),
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/signature/i);
  });

  test('valid HMAC signature → 200 {received: true}', async ({ request }) => {
    test.skip(!hasWebhookSecret, 'Set STRIPE_WEBHOOK_SECRET to a real whsec_... to run');

    const timestamp = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      id: 'evt_test_noop',
      type: 'payment_intent.created', // unhandled event — just tests routing
      data: { object: {} },
    });
    // Stripe uses the raw whsec_... string directly as the HMAC key (no decoding)
    const sig = createHmac('sha256', webhookSecret!)
      .update(`${timestamp}.${payload}`)
      .digest('hex');

    const res = await request.post('/api/webhooks/stripe', {
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': `t=${timestamp},v1=${sig}`,
      },
      data: payload,
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).received).toBe(true);
  });
});
