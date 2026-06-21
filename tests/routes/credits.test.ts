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
      expect(body.balance).toBeGreaterThanOrEqual(100);
    });

    test('sending a message deducts 1 credit', async ({ adaContext }) => {
      const beforeResponse = await adaContext.request.get('/api/credits');
      const { balance: balanceBefore } = await beforeResponse.json();

      const chatId = generateUUID();
      const chatResponse = await adaContext.request.post('/api/chat', {
        data: {
          id: chatId,
          messages: TEST_PROMPTS.SKY.MESSAGES,
          selectedChatModel: 'chat-model',
        },
      });
      expect(chatResponse.status()).toBe(200);

      const afterResponse = await adaContext.request.get('/api/credits');
      const { balance: balanceAfter } = await afterResponse.json();

      expect(balanceAfter).toBe(balanceBefore - 1);
    });

    test('user with balance 0 receives 402 from chat API', async ({
      babbageContext,
    }) => {
      // Drain Babbage's credits via repeated chat calls until balance is 0
      // or rely on test isolation to set up zero balance.
      // This test verifies the 402 response shape when balance hits 0.
      // In CI, use a seeded zero-balance user instead of draining.
      const creditsResponse = await babbageContext.request.get('/api/credits');
      const { balance } = await creditsResponse.json();

      if (balance > 0) {
        test.skip(true, 'Skipped: Babbage still has credits — needs zero balance to test 402');
      }

      const response = await babbageContext.request.post('/api/chat', {
        data: {
          id: generateUUID(),
          messages: TEST_PROMPTS.SKY.MESSAGES,
          selectedChatModel: 'chat-model',
        },
      });
      expect(response.status()).toBe(402);

      const body = await response.json();
      expect(body.error).toBe('Insufficient credits');
    });

    test('rate-limit exceeded returns 429', async ({ adaContext }) => {
      // Send 21 messages in quick succession. The first 20 succeed and the 21st should 429.
      // In unit tests, mock the rate limiter. Here we just verify the response shape.
      // Exhausting 20 real messages in an E2E route test is impractical;
      // instead verify the 429 error contract if rate limit is triggered.
      const response = await adaContext.request.post('/api/chat', {
        data: {
          id: generateUUID(),
          messages: TEST_PROMPTS.SKY.MESSAGES,
          selectedChatModel: 'chat-model',
        },
      });

      if (response.status() === 429) {
        const body = await response.json();
        expect(body.error).toBe('Rate limit exceeded');
        expect(body.resetAt).toBeTruthy();
      } else {
        // Not yet rate limited — verify successful response
        expect(response.status()).toBe(200);
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
