import { generateUUID } from '@/lib/utils';
import { expect, test } from '../fixtures';
import { TEST_PROMPTS } from '../prompts/routes';

const chatIdsCreatedByAda: Array<string> = [];

test.describe
  .serial('/api/chat', () => {
    test('Ada cannot invoke a chat generation with empty request body', async ({
      adaContext,
    }) => {
      const response = await adaContext.request.post('/api/chat', {
        data: {},
      });
      expect(response.status()).toBe(500);

      const text = await response.text();
      expect(text).toEqual('An error occurred while processing your request!');
    });

    test('Ada can invoke chat generation', async ({ adaContext, request }) => {
      // Quick smoke check: send a tiny request and expect a streaming response
      // within 5s. If Python/xAI keys are unavailable, skip gracefully.
      const agentReachable = await request
        .post('http://localhost:5328/api/chat/agent', {
          headers: { 'Content-Type': 'application/json' },
          data: { messages: [{ role: 'user', content: 'hi' }], model: 'grok-free-pool', id: 'probe' },
          timeout: 5000,
        })
        .then((r: { status: () => number }) => r.status() < 500)
        .catch(() => false);
      test.skip(!agentReachable, 'Requires Python service with working xAI free key');

      const chatId = generateUUID();

      const response = await adaContext.request.post('api/chat', {
        data: {
          id: chatId,
          messages: TEST_PROMPTS.SKY.MESSAGES,
          selectedChatModel: 'grok-free-pool',
        },
      });

      // The route streams Python SSE — just verify it accepted the request
      expect([200, 429]).toContain(response.status());

      chatIdsCreatedByAda.push(chatId);
    });

    test("Babbage cannot append message to Ada's chat", async ({
      babbageContext,
    }) => {
      const [chatId] = chatIdsCreatedByAda;

      if (!chatId) {
        test.skip(true, 'Skipped: no chat was created (Python may be down)');
        return;
      }

      const response = await babbageContext.request.post('api/chat', {
        data: {
          id: chatId,
          messages: TEST_PROMPTS.GRASS.MESSAGES,
          selectedChatModel: 'grok-free-pool',
        },
      });
      expect(response.status()).toBe(403);

      const text = await response.text();
      expect(text).toEqual('Forbidden');
    });

    test("Babbage cannot delete Ada's chat", async ({ babbageContext }) => {
      const [chatId] = chatIdsCreatedByAda;

      if (!chatId) {
        test.skip(true, 'Skipped: no chat was created (Python may be down)');
        return;
      }

      const response = await babbageContext.request.delete(
        `api/chat?id=${chatId}`,
      );
      expect(response.status()).toBe(403);

      const text = await response.text();
      expect(text).toEqual('Forbidden');
    });

    test('Ada can delete her own chat', async ({ adaContext }) => {
      const [chatId] = chatIdsCreatedByAda;

      if (!chatId) {
        test.skip(true, 'Skipped: no chat was created (Python may be down)');
        return;
      }

      const response = await adaContext.request.delete(`api/chat?id=${chatId}`);
      expect(response.status()).toBe(200);

      const deletedChat = await response.json();
      expect(deletedChat).toMatchObject({ id: chatId });
    });
  });
