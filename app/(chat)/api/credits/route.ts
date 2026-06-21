import { auth } from '@/app/(auth)/auth';
import { getCreditBalance } from '@/lib/db/queries';

export async function GET() {
  const session = await auth();

  if (!session?.user?.id) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const credits = await getCreditBalance({ userId: session.user.id });
    return Response.json({ balance: credits?.balance ?? 0 });
  } catch (error) {
    console.error('[GET /api/credits] Failed to get credit balance', error);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
