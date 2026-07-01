'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/app/(auth)/auth';
import { addCredits, updateUserProfile, type ProfileUpdateError } from '@/lib/db/queries';

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

export type UpdateProfileState =
  | { status: 'idle' }
  | { status: 'success' }
  | { status: 'error'; error: ProfileUpdateError | 'unauthorized' | 'invalid_data' };

export async function updateProfileAction(
  _prev: UpdateProfileState,
  formData: FormData,
): Promise<UpdateProfileState> {
  const session = await auth();
  if (!session?.user?.id || !session.user.hasLeakAccount) {
    return { status: 'error', error: 'unauthorized' };
  }

  const rawUsername = (formData.get('username') as string | null)?.trim();
  const rawEmail = (formData.get('email') as string | null)?.trim();

  if (rawUsername !== undefined && rawUsername !== null) {
    if (!/^[a-zA-Z0-9_]+$/.test(rawUsername) || rawUsername.length < 1 || rawUsername.length > 32) {
      return { status: 'error', error: 'invalid_data' };
    }
  }

  if (rawEmail !== undefined && rawEmail !== null && rawEmail.length > 0) {
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(rawEmail) || rawEmail.length > 64) {
      return { status: 'error', error: 'invalid_data' };
    }
  }

  const updates: { username?: string; email?: string } = {};
  if (rawUsername) updates.username = rawUsername;
  if (rawEmail) updates.email = rawEmail;

  if (Object.keys(updates).length === 0) {
    return { status: 'success' };
  }

  const result = await updateUserProfile({ userId: session.user.id, ...updates });
  if (result.error) return { status: 'error', error: result.error };

  revalidatePath('/account');
  return { status: 'success' };
}
