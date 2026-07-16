import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import { addCredits, getUser } from '@/lib/db/queries';

// POST /api/admin/grant-credits — admin tops up an account for testing.
//   { amount: number, email?: string }  (email omitted → grant to self)
export async function POST(request: Request) {
  const session = await auth();
  if (!isAdminEmail(session?.user?.email) || !session?.user?.id) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const amount = Number(body?.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000) {
    return Response.json({ error: 'invalid_amount' }, { status: 400 });
  }

  // Resolve target user: given email, or self.
  let userId = session.user.id;
  if (typeof body?.email === 'string' && body.email.trim()) {
    const [target] = await getUser(body.email.trim());
    if (!target) {
      return Response.json({ error: 'user_not_found' }, { status: 404 });
    }
    userId = target.id;
  }

  const newBalance = await addCredits({
    userId,
    amount,
    description: 'Admin test grant',
    type: 'grant',
  });
  return Response.json({ ok: true, balance: newBalance });
}
