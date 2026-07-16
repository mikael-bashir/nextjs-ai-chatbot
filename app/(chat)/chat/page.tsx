import { cookies } from 'next/headers';

import { Chat } from '@/components/chat';
import { DEFAULT_CHAT_MODEL } from '@/lib/ai/models';
import { generateUUID } from '@/lib/utils';
import { DataStreamHandler } from '@/components/data-stream-handler';

// Legacy chat entry point. The product home ("/") is now the Leak API landing;
// the chatbot lives on here at /chat and is slated for removal in a later pass.
export default async function Page() {
  const cookieStore = await cookies();
  const modelIdFromCookie = cookieStore.get('chat-model');
  const id = generateUUID();

  return (
    <>
      <Chat
        key={id}
        id={id}
        initialMessages={[]}
        selectedChatModel={modelIdFromCookie?.value ?? DEFAULT_CHAT_MODEL}
        selectedVisibilityType="private"
        isReadonly={false}
      />
      <DataStreamHandler id={id} />
    </>
  );
}
