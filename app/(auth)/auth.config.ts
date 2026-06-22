import type { NextAuthConfig } from 'next-auth';

const useSecureCookies = process.env.NODE_ENV === 'production';
const cookiePrefix = useSecureCookies ? '__Secure-' : '';

export const authConfig = {
  pages: {
    signIn: '/login',
    newUser: '/',
  },
  cookies: {
    sessionToken: {
      name: `${cookiePrefix}authjs.session-token`,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: useSecureCookies,
        // Wildcard domain covers leak.competemath.com and all preview subdomains
        domain: useSecureCookies ? '.competemath.com' : 'localhost',
      },
    },
  },
  providers: [],
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const hasAccount = auth?.user?.hasLeakAccount;

      if (nextUrl.pathname.startsWith('/api/auth')) return true;

      // Stripe webhooks are signature-verified inside the handler
      if (nextUrl.pathname.startsWith('/api/webhooks')) return true;

      if (nextUrl.pathname.startsWith('/api')) {
        if (!isLoggedIn) return Response.json({ errorCode: 'AUTH_401' }, { status: 401 });
        if (!hasAccount) return Response.json({ errorCode: 'AUTH_403_MODAL' }, { status: 403 });
        return true;
      }

      // Redirect unauthenticated page visitors to competemath.com login.
      // Use nextUrl.origin (the actual request origin) so this works on both
      // leak.competemath.com and any preview subdomain without extra env vars.
      if (!isLoggedIn) {
        const loginBase = process.env.NODE_ENV === 'production'
          ? 'https://competemath.com/auth/login'
          : 'http://localhost:3001/auth/login';
        const loginUrl = new URL(loginBase);
        loginUrl.searchParams.set('callbackUrl', nextUrl.origin + nextUrl.pathname + nextUrl.search);
        return Response.redirect(loginUrl);
      }

      return true;
    },

    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.name = token.name as string;
        session.user.email = token.email as string;
        session.user.image = token.image as string;
        session.user.hasLeakAccount = token.hasLeakAccount as boolean;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
