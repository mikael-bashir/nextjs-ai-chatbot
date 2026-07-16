import NextAuth, { type DefaultSession } from 'next-auth';

import { authConfig } from './auth.config';
import { reconcileLeakAccount } from '@/lib/db/queries';

declare module 'next-auth' {
  interface User {
    hasLeakAccount?: boolean;
  }

  interface Session {
    user: {
      id: string;
      hasLeakAccount?: boolean;
    } & DefaultSession['user'];
  }
}

export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut,
} = NextAuth({
  ...authConfig,
  providers: [],
  callbacks: {
    ...authConfig.callbacks,
    async jwt({ token, user, trigger }) {
      if (user) {
        token.id = user.id;
        token.email = user.email;
        token.image = user.image;
        token.name = user.name;
      }

      // Re-check while unprovisioned (undefined OR a cached false), not only when
      // undefined. Provisioning is a one-way transition — once a Leak account row
      // exists it never disappears — so it is safe to trust a cached `true` and
      // keep re-verifying a falsy value. This heals a JWT that cached `false`
      // before the account was provisioned, which otherwise sticks forever
      // because the session cookie is shared across competemath.com and every
      // leak subdomain (including preview deployments).
      if (!token.hasLeakAccount && token.id) {
        try {
          // reconcileLeakAccount also self-heals a competemath id change by
          // migrating the user's existing row (matched by email) to the current
          // id, so a re-registration can never orphan the account.
          const account = await reconcileLeakAccount({
            id: token.id as string,
            email: token.email as string | null,
          });
          token.hasLeakAccount = !!account;
          if (account?.username) token.name = account.username;
          if (account?.email) token.email = account.email;
        } catch {
          // DB error — leave hasLeakAccount as-is (undefined/false) so it retries
          // next request rather than caching a wrong value.
        }
      }

      if (trigger === 'update') {
        try {
          const account = await reconcileLeakAccount({
            id: token.id as string,
            email: token.email as string | null,
          });
          token.hasLeakAccount = !!account;
          if (account?.username) token.name = account.username;
          if (account?.email) token.email = account.email;
        } catch {
          // DB error — don't clobber existing values; keep the session intact
        }
      }

      return token;
    },
  },
});
