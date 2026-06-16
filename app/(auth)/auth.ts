import { compare } from 'bcrypt-ts';
import NextAuth, { type User, type Session, type DefaultSession } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';

import { getUser } from '@/lib/db/queries';

import { authConfig } from './auth.config';
import { DUMMY_PASSWORD } from '@/lib/constants';
import { leakAccountProvisioned } from '@/lib/db/queries';

// interface ExtendedSession extends Session {
//   user: User;
// }

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
  providers: [
    // Credentials({
    //   credentials: {},
    //   async authorize({ email, password }: any) {
    //     const users = await getUser(email);

    //     if (users.length === 0) {
    //       await compare(password, DUMMY_PASSWORD);
    //       return null;
    //     }

    //     const [user] = users;

    //     if (!user.password) {
    //       await compare(password, DUMMY_PASSWORD);
    //       return null;
    //     }

    //     const passwordsMatch = await compare(password, user.password);

    //     if (!passwordsMatch) return null;

    //     return user as any;
    //   },
    // }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    async jwt({ token, user, trigger }) {
      // Log every single time the JWT callback is hit
      console.log(`\n🚨 [NextAuth JWT] Trigger: ${trigger || 'implicit'} | Token ID: ${token.id}`);

      if (user) {
        console.log(`🚨 [NextAuth JWT] User object present. Minting initial token for ${user.id}`);
        token.id = user.id;
        token.email = user.email;
        token.image = user.image;
        token.name = user.name;
      }

      // 1. Initial DB Check
      if (token.hasLeakAccount === undefined && token.id) {
        console.log(`🚨 [NextAuth JWT] hasLeakAccount is undefined. Querying database...`);
        try {
          const account = await leakAccountProvisioned({ id: token.id as string });
          token.hasLeakAccount = !!account; 
          console.log(`🚨 [NextAuth JWT] Initial DB Check Result: ${token.hasLeakAccount}`);
        } catch (error) {
          console.error("🚨 [NextAuth JWT] Failed to verify Leak account status", error);
          token.hasLeakAccount = false; 
        }
      }

      // 2. The Secure Update Trigger
      if (trigger === "update") {
        console.log(`🚨 [NextAuth JWT] UPDATE TRIGGER CAUGHT! Re-verifying with database...`);
        try {
          const account = await leakAccountProvisioned({ id: token.id as string });
          token.hasLeakAccount = !!account; 
          console.log(`🚨 [NextAuth JWT] Update DB Check Result: ${token.hasLeakAccount}`);
        } catch (error) {
          console.error("🚨 [NextAuth JWT] Update DB Check Failed!", error);
          token.hasLeakAccount = false;
        }
      }

      console.log(`🚨 [NextAuth JWT] Returning Token. hasLeakAccount is: ${token.hasLeakAccount}`);
      return token;
    },
    
    // async session({ session, token }) {
    //   console.log(`🚨 [NextAuth SESSION] Minting session object. Token hasLeakAccount: ${token.hasLeakAccount}`);
      
    //   if (session.user) {
    //     session.user.id = token.id as string;
    //     session.user.name = token.name as string;
    //     session.user.email = token.email as string;
    //     session.user.image = token.image as string;
    //     session.user.hasLeakAccount = token.hasLeakAccount as boolean;
    //   }

    //   return session;
    // },
  },
});
