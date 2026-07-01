import { test, expect } from '@playwright/test';
import { ChatPage } from '../pages/chat';

test.describe('account page', () => {
  test('/account redirects unauthenticated users to /', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('http://localhost:3000/account');
    await expect(page).toHaveURL('http://localhost:3000/');

    await context.close();
  });

  test('account page renders for authenticated user', async ({ page }) => {
    await page.goto('http://localhost:3000/account');

    await expect(page.getByRole('main', { name: 'Account' })).toBeVisible();
    await expect(page.getByText('Credits Balance')).toBeVisible();
  });

  test('welcome bonus of 100 credits shown on first visit', async ({
    page,
  }) => {
    await page.goto('http://localhost:3000/account');

    await expect(
      page.getByLabel(/\d+ credits/i).or(page.getByText(/100 credits/i)),
    ).toBeVisible();
  });

  test('clicking "Add Credits" opens the modal', async ({ page }) => {
    await page.goto('http://localhost:3000/account');

    await page
      .getByRole('button', { name: 'Add Credits' })
      .first()
      .click();

    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('Add Credits').nth(1)).toBeVisible();
  });

  test('selecting 50 credits and confirming updates the balance', async ({
    page,
  }) => {
    await page.goto('http://localhost:3000/account');

    const balanceText = await page
      .locator('span[aria-label*="credits"]')
      .first()
      .getAttribute('aria-label');
    const initialBalance = Number(balanceText?.match(/\d+/)?.[0] ?? 0);

    await page
      .getByRole('button', { name: 'Add Credits' })
      .first()
      .click();

    await page.getByRole('button', { name: '50' }).click();

    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Add Credits' })
      .click();

    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10_000 });

    await expect(
      page.getByLabel(new RegExp(`${initialBalance + 50} credits`)),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('usage history table is visible with welcome row', async ({ page }) => {
    await page.goto('http://localhost:3000/account');

    await expect(page.getByLabel('Transaction history')).toBeVisible();
    await expect(page.getByText('Welcome bonus')).toBeVisible();
  });

  test('rate limit card shows 0 / 20 on fresh session', async ({ page }) => {
    await page.goto('http://localhost:3000/account');

    await expect(page.getByText(/\/\s*20 messages used this hour/i)).toBeVisible();
  });

  test('sending a chat message decrements balance by 1', async ({ page }) => {
    await page.goto('http://localhost:3000/account');

    const balanceText = await page
      .locator('span[aria-label*="credits"]')
      .first()
      .getAttribute('aria-label');
    const balanceBefore = Number(balanceText?.match(/\d+/)?.[0] ?? 0);

    const chatPage = new ChatPage(page);
    await chatPage.createNewChat();
    await chatPage.sendUserMessage('Why is the sky blue?');
    await chatPage.isGenerationComplete();

    await page.goto('http://localhost:3000/account');

    await expect(
      page.getByLabel(new RegExp(`${balanceBefore - 1} credits`)),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('"Account" link in sidebar nav leads to /account', async ({ page }) => {
    await page.goto('http://localhost:3000/');

    const userMenu = page.locator('[data-sidebar="menu-button"]').last();
    await userMenu.click();

    await page.getByRole('link', { name: 'Account' }).click();

    await expect(page).toHaveURL('http://localhost:3000/account');
    await expect(page.getByText('Credits Balance')).toBeVisible();
  });
});
