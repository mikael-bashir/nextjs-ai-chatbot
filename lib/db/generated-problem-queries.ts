import 'server-only';

import { sql as dsql } from 'drizzle-orm';
import { sql } from '@vercel/postgres';
import { drizzle } from 'drizzle-orm/vercel-postgres';
import { generatedProblem } from './schema';
import type { GeneratedProblem } from './schema';

if (!process.env.POSTGRES_URL) {
  throw new Error('POSTGRES_URL environment variable is not set.');
}

const schema = { generatedProblem };
const db = drizzle(sql, { schema });

// This deployment builds with a dummy POSTGRES_URL and starts with `node
// server.js` — it never runs `db:migrate`. Mirror the LocalClaudeAgentConfig
// approach: ensure the table exists on first use. Idempotent.
let tableEnsured = false;
async function ensureTable(): Promise<void> {
  if (tableEnsured) return;
  await db.execute(
    dsql.raw(`
      CREATE TABLE IF NOT EXISTS "GeneratedProblem" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "problemId" varchar(128),
        "questionTitle" text,
        "subtitle" text,
        "problem" text,
        "answer" text,
        "difficulty" varchar(32),
        "points" integer,
        "insight" text,
        "lean" text NOT NULL,
        "proof" text NOT NULL,
        "toolchain" varchar(128),
        "promotedAt" timestamp,
        "createdAt" timestamp DEFAULT now() NOT NULL
      );
    `),
  );
  tableEnsured = true;
}

export interface GeneratedProblemInput {
  problemId?: string | null;
  questionTitle?: string | null;
  subtitle?: string | null;
  problem?: string | null;
  answer?: number | string | null;
  difficulty?: string | null;
  points?: number | null;
  insight?: string | null;
  lean: string;
  proof: string;
  toolchain?: string | null;
  promotedAt?: Date | null;
}

// Case/whitespace-insensitive title key — matches normTitle() in redis.ts and
// admin-pipeline.tsx so promotion state joins consistently across stores.
function normTitle(s?: string | null): string {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// The DURABLE record of "promoted to prod": every promoted problem is archived
// here with a `promotedAt`, so this survives the CompeteMath cron draining the
// transient `weekly-problems` queue. This is the source of truth for the prod
// badge and the re-staging guard (the queue is NOT — it empties on publish).
export async function promotedTitles(): Promise<string[]> {
  await ensureTable();
  const { rows } = await sql`
    SELECT "questionTitle" FROM "GeneratedProblem"
    WHERE "promotedAt" IS NOT NULL AND "questionTitle" IS NOT NULL
  `;
  return rows
    .map((r) => (r as { questionTitle?: string }).questionTitle)
    .filter((t): t is string => !!t);
}

export async function hasPromotedTitle(
  title?: string | null,
): Promise<boolean> {
  const t = normTitle(title);
  if (!t) return false;
  const titles = await promotedTitles();
  return titles.some((x) => normTitle(x) === t);
}

export async function saveGeneratedProblem(
  input: GeneratedProblemInput,
): Promise<GeneratedProblem> {
  await ensureTable();
  const [row] = await db
    .insert(generatedProblem)
    .values({
      problemId: input.problemId ?? null,
      questionTitle: input.questionTitle ?? null,
      subtitle: input.subtitle ?? null,
      problem: input.problem ?? null,
      answer: input.answer == null ? null : String(input.answer),
      difficulty: input.difficulty ?? null,
      points: input.points ?? null,
      insight: input.insight ?? null,
      lean: input.lean,
      proof: input.proof,
      toolchain: input.toolchain ?? null,
      promotedAt: input.promotedAt ?? null,
    })
    .returning();
  return row;
}
