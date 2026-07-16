import 'server-only';

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Public, non-secret scheme prefix. Lets us (and users) recognise a Leak key at
// a glance and makes secret-scanning tooling greppable.
export const API_KEY_SCHEME = 'leak_sk_';

// Length (in bytes) of the random secret material. 24 bytes → 48 hex chars,
// ~192 bits of entropy, which is plenty for a bearer credential.
const SECRET_BYTES = 24;

export interface GeneratedApiKey {
  /** The full plaintext key. Shown to the user exactly once, never stored. */
  plaintext: string;
  /** SHA-256 (hex) of the plaintext — this is what we persist. */
  keyHash: string;
  /** Non-secret display prefix for the dashboard list, e.g. "leak_sk_1a2b3c…". */
  prefix: string;
}

/** Create a fresh API key: the plaintext (to show once), its hash, and a prefix. */
export function generateApiKey(): GeneratedApiKey {
  const plaintext = API_KEY_SCHEME + randomBytes(SECRET_BYTES).toString('hex');
  return {
    plaintext,
    keyHash: hashApiKey(plaintext),
    prefix: displayPrefix(plaintext),
  };
}

/** Stable SHA-256 (hex) of a key. Deterministic so we can look up by hash. */
export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/** First few chars after the scheme, for a masked display like "leak_sk_1a2b3c…". */
export function displayPrefix(plaintext: string): string {
  return `${plaintext.slice(0, API_KEY_SCHEME.length + 6)}…`;
}

/** Constant-time compare of two hex hashes (defence in depth). */
export function hashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Pull the bearer credential out of a request. Accepts either the standard
 * `Authorization: Bearer <key>` header or a bare `x-api-key: <key>` header so
 * curl one-liners are easy to write.
 */
export function extractApiKey(request: Request): string | null {
  const auth = request.headers.get('authorization');
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1].trim();
  }
  const header = request.headers.get('x-api-key');
  if (header) return header.trim();
  return null;
}

/** Shape it looks like a Leak key at all (cheap reject before hashing/DB). */
export function looksLikeApiKey(candidate: string): boolean {
  return (
    candidate.startsWith(API_KEY_SCHEME) &&
    candidate.length === API_KEY_SCHEME.length + SECRET_BYTES * 2
  );
}
