import 'server-only';

import { and, count, eq, gte } from 'drizzle-orm';
import { sql } from '@vercel/postgres';
import { drizzle } from 'drizzle-orm/vercel-postgres';

import { creditTransactions } from './db/schema';

const db = drizzle(sql);

const RATE_LIMIT = 20;
const WINDOW_MS = 60 * 60 * 1000;

export async function checkRateLimit({ userId }: { userId: string }): Promise<{
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}> {
  const windowStart = new Date(Date.now() - WINDOW_MS);
  const resetAt = new Date(windowStart.getTime() + WINDOW_MS);

  const [result] = await db
    .select({ count: count() })
    .from(creditTransactions)
    .where(
      and(
        eq(creditTransactions.userId, userId),
        eq(creditTransactions.type, 'usage'),
        gte(creditTransactions.createdAt, windowStart),
      ),
    );

  const used = Number(result?.count ?? 0);
  const remaining = Math.max(0, RATE_LIMIT - used);
  const allowed = used < RATE_LIMIT;

  return { allowed, remaining, resetAt };
}
