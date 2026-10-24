import { test, expect } from '../fixtures';
import { AiChatPage } from '../pages/AiChatPage';
import { AiWorkspacePage } from '../pages/AiWorkspacePage';
import { BasePage } from '../pages/BasePage';
import { LoginPage } from '../pages/LoginPage';
import { waitForAppReady } from '../pages/hydration';
import { clearLoginRateLimit } from '../test-helpers';
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Move AI conversations between the side panel and the AI Assistant
 * (/workspace) — #9840 W5, spec §3.3–§3.8, plan T17.
 *
 * STACK: a wt-stack with the AI keys BLANKED. No turn can run there (a send
 * answers 503 ai_not_configured), so every attach answers
 * `attach_state{turn:'unavailable'}` and this spec covers the IDLE paths only:
 * all three entry points (panel header, panel History, workspace picker) in
 * both directions, the replace-confirm, the `#session=` deep link including the
 * other-org leg (plan T17 Step 3 (b)), leaving /workspace and returning (the
 * re-attach wiring of Step 3 (c)), the five-tab cap, and logout. Moving a
 * RUNNING turn (Step 3 (a), the mid-turn half of (c)) is proven against the
 * real stores in apps/web/src/stores/aiConversationHandoff.runningTurn.test.tsx
 * and owed live on the real-key checklist:
 * docs/superpowers/plans/ai-mcp/2026-10-25-ai-chat-move-conversations-lab-checklist.md
 *
 * SELECTORS: data-testid only. The side panel is mounted on every page and
 * renders the same composer (`ai-chat-input`) as the workspace tabs, and
 * `ai-conversation-row` renders in both the panel History and the picker, so
 * every such locator is scoped under its surface root (`ai-chat-sidebar`,
 * `workspace-page`, `workspace-conversation-picker`) in the page objects —
 * unscoped they match twice and fail Playwright's strict mode.
 *
 * DATA: seed-ai-move-conversation.sql (fresh sessions each run; the second
 * organization has a fixed id). Each leg starts with both surfaces empty.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function pgContainer(): string {
  if (process.env.E2E_PG_CONTAINER) return process.env.E2E_PG_CONTAINER;
  const p = process.env.E2E_STACK_FILE ?? path.resolve(__dirname, '../..', '.breeze-stack.json');
  if (existsSync(p)) {
    const d = JSON.parse(readFileSync(p, 'utf8'));
    if (d.pgContainer) return d.pgContainer;
  }
  return 'breeze-postgres';
}

interface Seed {
  org2: string;
  tag: string;
  A: string;
  B: string;
  C: string;
  O: string;
  T: string;
  S: string;
  M: string;
}

/** Runs seed-ai-move-conversation.sql inside the stack's Postgres; returns what it printed. */
function seedSessions(): Seed {
  const sqlPath = path.resolve(__dirname, '..', 'seed-ai-move-conversation.sql');
  const out = execFileSync(
    'docker',
    ['exec', '-i', pgContainer(), 'psql', '-U', 'breeze', '-d', 'breeze', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { encoding: 'utf8', input: readFileSync(sqlPath, 'utf8') },
  );
  const pick = (key: string, shape = '[0-9a-f-]{36}') => {
    const v = new RegExp(`^${key}=(${shape})$`, 'm').exec(out)?.[1];
    if (!v) throw new Error(`seed did not report ${key}:\n${out}`);
    return v;
  };
  return {
    org2: pick('ORG_2'),
    tag: pick('TAG', '[0-9a-f]{8}'),
    A: pick('SESSION_A'),
    B: pick('SESSION_B'),
    C: pick('SESSION_C'),
    O: pick('SESSION_O'),
    T: pick('SESSION_T'),
    S: pick('SESSION_S'),
    M: pick('SESSION_M'),
  };
}

/** `path` is the pathname only: fetchWithAuth appends `?orgId=<current org>`. */
type Req = { method: string; path: string };

/** Every /api/v1/ai/sessions request the page makes, in order. */
function recordSessionRequests(page: Page): Req[] {
  const seen: Req[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/v1/ai/sessions')) seen.push({ method: r.method(), path: u.pathname });
  });
  return seen;
}
const streamsOf = (reqs: Req[], id: string) =>
  reqs.filter((r) => r.method === 'GET' && r.path === `/api/v1/ai/sessions/${id}/stream`).length;
const hydratesOf = (reqs: Req[], id: string) =>
  reqs.filter((r) => r.method === 'GET' && r.path === `/api/v1/ai/sessions/${id}`).length;
