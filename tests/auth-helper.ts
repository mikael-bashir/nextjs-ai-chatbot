import fs from 'node:fs';
import path from 'node:path';
import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

export type UserContext = {
  context: BrowserContext;
  page: Page;
  request: APIRequestContext;
};

const LEAK_APP = 'http://localhost:3000';

// We bypass the compete-math UI entirely and mint the session cookie directly:
//  1. INSERT a test user into the leak app's Neon DB via REST API
//  2. Encode a NextAuth v5 JWE token using the shared AUTH_SECRET
//  3. Set the cookie in the Playwright context — no browser login needed
//
// This is reliable, fast, and independent of the compete-math app.

const POSTGRES_URL = process.env.POSTGRES_URL!;
const AUTH_SECRET = process.env.AUTH_SECRET!;
const COOKIE_NAME = 'authjs.session-token'; // dev cookie name (no __Secure- prefix)

async function insertTestUser(id: string, email: string): Promise<void> {
  // Use Neon's serverless HTTP driver to insert the user directly
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(POSTGRES_URL);
  await sql`INSERT INTO "User" (id, email) VALUES (${id}, ${email}) ON CONFLICT (id) DO NOTHING`;
}

async function mintSessionCookie(userId: string, email: string): Promise<string> {
  const { encode } = await import(
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — deep import into the pnpm store
    '/Users/mikaelbashir/Downloads/nextjs-ai-chatbot--feat-usage-credits/node_modules/.pnpm/@auth+core@0.37.2/node_modules/@auth/core/jwt.js'
  );
  return encode({
    token: {
      id: userId,
      email,
      hasLeakAccount: true,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24, // 24h
    },
    secret: AUTH_SECRET,
    salt: COOKIE_NAME,
  });
}

export async function createAuthenticatedContext({
  browser,
  name,
}: {
  browser: Browser;
  name: string;
}): Promise<UserContext> {
  const authDir = path.join(__dirname, '../playwright/.auth');
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }
  const storageFile = path.join(authDir, `${name}.json`);

  const { randomUUID } = await import('node:crypto');
  const userId = randomUUID();
  const email = `pw_${name}_${Date.now()}@playwright.com`;

  // 1. Insert into the leak app's DB
  await insertTestUser(userId, email);

  // 2. Mint a valid NextAuth JWE cookie
  const cookieValue = await mintSessionCookie(userId, email);

  // 3. Create a browser context pre-loaded with the session cookie
  const context = await browser.newContext({ baseURL: LEAK_APP });
  await context.addCookies([
    {
      name: COOKIE_NAME,
      value: cookieValue,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      // expires: -1 means session cookie; set a far future timestamp for persistence
      expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
    },
  ]);

  await context.storageState({ path: storageFile });

  const page = await context.newPage();

  return {
    context,
    page,
    request: context.request,
  };
}
