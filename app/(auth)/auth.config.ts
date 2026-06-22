import type { NextAuthConfig } from 'next-auth';
import type { NextRequest } from 'next/server';

const useSecureCookies = process.env.NODE_ENV === 'production';
const cookiePrefix = useSecureCookies ? '__Secure-' : '';

// Resolve the true public-facing origin even when running behind a reverse proxy
// inside a Docker container (where nextUrl.origin may be an internal service name).
//
// Priority:
//  1. X-Forwarded-Host + X-Forwarded-Proto — set by Caddy/nginx per-request;
//     dynamically correct for every subdomain including previews, no env needed.
//  2. AUTH_URL env var — set explicitly at deploy time; reliable fallback.
//  3. nextUrl.origin — may be an internal address (e.g. http://nextjs-frontend:3000)
//     so only used as a last resort.
function resolvePublicOrigin(request: NextRequest): string {
  const fwdHost = request.headers.get('x-forwarded-host');
  if (fwdHost) {
    // x-forwarded-proto can be comma-separated when chained through multiple proxies
    const proto = (request.headers.get('x-forwarded-proto') ?? 'https')
      .split(',')[0]
      .trim();
    return `${proto}://${fwdHost}`;
  }

  if (process.env.AUTH_URL) {
    try {
      return new URL(process.env.AUTH_URL).origin;
    } catch {
      // malformed AUTH_URL — fall through
    }
  }

  return request.nextUrl.origin;
}

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
    authorized({ auth, request }) {
      const isLoggedIn = !!auth?.user;
      const hasAccount = auth?.user?.hasLeakAccount;
      const { nextUrl } = request;

      if (nextUrl.pathname.startsWith('/api/auth')) return true;

      // Stripe webhooks are signature-verified inside the handler
      if (nextUrl.pathname.startsWith('/api/webhooks')) return true;

      if (nextUrl.pathname.startsWith('/api')) {
        if (!isLoggedIn) return Response.json({ errorCode: 'AUTH_401' }, { status: 401 });
        if (!hasAccount) return Response.json({ errorCode: 'AUTH_403_MODAL' }, { status: 403 });
        return true;
      }

      if (!isLoggedIn) {
        const loginBase = process.env.NODE_ENV === 'production'
          ? 'https://competemath.com/auth/login'
          : 'http://localhost:3001/auth/login';

        const publicOrigin = resolvePublicOrigin(request);
        const loginUrl = new URL(loginBase);
        loginUrl.searchParams.set('callbackUrl', publicOrigin + nextUrl.pathname + nextUrl.search);
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
