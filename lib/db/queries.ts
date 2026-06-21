import 'server-only';

import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  type SQL,
} from 'drizzle-orm';

// import { drizzle } from 'drizzle-orm/postgres-js';
// import postgres from 'postgres';

import { sql } from '@vercel/postgres'; // Vercel's SDK
// Use the Neon HTTP adapter which is suitable for serverless
import { drizzle } from 'drizzle-orm/vercel-postgres';

import {
  user,
  chat,
  type User,
  document,
  type Suggestion,
  suggestion,
  message,
  vote,
  type DBMessage,
  type Chat,
  userCredits,
  creditTransactions,
  type UserCredits,
  type CreditTransaction,
} from './schema';

import type { ArtifactKind } from '@/components/artifact';

if (!process.env.POSTGRES_URL) {
  throw new Error('POSTGRES_URL environment variable is not set.');
}

const schema = {
  user,
  chat,
  document,
  suggestion,
  message,
  vote,
  userCredits,
  creditTransactions,
}

const db = drizzle(sql, { schema });

export async function getUser(email: string): Promise<Array<User>> {
  try {
    return await db.select().from(user).where(eq(user.email, email));
  } catch (error) {
    console.error('Failed to get user from database');
    throw error;
  }
}

// export async function createUser(email: string, password: string) {
//   const hashedPassword = generateHashedPassword(password);

//   try {
//     return await db.insert(user).values({ email, password: hashedPassword });
//   } catch (error) {
//     console.error('Failed to create user in database');
//     throw error;
//   }
// }

export async function saveChat({
  id,
  userId,
  title,
}: {
  id: string;
  userId: string;
  title: string;
}) {
  try {
    return await db.insert(chat).values({
      id,
      createdAt: new Date(),
      userId,
      title,
    });
  } catch (error) {
    console.error('Failed to save chat in database.', error);
    throw error;
  }
}

export async function leakAccountProvisioned({
  id
}: {
  id: string;
}) {
  return await db.query.user.findFirst({
    where: eq(user.id, id)
  });
}

export async function provisionLeakUser({
  id,
  email,
}: {
  id: string;
  email: string;
}) {
  try {
    // onConflictDoNothing prevents 500 errors if a user accidentally 
    // double-clicks the "Complete Setup" button in the modal.
    return await db.insert(user)
      .values({
        id,
        email,
        // Add any other default fields your schema requires here (e.g., createdAt: new Date())
      })
      .onConflictDoNothing({ target: user.id }); 
  } catch (error) {
    console.error('Failed to provision user in database', error);
    throw error;
  }
}

export async function deleteChatById({ id }: { id: string }) {
  try {
    await db.delete(vote).where(eq(vote.chatId, id));
    await db.delete(message).where(eq(message.chatId, id));

    const [chatsDeleted] = await db
      .delete(chat)
      .where(eq(chat.id, id))
      .returning();
    return chatsDeleted;
  } catch (error) {
    console.error('Failed to delete chat by id from database');
    throw error;
  }
}

export async function getChatsByUserId({
  id,
  limit,
  startingAfter,
  endingBefore,
}: {
  id: string;
  limit: number;
  startingAfter: string | null;
  endingBefore: string | null;
}) {
  try {
    const extendedLimit = limit + 1;

    const query = (whereCondition?: SQL<any>) =>
      db
        .select()
        .from(chat)
        .where(
          whereCondition
            ? and(whereCondition, eq(chat.userId, id))
            : eq(chat.userId, id),
        )
        .orderBy(desc(chat.createdAt))
        .limit(extendedLimit);

    let filteredChats: Array<Chat> = [];

    if (startingAfter) {
      const [selectedChat] = await db
        .select()
        .from(chat)
        .where(eq(chat.id, startingAfter))
        .limit(1);

      if (!selectedChat) {
        throw new Error(`Chat with id ${startingAfter} not found`);
      }

      filteredChats = await query(gt(chat.createdAt, selectedChat.createdAt));
    } else if (endingBefore) {
      const [selectedChat] = await db
        .select()
        .from(chat)
        .where(eq(chat.id, endingBefore))
        .limit(1);

      if (!selectedChat) {
        throw new Error(`Chat with id ${endingBefore} not found`);
      }

      filteredChats = await query(lt(chat.createdAt, selectedChat.createdAt));
    } else {
      filteredChats = await query();
    }

    const hasMore = filteredChats.length > limit;

    return {
      chats: hasMore ? filteredChats.slice(0, limit) : filteredChats,
      hasMore,
    };
  } catch (error) {
    console.error('Failed to get chats by user from database');
    throw error;
  }
}

