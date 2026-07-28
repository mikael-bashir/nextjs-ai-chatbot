import 'server-only';

import { createHash } from 'node:crypto';
import { sql } from '@vercel/postgres';

if (!process.env.POSTGRES_URL) {
  throw new Error('POSTGRES_URL environment variable is not set.');
}

// The Postgres-side twin of the bridge's proof bank (local-claude-bridge.mjs
// PROOF_BANK_PATH). Same reason, different host: a re-verify (river testing a
// theorem ultra already vetted) PATCHes the admin panel's generated-problem
// record in place — see updateGenerated() in lib/redis.ts — and a failed run
// overwrites the flat `verified`/`proof` fields with false/''. `certs[]`
// survives that PATCH untouched, but only items that were ALREADY re-verified
// on a second toolchain have a populated `certs[]`; a single-toolchain item
// (exactly what "prove on ultra, then try river once" produces) has none, so
// certsOrFallback() in admin-pipeline.tsx returns [] the moment the flat
// fields are blanked — the proof is gone from the UI's reach.
//
// So: every verified item's flat proof, AND every entry already in its
// certs[], is snapshotted here — append-only in spirit (upserted by the same
// (signature, toolchain) key as the bridge bank, never deleted) — before
// updateGenerated() is allowed to blank a verified record. Independent of
// whether the record's own certs[] happens to cover this toolchain.
let tableEnsured = false;
async function ensureTable(): Promise<void> {
  if (tableEnsured) return;
  await sql`
    CREATE TABLE IF NOT EXISTS "ProofBackup" (
      "signatureHash" varchar(40) NOT NULL,
      "toolchain" text NOT NULL,
      "name" text,
      "questionTitle" text,
      "lean" text,
      "proof" text NOT NULL,
      "strategy" text,
      "firstBackedUpAt" timestamp DEFAULT now() NOT NULL,
      "backedUpAt" timestamp DEFAULT now() NOT NULL,
      PRIMARY KEY ("signatureHash", "toolchain")
    );
  `;
  tableEnsured = true;
}

// Same identity rule as the bridge's proofBankKey: normalize whitespace, unify
// `lemma`/`theorem`, and key on the STATEMENT only (up to the first top-level
// `:=`), so a placeholder `sorry` body or a different proof text can never
// fork the key for what is the same theorem.
export function leanSignatureKey(lean: string): string {
  const src = String(lean || '');
  const m = /(?:theorem|lemma)\s+[A-Za-z_][A-Za-z0-9_'.]*/.exec(src);
  let head = m ? src.slice(m.index) : src;
  // Cut at the first top-level `:=` (binders/`let`/`have` inside the
  // signature are rare in these single-theorem statements; a plain scan is
  // enough here — worst case the key includes a stable trailing fragment,
  // which still normalizes identically for repeated saves of the same item).
  const bodyAt = head.indexOf(':=');
  if (bodyAt >= 0) head = head.slice(0, bodyAt);
  const norm = head
    .replace(/\s+/g, ' ')
    .replace(/^(?:theorem|lemma)\b/, 'theorem')
    .trim();
  return createHash('sha1').update(norm).digest('hex').slice(0, 16);
}

export interface ProofBackupEntry {
  signatureHash: string;
  toolchain: string;
  name: string | null;
  questionTitle: string | null;
  lean: string | null;
  proof: string;
  strategy: string | null;
  firstBackedUpAt: string;
  backedUpAt: string;
}

export async function backupProof(input: {
  lean: string;
  toolchain: string;
  proof: string;
  questionTitle?: string | null;
  strategy?: string | null;
}): Promise<{ backedUp: boolean; error?: string }> {
  if (!input.proof || !input.proof.trim() || !input.toolchain)
    return { backedUp: false, error: 'missing proof or toolchain' };
  try {
    await ensureTable();
    const signatureHash = leanSignatureKey(input.lean);
    const name =
      /(?:theorem|lemma)\s+([A-Za-z_][A-Za-z0-9_'.]*)/.exec(input.lean || '')?.[1] ?? null;
    // ON CONFLICT keeps firstBackedUpAt from the original row (provenance,
    // mirroring the bridge bank's firstProvedAt) while replacing the proof —
    // one row per (signature, toolchain), never a duplicate.
    await sql`
      INSERT INTO "ProofBackup"
        ("signatureHash", "toolchain", "name", "questionTitle", "lean", "proof", "strategy")
      VALUES
        (${signatureHash}, ${input.toolchain}, ${name}, ${input.questionTitle ?? null}, ${input.lean}, ${input.proof}, ${input.strategy ?? null})
      ON CONFLICT ("signatureHash", "toolchain") DO UPDATE SET
        "proof" = EXCLUDED."proof",
        "questionTitle" = EXCLUDED."questionTitle",
        "lean" = EXCLUDED."lean",
        "strategy" = EXCLUDED."strategy",
        "backedUpAt" = now()
    `;
    return { backedUp: true };
  } catch (e) {
    return { backedUp: false, error: String((e as Error)?.message || e) };
  }
}

export async function findProofBackup(
  lean: string,
  toolchain: string,
): Promise<ProofBackupEntry | null> {
  await ensureTable();
  const signatureHash = leanSignatureKey(lean);
  const { rows } = await sql`
    SELECT * FROM "ProofBackup"
    WHERE "signatureHash" = ${signatureHash} AND "toolchain" = ${toolchain}
    LIMIT 1
  `;
  return (rows[0] as unknown as ProofBackupEntry) ?? null;
}

export async function listProofBackups(): Promise<ProofBackupEntry[]> {
  await ensureTable();
  const { rows } = await sql`
    SELECT * FROM "ProofBackup" ORDER BY "backedUpAt" DESC
  `;
  return rows as unknown as ProofBackupEntry[];
}
