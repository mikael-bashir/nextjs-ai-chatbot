import NextAuth from 'next-auth';

import { authConfig } from '@/app/(auth)/auth.config';

const { auth } = NextAuth(authConfig);

export const proxy = auth;

export const config = {
  matcher: ['/', '/:id', '/api/:path*', '/login', '/register'],
};
