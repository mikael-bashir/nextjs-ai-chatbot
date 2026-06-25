import fs from 'node:fs';
import path from 'node:path';
import { test as setup } from '@playwright/test';

const authFile = path.join(__dirname, '../../playwright/.auth/session.json');
const authDir = path.dirname(authFile);

const LEAK_APP = 'http://localhost:3000';
const POSTGRES_URL = process.env.POSTGRES_URL!;
const AUTH_SECRET = process.env.AUTH_SECRET!;
const COOKIE_NAME = 'authjs.session-token';

setup('authenticate', async ({ browser }) => {
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  const { randomUUID } = await import('node:crypto');
  const userId = randomUUID();
  const email = `e2e_setup_${Date.now()}@playwright.com`;

  // Insert user directly into leak DB
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(POSTGRES_URL);
  await sql`INSERT INTO "User" (id, email) VALUES (${userId}, ${email}) ON CONFLICT (id) DO NOTHING`;

  // Mint a NextAuth JWE session token
  const { encode } = await import(
    // @ts-ignore — deep import into the pnpm store
    '/Users/mikaelbashir/Downloads/nextjs-ai-chatbot--feat-usage-credits/node_modules/.pnpm/@auth+core@0.37.2/node_modules/@auth/core/jwt.js'
  );
  const cookieValue = await encode({
    token: {
      id: userId,
      email,
      hasLeakAccount: true,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
    },
    secret: AUTH_SECRET,
    salt: COOKIE_NAME,
  });

  const context = await browser.newContext({ baseURL: LEAK_APP });
  await context.addCookies([
    {
      name: COOKIE_NAME,
      value: cookieValue,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
    },
  ]);

  await context.storageState({ path: authFile });
  await context.close();
});
