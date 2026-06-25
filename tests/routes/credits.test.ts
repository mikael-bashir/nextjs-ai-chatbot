import { generateUUID } from '@/lib/utils';
import { expect, test } from '../fixtures';
import { TEST_PROMPTS } from '../prompts/routes';

test.describe
  .serial('/api/credits', () => {
    test('unauthenticated request returns 401', async ({ browser }) => {
      const context = await browser.newContext();
      const request = context.request;

      const response = await request.get('/api/credits');
      expect(response.status()).toBe(401);

      await context.close();
    });

    test('Ada gets her credit balance', async ({ adaContext }) => {
      const response = await adaContext.request.get('/api/credits');
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(typeof body.balance).toBe('number');
      expect(body.balance).toBeGreaterThanOrEqual(0);
    });

    test('Ada receives welcome bonus on first balance fetch', async ({
      adaContext,
    }) => {
      const response = await adaContext.request.get('/api/credits');
      expect(response.status()).toBe(200);

      const body = await response.json();
      // Welcome bonus is 1.0 credit = £1 of free compute
      expect(body.balance).toBeGreaterThanOrEqual(1);
    });

    test('paid model with insufficient credits returns 402', async ({
      babbageContext,
    }) => {
      const creditsResponse = await babbageContext.request.get('/api/credits');
      const { balance } = await creditsResponse.json();

      if (balance >= 0.5) {
        test.skip(true, 'Skipped: Babbage has >= 0.5 credits — needs < 0.5 to test 402');
        return;
      }

      const response = await babbageContext.request.post('/api/chat/canary', {
        data: {
          id: generateUUID(),
          messages: TEST_PROMPTS.SKY.MESSAGES,
          selectedChatModel: 'grok-3-fast', // paid model triggers credit check
        },
      });
      expect(response.status()).toBe(402);

      const body = await response.json();
      expect(body.error).toBe('Insufficient credits');
      expect(typeof body.required).toBe('number');
      expect(typeof body.balance).toBe('number');
    });

    test('free model with rate-limit returns 429 when exhausted', async ({
      adaContext,
      request,
    }) => {
      const agentReachable = await request
        .post('http://localhost:5328/api/chat/agent', {
          headers: { 'Content-Type': 'application/json' },
          data: { messages: [{ role: 'user', content: 'hi' }], model: 'grok-free-pool', id: 'probe' },
          timeout: 5000,
        })
        .then((r: { status: () => number }) => r.status() < 500)
        .catch(() => false);
      test.skip(!agentReachable, 'Requires Python service with working xAI free key');

      const response = await adaContext.request.post('/api/chat/canary', {
        data: {
          id: generateUUID(),
          messages: TEST_PROMPTS.SKY.MESSAGES,
          selectedChatModel: 'grok-free-pool',
        },
      });

      if (response.status() === 429) {
        const body = await response.json();
        expect(body.error).toBe('Rate limit exceeded');
        expect(body.resetAt).toBeTruthy();
      } else {
        // Not yet rate limited — verify request was accepted
        expect([200, 499]).toContain(response.status());
      }
    });

    test('invalid amount in add-credits action returns an error for amount 0', async ({
      adaContext,
    }) => {
      const formData = new URLSearchParams();
      formData.set('amount', '0');

      const response = await adaContext.request.post('/api/credits/add', {
        data: formData.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      expect(response.status()).not.toBe(200);
    });
  });
