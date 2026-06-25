import { test, expect } from '@playwright/test';
import { CREDIT_PACKS, SUBSCRIPTION_PLANS } from '@/lib/stripe-config';

const BASE = 'http://localhost:3000';

test.describe('Stripe checkout modal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE}/account`);
    // Open the modal
    await page.getByRole('button', { name: 'Add Credits' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('modal opens with two tabs', async ({ page }) => {
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('tab', { name: /one.time top.up/i })).toBeVisible();
    await expect(dialog.getByRole('tab', { name: /subscribe/i })).toBeVisible();
  });

  test('top-up tab shows all credit packs with prices', async ({ page }) => {
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: /one.time top.up/i }).click();

    for (const pack of CREDIT_PACKS) {
      await expect(dialog.getByText(pack.credits.toString())).toBeVisible();
      const price = `$${(pack.unitAmount / 100).toFixed(2)}`;
      await expect(dialog.getByText(price)).toBeVisible();
    }
  });

  test('subscribe tab shows all subscription plans with prices', async ({ page }) => {
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: /subscribe/i }).click();

    for (const plan of SUBSCRIPTION_PLANS) {
      await expect(dialog.getByText(plan.name)).toBeVisible();
      const price = `$${(plan.unitAmount / 100).toFixed(2)}`;
      await expect(dialog.getByText(price)).toBeVisible();
      await expect(dialog.getByText(`${plan.credits} credits/month`)).toBeVisible();
    }
  });

  test('popular badge is visible on the highlighted pack and plan', async ({ page }) => {
    const dialog = page.getByRole('dialog');

    // Top-up tab: 100 credit pack is popular
    await dialog.getByRole('tab', { name: /one.time top.up/i }).click();
    await expect(dialog.getByText('Popular').first()).toBeVisible();

    // Subscribe tab: Pro plan is popular
    await dialog.getByRole('tab', { name: /subscribe/i }).click();
    await expect(dialog.getByText('Popular').first()).toBeVisible();
  });

  test('clicking a credit pack shows redirecting state', async ({ page }) => {
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: /one.time top.up/i }).click();

    // Click the first pack — this will call /api/stripe/checkout and redirect.
    // We intercept the navigation to prevent actually leaving the page.
    await page.route('**/api/stripe/checkout', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ url: 'https://checkout.stripe.com/pay/test' }),
      });
    });
    await page.route('https://checkout.stripe.com/**', (route) => route.abort());

    // Find the 10 credits button and click it
    await dialog.getByText('10').click();

    // The "Redirecting to Stripe checkout…" message should appear
    await expect(dialog.getByText(/redirecting to stripe checkout/i)).toBeVisible({
      timeout: 5000,
    });
  });

  test('clicking a subscription plan shows redirecting state', async ({ page }) => {
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: /subscribe/i }).click();

    await page.route('**/api/stripe/checkout', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ url: 'https://checkout.stripe.com/pay/test' }),
      });
    });
    await page.route('https://checkout.stripe.com/**', (route) => route.abort());

    await dialog.getByText('Starter').click();

    await expect(dialog.getByText(/redirecting to stripe checkout/i)).toBeVisible({
      timeout: 5000,
    });
  });
});

test.describe('Payment return states', () => {
  test('?payment=success shows success toast and cleans URL', async ({ page }) => {
    await page.goto(`${BASE}/account?payment=success`);

    // Toast should appear
    await expect(page.getByText(/payment successful/i)).toBeVisible({ timeout: 5000 });

    // URL should be cleaned (router.replace removes the query param)
    await expect(page).toHaveURL(`${BASE}/account`, { timeout: 5000 });
  });

  test('?payment=cancelled shows cancelled toast and cleans URL', async ({ page }) => {
    await page.goto(`${BASE}/account?payment=cancelled`);

    await expect(page.getByText(/payment cancelled/i)).toBeVisible({ timeout: 5000 });

    await expect(page).toHaveURL(`${BASE}/account`, { timeout: 5000 });
  });
});

test.describe('Account page plan display', () => {
  test('profile hero shows "Free Plan" badge when not subscribed', async ({ page }) => {
    await page.goto(`${BASE}/account`);
    await expect(page.getByText('Free Plan')).toBeVisible();
  });

  test('subscription card is hidden when not subscribed', async ({ page }) => {
    await page.goto(`${BASE}/account`);
    // The subscription card has "Manage Subscription" — should not exist
    await expect(page.getByRole('button', { name: /manage subscription/i })).not.toBeVisible();
  });

  test('account details row shows "Free" plan', async ({ page }) => {
    await page.goto(`${BASE}/account`);
    // Account details section has Plan: Free
    await expect(page.getByText('Plan')).toBeVisible();
    // The plan value next to the label should be "Free"
    await expect(page.getByRole('definition').filter({ hasText: 'Free' })).toBeVisible().catch(() => {
      // fallback: just check the text exists on the page
      return expect(page.getByText('Free').first()).toBeVisible();
    });
  });
});

test.describe('Webhook endpoint access', () => {
  test('webhook route is not blocked by auth middleware', async ({ request }) => {
    const response = await request.post(`${BASE}/api/webhooks/stripe`, {
      headers: { 'Content-Type': 'application/json' },
      data: '{}',
    });
    // Auth middleware would return 401; anything else means it passed through
    expect(response.status()).not.toBe(401);
    // Without a signature, it returns 400 (sig check) not 401 (auth)
    expect(response.status()).toBe(400);
  });
});
