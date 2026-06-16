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
        domain: useSecureCookies ? '.competemath.com' : 'localhost',
      },
    },
  },
  providers: [
    // added later in auth.ts since it requires bcrypt which is only compatible with Node.js
    // while this file is also used in non-Node.js environments
  ],
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;

      const hasAccount = auth?.user?.hasLeakAccount;
      
      // let anyone hit this endpoint
      const isApiAuthRoute = nextUrl.pathname.startsWith('/api/auth');
      if (isApiAuthRoute) {
        return true;
      }

      // block all other api requests
      const isApiRoute = nextUrl.pathname.startsWith('/api');
      if (isApiRoute) {
        if (!isLoggedIn) {
          return Response.json({ errorCode: "AUTH_401" }, { status: 401 });
        }
        if (!hasAccount) {
          return Response.json({ errorCode: "AUTH_403_MODAL" }, { status: 403 });
        }
        return true;
      }

      // If they are not logged in, redirect to the main site
      
      // if (!isLoggedIn) {
      //   // Automatically switch between local testing and production
      //   const mainSiteUrl = process.env.NODE_ENV === 'production' 
      //     ? 'https://competemath.com/auth/login'
      //     : 'http://localhost:3001/auth/login';

      //   const loginUrl = new URL(mainSiteUrl);
        
      //   // // Attach the exact page they were trying to visit on 'leak'
      //   // loginUrl.searchParams.set("callbackUrl", nextUrl.href);

      //   const leakDomain = useSecureCookies ? process.env.AUTH_URL : 'http://localhost:3000';
      //   const intendedPath = nextUrl.pathname + nextUrl.search; // e.g., "/chat/123"
        
      //   loginUrl.searchParams.set("callbackUrl", `${leakDomain}${intendedPath}`);

      //   return Response.redirect(loginUrl);
      // }

      return true;
    },
    
    async session({ session, token }) {
      console.log(`🚨 [NextAuth SESSION] Minting session object. Token hasLeakAccount: ${token.hasLeakAccount}`);
      
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
