import 'server-only';

import {
  extractApiKey,
  hashApiKey,
  hashesEqual,
  looksLikeApiKey,
} from './api-keys';
import { getActiveApiKeyByHash, touchApiKey } from './db/leak-queries';

export interface ApiKeyPrincipal {
  userId: string;
  apiKeyId: string;
}

/**
 * Authenticate an incoming /v1 request by its bearer API key. Returns the
 * owning principal, or null if the key is missing/malformed/unknown/revoked.
 * Never throws — callers turn null into a 401.
 */
export async function authenticateApiKey(
  request: Request,
): Promise<ApiKeyPrincipal | null> {
  const raw = extractApiKey(request);
  if (!raw || !looksLikeApiKey(raw)) return null;

  const keyHash = hashApiKey(raw);
  const row = await getActiveApiKeyByHash(keyHash).catch(() => null);
  if (!row) return null;

  // Defence in depth: the DB lookup already matched on hash, but re-verify in
  // constant time so a future non-unique lookup path can't leak via timing.
  if (!hashesEqual(row.keyHash, keyHash)) return null;

  // Fire-and-forget last-used stamp.
  void touchApiKey(row.id);

  return { userId: row.userId, apiKeyId: row.id };
}
