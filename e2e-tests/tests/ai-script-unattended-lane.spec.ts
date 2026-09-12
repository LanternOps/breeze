import { test, expect } from '../fixtures';
import { STORAGE_STATE } from '../global-setup';
import { ScriptAuthoringPage } from '../pages/ScriptAuthoringPage';
import { ScriptProposalsPage } from '../pages/ScriptProposalsPage';
import type { BrowserContext, Page } from '@playwright/test';
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

function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', '-i', pgContainer(), 'psql', '-U', 'breeze', '-d', 'breeze', '-t', '-A', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
}

interface Seed {
  orgId: string;
  laneId: string;
  laneIntentId: string;
  humanId: string;
  humanApprovalId: string;
  deviceId: string;
}

/** Runs seed-script-lane.sql inside the stack's Postgres; returns the ids it printed. */
function seedLane(): Seed {
  const sqlPath = path.resolve(__dirname, '..', 'seed-script-lane.sql');
  const out = execFileSync(
    'docker',
    ['exec', '-i', pgContainer(), 'psql', '-U', 'breeze', '-d', 'breeze', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { encoding: 'utf8', input: readFileSync(sqlPath, 'utf8') },
  );
  const pick = (key: string) => {
    const id = new RegExp(`${key}=([0-9a-f-]{36})`).exec(out)?.[1];
    if (!id) throw new Error(`seed did not report ${key}:\n${out}`);
    return id;
  };
  return {
    orgId: pick('ORG_ID'),
    laneId: pick('LANE_ID'),
    laneIntentId: pick('LANE_INTENT_ID'),
    humanId: pick('HUMAN_ID'),
    humanApprovalId: pick('HUMAN_APPROVAL_ID'),
    deviceId: pick('DEVICE_ID'),
  };
}

/**
 * The reviewer-gated unattended lane, end to end through the browser (W04,
 * #5612, spec §7 "E2E").
 *
 * What is REAL here: the settings page against the real policy routes (the
 * partner ceiling + org grant the seed wrote, the effective view, the
 * ceiling-aware class list, the lane banner, the reset control), the
 * approvals inbox against the real approval rows, and the API's own
 * effective-policy answer.
 *
 * What is SEEDED (seed-script-lane.sql): the proposals, their reviews and the
 * two intents — one decided by the lane (`decided_via = 'script_reviewer'`,
 * no approval row) and one on the human path (pending + approval row). The
 * wt-stack has no live model, so a real propose_script turn cannot be driven
 * here; the creation-transaction decision that writes the lane shape is
 * proven against real Postgres by scriptLaneHourlyCap.integration.test.ts,
 * and the "no approval card for an approved-at-creation intent" branch of
 * the chat SDK by aiAgentSdk.approvalWait.test.ts.
 *
 * Enabling the lane from the UI needs a fresh MFA step-up (a TOTP code or a
 * passkey). The seeded admin has neither enrolled, so this file proves the
 * UI SURFACES that requirement rather than completing the ceremony; the
 * grant itself is seeded. Same for the reset control.
 */
test.describe.configure({ mode: 'serial' });

test.describe('AI script authoring — unattended lane', () => {
  let seed: Seed;
  let ctx: BrowserContext;
  let authedPage: Page;
  test.setTimeout(120_000);

  test.beforeAll(async ({ browser }) => {
    seed = seedLane();
    ctx = await browser.newContext({ storageState: STORAGE_STATE });
    authedPage = await ctx.newPage();
  });
  test.afterAll(async () => {
    await ctx?.close();
  });

  test('the settings page renders the partner ceiling and the org grant the way the API resolves them', async () => {
    const settings = new ScriptAuthoringPage(authedPage);
    await settings.goto();
    await expect(settings.partnerCard).toBeVisible();
    await expect(settings.orgCard).toBeVisible();
    await expect(settings.enableToggle).toBeChecked();
    // Inside the ceiling → selectable; hard-denied → never selectable.
    await expect(settings.classCheckbox('temp_files')).toBeEnabled();
    await expect(settings.classCheckbox('credentials')).toBeDisabled();
    // The lane is closed, so no banner.
    await expect(settings.laneBanner).toHaveCount(0);

    // The API agrees: partner ceiling AND org grant → effective ON.
    const res = await authedPage.request.get('/api/v1/ai/script-policy');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.effective.unattendedEnabled).toBe(true);
    expect(body.laneState.state).toBe('closed');
  });

  test('a lane-decided run has NO approval card; the human-path run for the same script shape does', async () => {
    // Database truth the seed established: the lane intent is approved with no
    // approval row and no human decider.
    expect(psql(`SELECT status || '|' || decided_via || '|' || coalesce(decided_by_user_id::text,'null') FROM action_intents WHERE id = '${seed.laneIntentId}'`))
      .toBe('approved|script_reviewer|null');
    expect(psql(`SELECT count(*) FROM approval_requests WHERE intent_id = '${seed.laneIntentId}'`)).toBe('0');
    expect(psql(`SELECT coalesce(decided_by::text,'null') FROM script_proposals WHERE id = '${seed.laneId}'`)).toBe('null');

    const inbox = new ScriptProposalsPage(authedPage);
    await inbox.gotoApprovals();
    // The human-path proposal is a card in the inbox…
    await inbox.openScriptReview(seed.humanApprovalId);
    await expect(authedPage.getByTestId('script-proposal-card')).toBeVisible();
    await expect(authedPage.getByTestId('script-proposal-goal')).toContainText('Clear old temp logs');
    // …and the lane-decided one never was: there is no row for it anywhere.
    await expect(authedPage.locator(`[data-testid^="approval-row-"]`).filter({ hasText: 'Clear temporary files' })).toHaveCount(0);
  });

  test('turning the grant OFF is a plain save; turning it ON surfaces the MFA step-up requirement', async () => {
    const settings = new ScriptAuthoringPage(authedPage);
    await settings.goto();
    await settings.enableToggle.click();
    await expect(settings.enableToggle).not.toBeChecked();
    await settings.save.click();
    await expect
      .poll(() => psql(`SELECT unattended_enabled::text FROM ai_script_policies WHERE org_id = '${seed.orgId}'`), { timeout: 30_000 })
      .toBe('false');
    // The API's effective view follows the grant.
    const off = await (await authedPage.request.get('/api/v1/ai/script-policy')).json();
    expect(off.effective.unattendedEnabled).toBe(false);

    // Back ON: the route demands a fresh step-up (403 STEP_UP_REQUIRED) and the
    // page must say so instead of failing silently. The seeded admin has no
    // TOTP/passkey enrolled, so the ceremony cannot complete here — the
    // surfaced requirement IS the assertion.
    await settings.goto();
    await settings.enableToggle.click();
    await expect(settings.enableToggle).toBeChecked();
    await settings.save.click();
    await expect(
      authedPage.getByTestId('script-authoring-error').or(authedPage.getByTestId('script-authoring-stepup')),
    ).toBeVisible({ timeout: 30_000 });
    expect(psql(`SELECT unattended_enabled::text FROM ai_script_policies WHERE org_id = '${seed.orgId}'`)).toBe('false');

    // Restore the seeded grant for the remaining cases.
    psql(`UPDATE ai_script_policies SET unattended_enabled = true WHERE org_id = '${seed.orgId}'`);
  });

  test('an open lane shows the paused banner with its reason and the reset control', async () => {
    psql(`UPDATE ai_script_lane_state SET state = 'open', consecutive_failed_verifications = 2, opened_at = now(), opened_reason = '2 consecutive failed or unknown verifications (threshold 2)' WHERE org_id = '${seed.orgId}'`);
    const settings = new ScriptAuthoringPage(authedPage);
    await settings.goto();
    await expect(settings.laneBanner).toBeVisible();
    await expect(settings.laneBanner).toContainText('threshold 2');
    await expect(settings.laneReset).toBeVisible();

    // Reset is the same privileged transition as enabling: without a factor
    // to step up with, the requirement is surfaced and the lane stays open.
    await settings.laneReset.click();
    await expect(
      authedPage.getByTestId('script-authoring-error').or(authedPage.getByTestId('script-authoring-stepup')),
    ).toBeVisible({ timeout: 30_000 });
    expect(psql(`SELECT state FROM ai_script_lane_state WHERE org_id = '${seed.orgId}'`)).toBe('open');

    psql(`UPDATE ai_script_lane_state SET state = 'closed', consecutive_failed_verifications = 0, opened_at = NULL, opened_reason = NULL WHERE org_id = '${seed.orgId}'`);
    await settings.goto();
    await expect(settings.laneBanner).toHaveCount(0);
  });
});