const deletes = (reqs: Req[]) => reqs.filter((r) => r.method === 'DELETE');

/**
 * Both surfaces start empty: `authedPage` carries the worker's localStorage
 * across tests, so the persisted panel (`breeze-ai-chat`) and tabs
 * (`breeze-workspace`) are dropped once per browser tab — not on every
 * navigation, which would defeat the reload and leave-and-return legs.
 */
async function startEmpty(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-move-cleared')) return;
    localStorage.removeItem('breeze-workspace');
    localStorage.removeItem('breeze-ai-chat');
    sessionStorage.setItem('e2e-move-cleared', '1');
  });
}

const panelSessionId = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('breeze-ai-chat') ?? '{}').state?.sessionId ?? null);
const hashOf = (page: Page) => page.evaluate(() => window.location.hash);
/** A link while already on /workspace: a real hashchange, no reload. */
const followLink = (page: Page, id: string) =>
  page.evaluate((sid) => { window.location.hash = `session=${sid}`; }, id);

let seed: Seed;
const title = (key: 'A' | 'B' | 'C' | 'O') =>
  ({ A: 'E2E move A', B: 'E2E move B', C: 'E2E move device', O: 'E2E move other-org' })[key] + ` ${seed.tag}`;

test.describe('AI chat: move conversations between the side panel and the AI Assistant (#9840)', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(() => {
    seed = seedSessions();
  });

  test('1. panel → workspace from the dashboard: same conversation, draft carried, panel released, nothing deleted', async ({ authedPage: page }) => {
    await startEmpty(page);
    const reqs = recordSessionRequests(page);
    const chat = new AiChatPage(page);
    const ws = new AiWorkspacePage(page);

    await chat.open();
    await chat.pickFromHistory(seed.A);
    await expect(chat.openInAssistant()).toBeVisible();
    await expect.poll(() => streamsOf(reqs, seed.A)).toBe(1);
    expect(hydratesOf(reqs, seed.A)).toBe(1);

    await chat.composer().fill('draft one');
    await chat.openInAssistant().click();

    await page.waitForURL(`**/workspace#session=${seed.A}`);
    await expect(ws.root()).toBeVisible();
    await expect(ws.tabs()).toHaveCount(1);
    await expect(ws.tabTitle(0)).toContainText(title('A'));
    await expect(ws.composer()).toHaveValue('draft one');
    await expect.poll(() => panelSessionId(page)).toBeNull();
    await expect(chat.sidebar()).toHaveAttribute('inert');
    // The tab hydrated and attached once; the panel's own attach was before.
    await expect.poll(() => streamsOf(reqs, seed.A)).toBe(2);
    expect(hydratesOf(reqs, seed.A)).toBe(2);
    expect(deletes(reqs)).toEqual([]);
    expect(reqs.filter((r) => r.method === 'POST')).toEqual([]);
  });

  test('2. workspace → panel with the panel open: the header control is reachable; the tab menu moves too', async ({ authedPage: page }) => {
    await startEmpty(page);
    const reqs = recordSessionRequests(page);
    const chat = new AiChatPage(page);
    const ws = new AiWorkspacePage(page);

    await ws.goto(`#session=${seed.A}`);
    await expect(ws.tabs()).toHaveCount(1);
    await expect.poll(() => streamsOf(reqs, seed.A)).toBe(1);

    // T17a: the open panel (fixed, 400 px, no backdrop on lg+) used to cover
    // the header's "Continue in side panel"; the workspace now reserves its width.
    await chat.openPanel();
    await expect(ws.root()).toHaveClass(/(^|\s)lg:pr-\[400px\](\s|$)/);
    await ws.continueInPanel().click();

    await expect(chat.openInAssistant()).toBeVisible();
    await expect(ws.tabs()).toHaveCount(0);
    await expect.poll(() => streamsOf(reqs, seed.A)).toBe(2);
    await expect.poll(() => hashOf(page)).toBe('');
    expect(deletes(reqs)).toEqual([]);

    // The tab menu's "Continue in side panel", with a draft typed in the tab.
    await followLink(page, seed.B);
    await expect(ws.tabs()).toHaveCount(1);
    await expect(ws.tabTitle(0)).toContainText(title('B'));
    await expect.poll(() => streamsOf(reqs, seed.B)).toBe(1);
    await ws.composer().fill('tab draft');
    await ws.activeTabMenu().click();
    await ws.tabContinueInPanel().click();

    await expect(ws.tabs()).toHaveCount(0);
    await expect(chat.composer()).toHaveValue('tab draft');
    await expect.poll(() => panelSessionId(page)).toBe(seed.B);
    await expect.poll(() => streamsOf(reqs, seed.B)).toBe(2);
    expect(deletes(reqs)).toEqual([]);
  });

  test('3. panel History in both directions, and the replace-confirm (cancel changes nothing, confirm moves)', async ({ authedPage: page }) => {
    await startEmpty(page);
    const reqs = recordSessionRequests(page);
    const chat = new AiChatPage(page);
    const ws = new AiWorkspacePage(page);

    await ws.goto(`#session=${seed.B}`);
    await expect(ws.tabs()).toHaveCount(1);
    await chat.openPanel();
    await chat.historyToggle().click();
    // Chat conversations only: no script-authoring or MCP session; the
    // topology investigation is listed in the panel (it lives there, D4).
    await expect(chat.conversationRow(seed.A)).toBeVisible();
    await expect(chat.conversationRow(seed.T)).toBeVisible();
    await expect(chat.conversationRow(seed.S)).toHaveCount(0);
    await expect(chat.conversationRow(seed.M)).toHaveCount(0);
    await expect(chat.openElsewhereLabel(seed.B)).toContainText('Open in AI Assistant');
    await expect(chat.openElsewhereLabel(seed.A)).toHaveCount(0);

    await chat.conversationRow(seed.B).click();
    await expect(ws.tabs()).toHaveCount(0);
    await expect.poll(() => panelSessionId(page)).toBe(seed.B);
    await expect.poll(() => streamsOf(reqs, seed.B)).toBe(2);
    expect(deletes(reqs)).toEqual([]);

    // C in a tab; A in the panel with unsent text.
    await followLink(page, seed.C);
    await expect(ws.tabs()).toHaveCount(1);
    await expect.poll(() => streamsOf(reqs, seed.C)).toBe(1);
    await chat.pickFromHistory(seed.A);
    await expect.poll(() => panelSessionId(page)).toBe(seed.A);
    await chat.composer().fill('panel draft');

    // Picking C (open in a tab) would replace a panel conversation with unsent text: ask first.
    await chat.historyToggle().click();
    const before = reqs.length;
    await chat.conversationRow(seed.C).click();
    await expect(ws.replaceConfirm()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(ws.replaceConfirm()).toHaveCount(0);
    await expect.poll(() => panelSessionId(page)).toBe(seed.A);
    await expect(ws.tabs()).toHaveCount(1);
    expect(reqs.slice(before)).toEqual([]);

    await expect(chat.conversationRow(seed.C)).toBeVisible();
    await chat.conversationRow(seed.C).click();
    await ws.replaceConfirm().click();
    await expect(ws.tabs()).toHaveCount(0);
    await expect.poll(() => panelSessionId(page)).toBe(seed.C);
    await expect.poll(() => streamsOf(reqs, seed.C)).toBe(2);
    expect(deletes(reqs)).toEqual([]);
  });

  test('4. the workspace picker: chat rows only, chips, a plain pick, a move from the panel, and the empty state', async ({ authedPage: page }) => {
    await startEmpty(page);
    const reqs = recordSessionRequests(page);
    const chat = new AiChatPage(page);
    const ws = new AiWorkspacePage(page);

    await ws.goto(`#session=${seed.B}`);
    await expect(ws.tabs()).toHaveCount(1);
    await ws.openPicker();
    for (const id of [seed.A, seed.B, seed.C, seed.O]) await expect(ws.pickerRow(id)).toBeVisible();
    for (const id of [seed.T, seed.S, seed.M]) await expect(ws.pickerRow(id)).toHaveCount(0);
    await expect(ws.pickerRow(seed.O).getByTestId('workspace-chip-org')).toBeVisible();
    await expect(ws.pickerRow(seed.C).getByTestId('workspace-chip-device')).toBeVisible();
    for (const id of [seed.A, seed.B, seed.O]) {
      await expect(ws.pickerRow(id).getByTestId('workspace-chip-device')).toHaveCount(0);
    }

    // A plain pick opens a tab.
    await ws.pickerRow(seed.C).click();
    await expect(ws.picker()).toHaveCount(0);
    await expect(ws.tabs()).toHaveCount(2);
    await expect.poll(() => hashOf(page)).toBe(`#session=${seed.C}`);
    await expect.poll(() => streamsOf(reqs, seed.C)).toBe(1);
    expect(hydratesOf(reqs, seed.C)).toBe(1);

    // The row the panel holds MOVES, with the panel's draft.
    await chat.openPanel();
    await chat.pickFromHistory(seed.A);
    await expect.poll(() => panelSessionId(page)).toBe(seed.A);
    await chat.composer().fill('move me');
    await ws.openPicker();
    await expect(ws.pickerOpenElsewhere(seed.A)).toContainText('Open in side panel');
    await ws.pickerRow(seed.A).click();
    await expect(ws.tabs()).toHaveCount(3);
    await expect.poll(() => hashOf(page)).toBe(`#session=${seed.A}`);
    await expect(ws.composer()).toHaveValue('move me');
    await expect.poll(() => panelSessionId(page)).toBeNull();
    expect(deletes(reqs)).toEqual([]);

    // With no tab left, the empty state opens the same picker.
    while ((await ws.tabs().count()) > 0) await ws.tabs().first().getByTestId('workspace-tab-close').click();
    await ws.emptyOpenPast().click();
    await expect(ws.picker()).toBeVisible();
    await expect(ws.pickerRow(seed.B)).toBeVisible();
  });

  test('5. the #session= deep link: other-org conversation (plan Step 3 (b)), reload, malformed and unknown links, hash follows the tab', async ({ authedPage: page }) => {
    await startEmpty(page);
    const reqs = recordSessionRequests(page);
    const ws = new AiWorkspacePage(page);

    await page.goto('/');
    await waitForAppReady(page, 'dashboard-heading');
    const switcher = page.getByTestId('org-switcher-label');
    // The label reads "Select organization" until the org list has loaded.
    await expect(switcher).not.toHaveText(/^(|Select organization)$/);
    const orgBefore = (await switcher.textContent())?.trim();

    await ws.goto(`#session=${seed.O}`);
    await expect(ws.tabs()).toHaveCount(1);
    await expect(ws.tabTitle(0)).toContainText(title('O'));
    await expect(ws.sessionChips().getByTestId('workspace-chip-org')).toContainText('E2E Move Org');
    await expect(switcher).toHaveText(orgBefore ?? '');
    await expect.poll(() => streamsOf(reqs, seed.O)).toBe(1);

    // Reload: the same tab, hydrated and attached once more, nothing duplicated.
    await page.reload();
    await waitForAppReady(page, 'workspace-page');
    await expect(ws.tabs()).toHaveCount(1);
    await expect.poll(() => streamsOf(reqs, seed.O)).toBe(2);
    await page.waitForTimeout(500);
    expect(hydratesOf(reqs, seed.O)).toBe(2);
    expect(streamsOf(reqs, seed.O)).toBe(2);

    // Anything but exactly one canonical UUID is ignored with no request.
    let before = reqs.length;
    await page.evaluate(() => { window.location.hash = 'session=not-a-uuid'; });
    await page.evaluate((a) => { window.location.hash = `session=${a}&x=1`; }, seed.A);
    await page.waitForTimeout(1_000);
    expect(reqs.slice(before)).toEqual([]);
    await expect(ws.tabs()).toHaveCount(1);

    // An unknown conversation: one 404 read, a toast, and the link is dropped.
    const unknown = randomUUID();
    before = reqs.length;
    await followLink(page, unknown);
    await expect(page.getByTestId('toast').first()).toContainText("This conversation isn't available");
    await expect.poll(() => hashOf(page)).not.toContain(unknown);
    expect(reqs.slice(before).filter((r) => r.path.includes(unknown))).toEqual([
      { method: 'GET', path: `/api/v1/ai/sessions/${unknown}` },
    ]);
    await expect(ws.tabs()).toHaveCount(1);

    // The hash follows the active tab with replaceState (no history entries).
    await followLink(page, seed.A);
    await expect(ws.tabs()).toHaveCount(2);
    await expect.poll(() => hashOf(page)).toBe(`#session=${seed.A}`);
    const historyLength = await page.evaluate(() => history.length);
    await ws.tabSelect(0).click();
    await expect.poll(() => hashOf(page)).toBe(`#session=${seed.O}`);
    await ws.tabSelect(1).click();
    await expect.poll(() => hashOf(page)).toBe(`#session=${seed.A}`);
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
    expect(deletes(reqs)).toEqual([]);
  });

  test('6. leave /workspace and return: each session tab re-hydrates and re-attaches once (idle wiring of plan Step 3 (c); the mid-turn half is on the real-key checklist)', async ({ authedPage: page }) => {
    await startEmpty(page);
    const reqs = recordSessionRequests(page);
    const ws = new AiWorkspacePage(page);

    await ws.goto(`#session=${seed.A}`);
    await followLink(page, seed.B);
    await expect(ws.tabs()).toHaveCount(2);
    await expect.poll(() => streamsOf(reqs, seed.A)).toBe(1);
    await expect.poll(() => streamsOf(reqs, seed.B)).toBe(1);

    await page.goto('/devices');
    await page.waitForURL('**/devices');
    await ws.goto();
    await expect(ws.tabs()).toHaveCount(2);
    await expect(ws.tabTitle(0)).toContainText(title('A'));
    await expect(ws.tabTitle(1)).toContainText(title('B'));
    await expect.poll(() => streamsOf(reqs, seed.A)).toBe(2);
    await expect.poll(() => streamsOf(reqs, seed.B)).toBe(2);
    await page.waitForTimeout(500);
    expect(streamsOf(reqs, seed.A)).toBe(2);
    expect(streamsOf(reqs, seed.B)).toBe(2);
    expect(deletes(reqs)).toEqual([]);
  });

  test('7. five tabs (D5): both "+" items are disabled and a sixth link is a toast, never an eviction', async ({ authedPage: page }) => {
    await startEmpty(page);
    const reqs = recordSessionRequests(page);
    const ws = new AiWorkspacePage(page);

    await ws.goto(`#session=${seed.A}`);
    for (const [i, id] of [seed.B, seed.C, seed.O].entries()) {
      await followLink(page, id);
      await expect(ws.tabs()).toHaveCount(i + 2);
    }
    await ws.newTabMenu().click();
    await ws.newChatItem().click();
    await expect(ws.tabs()).toHaveCount(5);

    await ws.newTabMenu().click();
    await expect(ws.newChatItem()).toHaveAttribute('aria-disabled', 'true');
    await expect(ws.openPastItem()).toHaveAttribute('aria-disabled', 'true');
    let before = reqs.length;
    // Playwright will not click an aria-disabled item; force it to prove that
    // activating it anyway opens nothing and fetches nothing.
    await ws.openPastItem().click({ force: true });
    await page.waitForTimeout(500);
    await expect(ws.picker()).toHaveCount(0);
    expect(reqs.slice(before)).toEqual([]);
    await page.keyboard.press('Escape');

    before = reqs.length;
    const sixth = randomUUID();
    await followLink(page, sixth);
    await expect(page.getByTestId('toast').first()).toContainText('Close a tab to open this conversation');
    await expect(ws.tabs()).toHaveCount(5);
    await page.waitForTimeout(500);
    expect(reqs.slice(before)).toEqual([]);
    expect(deletes(reqs)).toEqual([]);
  });

  test('8. signing out clears both surfaces in this browser (§3.8)', async ({ cleanPage: page }) => {
    // cleanPage, never authedPage: authedPage writes its storage state back on
    // teardown, so a sign-out there would log the whole worker out.
    clearLoginRateLimit();
    const reqs = recordSessionRequests(page);
    const login = new LoginPage(page);
    await login.goto();
    await login.login(process.env.E2E_ADMIN_EMAIL!, process.env.E2E_ADMIN_PASSWORD!);
    const chat = new AiChatPage(page);
    const ws = new AiWorkspacePage(page);

    await ws.goto(`#session=${seed.A}`);
    await expect(ws.tabs()).toHaveCount(1);
    await chat.openPanel();
    await chat.pickFromHistory(seed.B);
    await expect.poll(() => panelSessionId(page)).toBe(seed.B);
    const keys = () => page.evaluate(() => [localStorage.getItem('breeze-workspace'), localStorage.getItem('breeze-ai-chat')]);
    expect((await keys()).every((v) => v !== null)).toBe(true);

    await chat.closeButton().click();
    await new BasePage(page).signOut();
    expect(await keys()).toEqual([null, null]);

    clearLoginRateLimit();
    await login.goto();
    await login.login(process.env.E2E_ADMIN_EMAIL!, process.env.E2E_ADMIN_PASSWORD!);
    await ws.goto();
    await expect(ws.emptyOpenPast()).toBeVisible();
    await expect(ws.tabs()).toHaveCount(0);
    await expect.poll(() => panelSessionId(page)).toBeNull();
    expect(deletes(reqs)).toEqual([]);
  });
});
