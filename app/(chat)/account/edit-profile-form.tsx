'use client';

import { useActionState, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { updateProfileAction, type UpdateProfileState } from './actions';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

const ERROR_MESSAGES: Record<string, string> = {
  username_taken: 'That username is already taken.',
  email_taken: 'That email is already in use.',
  invalid_data: 'Please check your username and email format.',
  unauthorized: 'Session expired — please sign in again.',
  unknown: 'Something went wrong, please try again.',
};

export function EditProfileForm({
  currentUsername,
  currentEmail,
}: {
  currentUsername: string | null;
  currentEmail: string;
}) {
  const { update } = useSession();
  const [state, action, isPending] = useActionState<UpdateProfileState, FormData>(
    updateProfileAction,
    { status: 'idle' },
  );

  useEffect(() => {
    if (state.status === 'success') {
      update();
    }
  }, [state.status, update]);

  return (
    <form action={action} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="username">Username</Label>
        <Input
          id="username"
          name="username"
          defaultValue={currentUsername ?? ''}
          placeholder="letters, numbers, underscores only"
          pattern="^[a-zA-Z0-9_]+$"
          maxLength={32}
          className="max-w-sm"
        />
        <p className="text-xs text-muted-foreground">
          Letters, numbers, and underscores. Max 32 characters.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          defaultValue={currentEmail}
          placeholder="you@example.com"
          maxLength={64}
          className="max-w-sm"
        />
      </div>

      {state.status === 'error' && (
        <p className="text-sm text-destructive font-medium">
          {ERROR_MESSAGES[state.error] ?? ERROR_MESSAGES.unknown}
        </p>
      )}

      {state.status === 'success' && (
        <p className="text-sm text-green-600 font-medium">Profile updated.</p>
      )}

      <Button type="submit" disabled={isPending} size="sm">
        {isPending ? 'Saving…' : 'Save changes'}
      </Button>
    </form>
  );
}