export async function getChatById({ id }: { id: string }) {
  try {
    const [selectedChat] = await db.select().from(chat).where(eq(chat.id, id));
    return selectedChat;
  } catch (error) {
    console.error('Failed to get chat by id from database');
    throw error;
  }
}

export async function saveMessages({
  messages,
}: {
  messages: Array<DBMessage>;
}) {
  try {
    return await db.insert(message).values(messages);
  } catch (error) {
    console.error('Failed to save messages in database', error);
    throw error;
  }
}

export async function getMessagesByChatId({ id }: { id: string }) {
  try {
    return await db
      .select()
      .from(message)
      .where(eq(message.chatId, id))
      .orderBy(asc(message.createdAt));
  } catch (error) {
    console.error('Failed to get messages by chat id from database', error);
    throw error;
  }
}

export async function voteMessage({
  chatId,
  messageId,
  type,
}: {
  chatId: string;
  messageId: string;
  type: 'up' | 'down';
}) {
  try {
    const [existingVote] = await db
      .select()
      .from(vote)
      .where(and(eq(vote.messageId, messageId)));

    if (existingVote) {
      return await db
        .update(vote)
        .set({ isUpvoted: type === 'up' })
        .where(and(eq(vote.messageId, messageId), eq(vote.chatId, chatId)));
    }
    return await db.insert(vote).values({
      chatId,
      messageId,
      isUpvoted: type === 'up',
    });
  } catch (error) {
    console.error('Failed to upvote message in database', error);
    throw error;
  }
}

export async function getVotesByChatId({ id }: { id: string }) {
  try {
    return await db.select().from(vote).where(eq(vote.chatId, id));
  } catch (error) {
    console.error('Failed to get votes by chat id from database', error);
    throw error;
  }
}

export async function saveDocument({
  id,
  title,
  kind,
  content,
  userId,
}: {
  id: string;
  title: string;
  kind: ArtifactKind;
  content: string;
  userId: string;
}) {
  try {
    return await db
      .insert(document)
      .values({
        id,
        title,
        kind,
        content,
        userId,
        createdAt: new Date(),
      })
      .returning();
  } catch (error) {
    console.error('Failed to save document in database');
    throw error;
  }
}

export async function getDocumentsById({ id }: { id: string }) {
  try {
    const documents = await db
      .select()
      .from(document)
      .where(eq(document.id, id))
      .orderBy(asc(document.createdAt));

    return documents;
  } catch (error) {
    console.error('Failed to get document by id from database');
    throw error;
  }
}

export async function getDocumentById({ id }: { id: string }) {
  try {
    const [selectedDocument] = await db
      .select()
      .from(document)
      .where(eq(document.id, id))
      .orderBy(desc(document.createdAt));

    return selectedDocument;
  } catch (error) {
    console.error('Failed to get document by id from database');
    throw error;
  }
}

export async function deleteDocumentsByIdAfterTimestamp({
  id,
  timestamp,
}: {
  id: string;
  timestamp: Date;
}) {
  try {
    await db
      .delete(suggestion)
      .where(
        and(
          eq(suggestion.documentId, id),
          gt(suggestion.documentCreatedAt, timestamp),
        ),
      );

    return await db
      .delete(document)
      .where(and(eq(document.id, id), gt(document.createdAt, timestamp)))
      .returning();
  } catch (error) {
    console.error(
      'Failed to delete documents by id after timestamp from database',
    );
    throw error;
  }
}

export async function saveSuggestions({
  suggestions,
}: {
  suggestions: Array<Suggestion>;
}) {
  try {
    return await db.insert(suggestion).values(suggestions);
  } catch (error) {
    console.error('Failed to save suggestions in database');
    throw error;
  }
}

export async function getSuggestionsByDocumentId({
  documentId,
}: {
  documentId: string;
}) {
  try {
    return await db
      .select()
      .from(suggestion)
      .where(and(eq(suggestion.documentId, documentId)));
  } catch (error) {
    console.error(
      'Failed to get suggestions by document version from database',
    );
    throw error;
  }
}

export async function getMessageById({ id }: { id: string }) {
  try {
    return await db.select().from(message).where(eq(message.id, id));
  } catch (error) {
    console.error('Failed to get message by id from database');
    throw error;
  }
}

