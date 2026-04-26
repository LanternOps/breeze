// e2e-tests/playwright/tests/remote-access.spec.ts
import { test, expect } from '../fixtures';
import { RemoteAccessPage } from '../pages/RemoteAccessPage';

test.describe('Remote Access Hub', () => {
  test('hub page loads with heading and nav cards', async ({ authedPage }) => {
    const page = new RemoteAccessPage(authedPage);
    await page.goto();
    await expect(page.heading()).toBeVisible();
    await expect(page.hubDescription()).toBeVisible();
    await expect(page.startTerminalCard()).toBeVisible();
    await expect(page.startTerminalDescription()).toBeVisible();
    await expect(page.fileTransferCard()).toBeVisible();
    await expect(page.fileTransferDescription()).toBeVisible();
    await expect(page.sessionHistoryCard()).toBeVisible();
    await expect(page.sessionHistoryDescription()).toBeVisible();
  });

  test('hub page card links point to correct sub-pages', async ({ authedPage }) => {
    const page = new RemoteAccessPage(authedPage);
    await page.goto();
    // Links to sub-pages exist (check href via locator)
    await expect(authedPage.locator('a[href="/remote/terminal"]')).toBeVisible();
    await expect(authedPage.locator('a[href="/remote/files"]')).toBeVisible();
    await expect(authedPage.locator('a[href="/remote/sessions"]')).toBeVisible();
  });
});

test.describe('Remote Terminal Launcher', () => {
  test('terminal launcher page loads with controls and table columns', async ({ authedPage }) => {
    const page = new RemoteAccessPage(authedPage);
    await page.gotoTerminalLauncher();
    await expect(page.terminalLauncherHeading()).toBeVisible();
    await expect(page.terminalLauncherDescription()).toBeVisible();
    await expect(page.backLink()).toBeVisible();
    await expect(page.refreshButton()).toBeVisible();
  });

  test('terminal launcher has device table column headers', async ({ authedPage }) => {
    const page = new RemoteAccessPage(authedPage);
    await page.gotoTerminalLauncher();
    await expect(authedPage.getByRole('columnheader', { name: /device/i })).toBeVisible();
    await expect(authedPage.getByRole('columnheader', { name: /os/i })).toBeVisible();
    await expect(authedPage.getByRole('columnheader', { name: /status/i })).toBeVisible();
  });
});

test.describe('Remote File Launcher', () => {
  test('file transfer launcher page loads', async ({ authedPage }) => {
    const page = new RemoteAccessPage(authedPage);
    await page.gotoFileLauncher();
    await expect(page.fileLauncherHeading()).toBeVisible();
    await expect(page.fileLauncherDescription()).toBeVisible();
    await expect(page.backLink()).toBeVisible();
  });
});

test.describe('Session History', () => {
  test('session history page loads with stat cards', async ({ authedPage }) => {
    const page = new RemoteAccessPage(authedPage);
    await page.gotoSessionHistory();
    await expect(page.sessionHistoryHeading()).toBeVisible();
    await expect(page.sessionHistoryPageDescription()).toBeVisible();
    await expect(page.totalSessionsCard()).toBeVisible();
    await expect(page.totalDurationCard()).toBeVisible();
    await expect(page.avgDurationCard()).toBeVisible();
    await expect(page.dataTransferredCard()).toBeVisible();
  });

  test('session history page has filter controls and table columns', async ({ authedPage }) => {
    const page = new RemoteAccessPage(authedPage);
    await page.gotoSessionHistory();
    await expect(page.exportButton()).toBeVisible();
    // Table columns
    await expect(authedPage.getByRole('columnheader', { name: /type/i })).toBeVisible();
    await expect(authedPage.getByRole('columnheader', { name: /device/i })).toBeVisible();
    await expect(authedPage.getByRole('columnheader', { name: /user/i })).toBeVisible();
  });

  test('session history type filter can be changed', async ({ authedPage }) => {
    const page = new RemoteAccessPage(authedPage);
    await page.gotoSessionHistory();
    await expect(page.totalSessionsCard()).toBeVisible();
    // Select terminal filter via the combobox that has an 'all' option
    const select = authedPage.locator('select').first();
    await select.selectOption('terminal');
    await expect(page.sessionHistoryHeading()).toBeVisible();
  });
});
