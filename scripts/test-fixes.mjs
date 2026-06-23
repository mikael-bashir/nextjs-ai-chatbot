import { chromium } from '@playwright/test';
import { writeFileSync } from 'fs';

const BASE = 'http://localhost:3002';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

// ── 1. Home page (unauthenticated): check sign-in link has callbackUrl ──────
console.log('\n── Test 1: Sign-in button href ──');
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
writeFileSync('/tmp/test1-home.png', await page.screenshot());

const signInHref = await page.$eval('a[href*="auth/login"]', el => el.href).catch(() => null);
if (signInHref) {
  const url = new URL(signInHref);
  const cb = url.searchParams.get('callbackUrl');
  console.log('Sign-in href:', signInHref);
  console.log('callbackUrl param:', cb);
  if (cb && (cb.includes('localhost') || cb.includes('competemath'))) {
    console.log('✅ callbackUrl is present and contains the origin');
  } else {
    console.log('❌ callbackUrl is missing or wrong:', cb);
  }
} else {
  console.log('❌ No sign-in link found');
  const allHrefs = await page.$$eval('a', els => els.map(e => ({ text: e.textContent?.trim(), href: e.href })));
  console.log('All links:', allHrefs.slice(0, 10));
}

const signInText = await page.locator('text=Sign in').first().isVisible().catch(() => false);
console.log('Sign in text visible:', signInText ? '✅' : '❌');

// ── 2. /account when unauthenticated: should redirect ────────────────────────
console.log('\n── Test 2: /account unauthenticated ──');
await page.goto(BASE + '/account', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const finalUrl = page.url();
writeFileSync('/tmp/test2-account.png', await page.screenshot());
console.log('Final URL after /account visit:', finalUrl);
if (!finalUrl.includes('localhost:3002/account')) {
  console.log('✅ Redirected away from /account (correct for unauthenticated user)');
} else {
  // Check if page has content or is blank
  const bodyText = await page.textContent('body').catch(() => '');
  console.log('Body text (first 200 chars):', bodyText?.slice(0, 200));
}

await browser.close();
console.log('\n✅ Done');
