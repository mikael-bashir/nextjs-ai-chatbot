import { auth } from '@/app/(auth)/auth';
import { getOrCreateCreditBalance } from '@/lib/db/queries';

export async function GET() {
  const session = await auth();

  if (!session?.user?.id) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const balance = await getOrCreateCreditBalance({ userId: session.user.id });
    return Response.json({ balance });
  } catch (error) {
    console.error('[GET /api/credits] Failed to get credit balance', error);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
