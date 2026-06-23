
import NextAuth, { type DefaultSession } from 'next-auth';

import { authConfig } from './auth.config';
import { leakAccountProvisioned } from '@/lib/db/queries';

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

      if (token.hasLeakAccount === undefined && token.id) {
        try {
          const account = await leakAccountProvisioned({ id: token.id as string });
          token.hasLeakAccount = !!account;
        } catch {
          token.hasLeakAccount = false;
        }
      }

      if (trigger === 'update') {
        try {
          const account = await leakAccountProvisioned({ id: token.id as string });
          token.hasLeakAccount = !!account;
          if (account?.username) token.name = account.username;
          if (account?.email) token.email = account.email;
        } catch {
          token.hasLeakAccount = false;
        }
      }

      return token;
    },
  },
});
