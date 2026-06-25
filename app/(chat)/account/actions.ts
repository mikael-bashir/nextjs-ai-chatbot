'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/app/(auth)/auth';
import { addCredits } from '@/lib/db/queries';

export async function addCreditsAction(formData: FormData) {
  const session = await auth();
  if (!session?.user?.id || !session.user.hasLeakAccount) {
    throw new Error('Unauthorized');
  }

  const amount = Number(formData.get('amount'));
  if (!Number.isInteger(amount) || amount < 1 || amount > 10_000) {
    throw new Error('Invalid amount');
  }

  // TODO: Wire Stripe payment here before granting credits in production.
  await addCredits({
    userId: session.user.id,
    amount,
    description: `Manual top-up: ${amount} credits`,
    type: 'grant',
  });

  revalidatePath('/account');
}
