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

      // If they are not logged in, kick them to the main site
      if (!isLoggedIn) {
        // Automatically switch between local testing and production
        const mainSiteUrl = process.env.NODE_ENV === 'production' 
          ? 'https://competemath.com/auth/login'
          : 'http://localhost:3001/auth/login';

        const loginUrl = new URL(mainSiteUrl);
        
        // Attach the exact page they were trying to visit on 'leak'
        loginUrl.searchParams.set("callbackUrl", nextUrl.href);

        return Response.redirect(loginUrl);
      }

      // if (isLoggedIn && (isOnLogin || isOnRegister)) {
      //   return Response.redirect(new URL('/', nextUrl as unknown as URL));
      // }

      // if (isOnRegister || isOnLogin) {
      //   return true; // Always allow access to register and login pages
      // }

      // if (isOnChat) {
      //   if (isLoggedIn) return true;
      //   return false; // Redirect unauthenticated users to login page
      // }

      // if (isLoggedIn) {
      //   return Response.redirect(new URL('/', nextUrl as unknown as URL));
      // }

      return true;
    },
  },
} satisfies NextAuthConfig;
