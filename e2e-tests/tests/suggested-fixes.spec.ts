import { test, expect } from '../fixtures';
import { persistStorageState } from '../auth-state';
import type { BrowserContext, Page } from '@playwright/test';
import { SuggestedFixesPanel } from '../pages/SuggestedFixesPanel';
import { FixMemoryPage } from '../pages/FixMemoryPage';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const camel = (k: string) => k.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Runs a seed file inside the stack's Postgres; returns the `KEY=<uuid>` ids it printed. */
function seedFromFile<T>(file: string, keys: string[]): T {
  const sqlPath = path.resolve(__dirname, '..', file);
  const out = execFileSync(
    'docker',
    ['exec', '-i', pgContainer(), 'psql', '-U', 'breeze', '-d', 'breeze', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { encoding: 'utf8', input: readFileSync(sqlPath, 'utf8') },
  );
  const result: Record<string, string> = {};
  for (const key of keys) {
    const id = new RegExp(`${key}=([0-9a-f-]{36})`).exec(out)?.[1];
    if (!id) throw new Error(`seed did not report ${key}:\n${out}`);
    result[camel(key)] = id;
  }
  return result as T;
}

interface Seed {
  alertId: string;
  memorySuggestionId: string;
  builtinId: string;
  stepsId: string;
  draftId: string;
  memoryId: string;
}

test.describe.configure({ mode: 'serial' });

test.describe('AI suggested fixes', () => {
  let seed: Seed;
  // ONE browser context for the whole file (not the per-test `authedPage`
  // fixture): refresh-token families are revoked on reuse, so a second context
  // replaying the shared storageState's rotated cookie lands on a login page.
  let ctx: BrowserContext;
  let page: Page;
  test.setTimeout(90_000);

  test.beforeAll(async ({ browser, workerStorageState }) => {
    // Fresh ids every run, so a serial retry never trips over leftover rows.
    seed = seedFromFile<Seed>('seed-fix-memory.sql', ['ALERT_ID', 'MEMORY_SUGGESTION_ID', 'BUILTIN_ID', 'STEPS_ID', 'DRAFT_ID', 'MEMORY_ID']);
    ctx = await browser.newContext({ storageState: workerStorageState });
    page = await ctx.newPage();
  });
  test.afterAll(async ({ workerStorageState }) => {
    if (ctx) await persistStorageState(ctx, workerStorageState);
    await ctx?.close();
  });

  test('the panel shows Proven and AI groups with AI labels', async () => {
    const panel = new SuggestedFixesPanel(page);
    await panel.gotoAlert(seed.alertId);
    await expect(panel.group('proven').getByTestId(`suggestion-row-${seed.memorySuggestionId}`)).toBeVisible();
    await expect(panel.group('ai').getByTestId(`suggestion-ai-badge-${seed.builtinId}`)).toBeVisible();
    await expect(panel.aiWrittenLabel(seed.stepsId)).toBeVisible();
  });

  // No live model on the stack, so the request is denied; observed deterministic
  // across repeated runs. UNCOVERED here: research-state-running/-failed/
  // -no-safe-fix/-credits (need a real run or a billing denial) and the
  // running -> done transition; those are covered by the web unit tests.
  test('Research deeper always lands on an explicit state, never an empty panel', async () => {
    const panel = new SuggestedFixesPanel(page);
    await panel.gotoAlert(seed.alertId);
    await panel.researchDeeper();
    await expect(panel.noModelResearchState()).toBeVisible();
  });

  test('Draft a script opens the builder with the brief pre-filled and unsent', async () => {
    const panel = new SuggestedFixesPanel(page);
    await panel.gotoAlert(seed.alertId);
    await panel.draftScript(seed.draftId);
    await page.waitForURL('**/scripts/new');
    await expect(page.getByTestId('script-ai-input')).toHaveValue(/Clear the print queue, then restart the spooler/);
  });

  test('Save as reviewed steps appears under Fix memory > Reviewed steps', async () => {
    const panel = new SuggestedFixesPanel(page);
    await panel.gotoAlert(seed.alertId);
    const title = `Reviewed ${Date.now()}`;
    await panel.saveAsReviewed(seed.stepsId, title);
    const memory = new FixMemoryPage(page);
    await memory.gotoSteps();
    await expect(memory.stepsRowByTitle(title)).toBeVisible();
  });

  test('Fix memory lists the proven entry and Retire marks it retired', async () => {
    const memory = new FixMemoryPage(page);
    await memory.gotoFixes();
    await expect(memory.row(seed.memoryId)).toContainText('7/8');
    await memory.retire(seed.memoryId);
    await expect(memory.statusBadge(seed.memoryId)).toHaveAttribute('data-status', 'retired');
  });
});