export async function deleteMessagesByChatIdAfterTimestamp({
  chatId,
  timestamp,
}: {
  chatId: string;
  timestamp: Date;
}) {
  try {
    const messagesToDelete = await db
      .select({ id: message.id })
      .from(message)
      .where(
        and(eq(message.chatId, chatId), gte(message.createdAt, timestamp)),
      );

    const messageIds = messagesToDelete.map((message) => message.id);

    if (messageIds.length > 0) {
      await db
        .delete(vote)
        .where(
          and(eq(vote.chatId, chatId), inArray(vote.messageId, messageIds)),
        );

      return await db
        .delete(message)
        .where(
          and(eq(message.chatId, chatId), inArray(message.id, messageIds)),
        );
    }
  } catch (error) {
    console.error(
      'Failed to delete messages by id after timestamp from database',
    );
    throw error;
  }
}

export async function updateChatVisiblityById({
  chatId,
  visibility,
}: {
  chatId: string;
  visibility: 'private' | 'public';
}) {
  try {
    return await db.update(chat).set({ visibility }).where(eq(chat.id, chatId));
  } catch (error) {
    console.error('Failed to update chat visibility in database');
    throw error;
  }
}

export async function getCreditBalance({
  userId,
}: {
  userId: string;
}): Promise<UserCredits | null> {
  try {
    const [row] = await db
      .select()
      .from(userCredits)
      .where(eq(userCredits.userId, userId));
    return row ?? null;
  } catch (error) {
    console.error('Failed to get credit balance from database');
    throw error;
  }
}

export async function getOrCreateCreditBalance({
  userId,
}: {
  userId: string;
}): Promise<number> {
  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(userCredits)
        .where(eq(userCredits.userId, userId));

      if (existing) return existing.balance;

      await tx.insert(userCredits).values({
        userId,
        balance: 100,
        updatedAt: new Date(),
      });

      await tx.insert(creditTransactions).values({
        userId,
        amount: 100,
        type: 'grant',
        description: 'Welcome bonus',
        createdAt: new Date(),
      });

      return 100;
    });
  } catch (error) {
    console.error('Failed to get or create credit balance in database');
    throw error;
  }
}

export async function getEarliestCreditTransaction({
  userId,
}: {
  userId: string;
}): Promise<CreditTransaction | null> {
  try {
    const [row] = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, userId))
      .orderBy(asc(creditTransactions.createdAt))
      .limit(1);
    return row ?? null;
  } catch (error) {
    console.error('Failed to get earliest credit transaction from database');
    throw error;
  }
}

export async function getCreditTransactions({
  userId,
  limit,
  offset,
}: {
  userId: string;
  limit: number;
  offset: number;
}): Promise<Array<CreditTransaction>> {
  try {
    return await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, userId))
      .orderBy(desc(creditTransactions.createdAt))
      .limit(limit)
      .offset(offset);
  } catch (error) {
    console.error('Failed to get credit transactions from database');
    throw error;
  }
}

export async function addCredits({
  userId,
  amount,
  description,
  type = 'grant',
}: {
  userId: string;
  amount: number;
  description: string;
  type?: 'purchase' | 'grant';
}): Promise<number> {
  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ balance: userCredits.balance })
        .from(userCredits)
        .where(eq(userCredits.userId, userId));

      let newBalance: number;

      if (existing) {
        newBalance = existing.balance + amount;
        await tx
          .update(userCredits)
          .set({ balance: newBalance, updatedAt: new Date() })
          .where(eq(userCredits.userId, userId));
      } else {
        newBalance = amount;
        await tx.insert(userCredits).values({
          userId,
          balance: newBalance,
          updatedAt: new Date(),
        });
      }

      await tx.insert(creditTransactions).values({
        userId,
        amount,
        type,
        description,
        createdAt: new Date(),
      });

      return newBalance;
    });
  } catch (error) {
    console.error('Failed to add credits in database');
    throw error;
  }
}

export async function deductCredits({
  userId,
  amount,
  description,
}: {
  userId: string;
  amount: number;
  description: string;
}): Promise<number> {
  try {
    return await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ balance: userCredits.balance })
        .from(userCredits)
        .where(eq(userCredits.userId, userId));

      if (!current) throw new Error('Credit account not found');
      if (current.balance < amount) throw new Error('Insufficient credits');

      const newBalance = current.balance - amount;

      await tx
        .update(userCredits)
        .set({ balance: newBalance, updatedAt: new Date() })
        .where(eq(userCredits.userId, userId));

      await tx.insert(creditTransactions).values({
        userId,
        amount: -amount,
        type: 'usage',
        description,
        createdAt: new Date(),
      });

      return newBalance;
    });
  } catch (error) {
    console.error('Failed to deduct credits in database');
    throw error;
  }
}
