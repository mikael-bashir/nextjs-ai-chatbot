import { auth } from '@/app/(auth)/auth';
import { generateApiKey } from '@/lib/api-keys';
import { createApiKey, listApiKeys } from '@/lib/db/leak-queries';
import type { ApiKey } from '@/lib/db/schema';


// Never send the hash to the browser. This is the safe list-view of a key.
function safeView(k: ApiKey) {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    lastUsedAt: k.lastUsedAt,
    createdAt: k.createdAt,
  };
}

// GET /api/keys — list this user's active keys (no secrets).
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const keys = await listApiKeys({ userId: session.user.id });
  return Response.json({ keys: keys.map(safeView) });
}

// POST /api/keys — mint a new key. The plaintext is returned exactly once here
// and never stored; the client must show it to the user immediately.
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  let name = 'default';
  try {
    const body = await request.json();
    if (typeof body?.name === 'string' && body.name.trim()) {
      name = body.name.trim().slice(0, 64);
    }
  } catch {
    /* empty body is fine — use default name */
  }

  const generated = generateApiKey();
  const row = await createApiKey({
    userId: session.user.id,
    name,
    keyHash: generated.keyHash,
    prefix: generated.prefix,
  });

  return Response.json(
    {
      ...safeView(row),
      // Shown once. Tell the client explicitly this won't be retrievable again.
      key: generated.plaintext,
      warning: 'Store this key now — it will not be shown again.',
    },
    { status: 201 },
  );
}
