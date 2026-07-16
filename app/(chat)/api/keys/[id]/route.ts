import { auth } from '@/app/(auth)/auth';
import { revokeApiKey } from '@/lib/db/leak-queries';


// DELETE /api/keys/:id — revoke a key. Owner-scoped inside the query.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const revoked = await revokeApiKey({ id, userId: session.user.id });
  if (!revoked) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  return Response.json({ ok: true });
}
