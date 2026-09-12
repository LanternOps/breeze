import { test, expect } from '../fixtures';
import { STORAGE_STATE } from '../global-setup';
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
  strictId: string;
  strictApprovalId: string;
  cleanId: string;
  cleanApprovalId: string;
  verifiedId: string;
}

/** Runs seed-script-proposal.sql inside the stack's Postgres; returns the ids it printed. */
function seedProposals(): Seed {
  const sqlPath = path.resolve(__dirname, '..', 'seed-script-proposal.sql');
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
    strictId: pick('STRICT_ID'),
    strictApprovalId: pick('STRICT_APPROVAL_ID'),
    cleanId: pick('CLEAN_ID'),
    cleanApprovalId: pick('CLEAN_APPROVAL_ID'),
    verifiedId: pick('VERIFIED_ID'),
  };
}

/**
 * The AI-authored script loop end to end (spec §7 "E2E", W03 #5612).
 *
 * The proposals, reviews, intents and approval rows are SEEDED
 * (seed-script-proposal.sql): a real propose_script turn needs a live model,
 * which the wt-stack has not got. Everything downstream of the seed is the
 * real code path: the inbox disclosure, the card, the STRICT acknowledgement
 * ceremony through the real decide endpoint (the admin on this stack satisfies
 * the platform's MFA requirement, so its JWT carries `mfa: true`), the
 * deep-linked post-decision surface, Save to library through the real promote
 * route, and the library provenance surfaces it produces.
 *
 * What is NOT here: the dispatch + verification of the approved run (needs an
 * online agent). The verify worker's ladder and the `executed → verified`
 * transition are proven against real Postgres by
 * scriptProposalHumanLoop.integration.test.ts; the VERIFIED proposal is seeded
 * in that end state.
 *
 * Assumes BREEZE_AI_SCRIPT_AUTHORING_ENABLED is on (the default since W03);
 * with it off the card fetch answers feature_disabled and the first test fails
 * on the card wait.
 */
test.describe.configure({ mode: 'serial' });

test.describe('AI script proposals', () => {
  let seed: Seed;
  // ONE browser context for the whole file, not the per-test `authedPage`
  // fixture: refresh-token families are durably revoked on reuse
  // (routes/auth/login.ts, getRefreshFamily), so a second context presenting
  // the shared storageState's already-rotated cookie is treated as replay and
  // lands on "Your session expired". Within one context the cookie jar follows
  // every rotation.
  let ctx: BrowserContext;
  let authedPage: Page;
  let promotedScriptId: string;
  // The dev stack serves Astro + tsx watch: the first approvals list fetch and
  // the card's own proposal fetch can each take several seconds.
  test.setTimeout(120_000);

  test.beforeAll(async ({ browser }) => {
    seed = seedProposals();
    ctx = await browser.newContext({ storageState: STORAGE_STATE });
    authedPage = await ctx.newPage();
  });
  test.afterAll(async () => {
    await ctx?.close();
  });

  test('the approvals inbox shows the script review instead of raw JSON', async () => {
    const page = new ScriptProposalsPage(authedPage);
    await page.gotoApprovals();
    await page.openScriptReview(seed.strictApprovalId);
    await expect(authedPage.getByTestId('script-proposal-card')).toBeVisible();
    await expect(authedPage.getByTestId('script-proposal-risk-low')).toBeVisible();
    await expect(authedPage.getByTestId('script-proposal-goal')).toContainText('Enable the Contoso integration');
    await expect(authedPage.getByTestId('script-proposal-finding-0')).toHaveAttribute('data-severity', 'warning');
    await expect(authedPage.getByTestId('script-proposal-touch-registry')).toBeVisible();
    await expect(authedPage.getByTestId('script-proposal-expiry')).toBeVisible();
  });

  test('the script body is present and the collapse toggle only appears past 40 lines', async () => {
    const page = new ScriptProposalsPage(authedPage);
    await page.gotoApprovals();
    await page.openScriptReview(seed.strictApprovalId);
    // A one-line script is never collapsed and has no toggle.
    await expect(authedPage.getByTestId('script-proposal-body')).toHaveAttribute('data-collapsed', 'false');
    await expect(authedPage.getByTestId('script-proposal-body-toggle')).toHaveCount(0);
  });

  test('Approve stays disabled until the STRICT pattern is acknowledged, then the decision records it', async () => {
    const page = new ScriptProposalsPage(authedPage);
    await page.gotoApprovals();
    await page.openScriptReview(seed.strictApprovalId);
    await expect(authedPage.getByTestId('script-proposal-acknowledgements')).toBeVisible();
    await expect(authedPage.getByTestId('script-proposal-approve-button')).toBeDisabled();
    await authedPage.getByTestId('script-proposal-ack-0').click();
    await expect(authedPage.getByTestId('script-proposal-approve-button')).toBeEnabled();
    await authedPage.getByTestId('script-proposal-approve-button').click();

    // Spec §4.5: (submitted ∩ strict_hits) lands on the proposal in the same
    // transaction as the approval CAS.
    await expect
      .poll(() => psql(`SELECT status FROM approval_requests WHERE id = '${seed.strictApprovalId}'`), { timeout: 30_000 })
      .toBe('approved');
    expect(psql(`SELECT acknowledged_patterns::text FROM script_proposals WHERE id = '${seed.strictId}'`)).toContain('HKLM');
    expect(
      psql(`SELECT ai.status FROM action_intents ai JOIN approval_requests ar ON ar.intent_id = ai.id WHERE ar.id = '${seed.strictApprovalId}'`),
    ).not.toBe('pending_approval');
  });

  test('a clean proposal approves with no acknowledgement ceremony', async () => {
    const page = new ScriptProposalsPage(authedPage);
    await page.gotoApprovals();
    await page.openScriptReview(seed.cleanApprovalId);
    await expect(authedPage.getByTestId('script-proposal-acknowledgements')).toHaveCount(0);
    await expect(authedPage.getByTestId('script-proposal-approve-button')).toBeEnabled();
    await authedPage.getByTestId('script-proposal-approve-button').click();

    await expect
      .poll(() => psql(`SELECT status FROM approval_requests WHERE id = '${seed.cleanApprovalId}'`), { timeout: 30_000 })
      .toBe('approved');
    expect(psql(`SELECT acknowledged_patterns::text FROM script_proposals WHERE id = '${seed.cleanId}'`)).toBe('{}');
  });

  test('a verified proposal offers Save to library on its deep link and promotion lands with provenance', async () => {
    const page = new ScriptProposalsPage(authedPage);
    await page.gotoProposal(seed.verifiedId);
    await expect(authedPage.getByTestId('approval-proposal-detail')).toBeVisible();
    await expect(authedPage.getByTestId('script-proposal-verification-state')).toBeVisible();
    // No decision footer on the read-only deep link.
    await expect(authedPage.getByTestId('script-proposal-approve-button')).toHaveCount(0);
    await expect(authedPage.getByTestId('script-proposal-save-to-library')).toBeEnabled();

    await authedPage.getByTestId('script-proposal-save-to-library').click();
    await expect(authedPage.getByTestId('promote-name-input')).toHaveValue('Flush the DNS cache');
    await authedPage.getByTestId('promote-name-input').fill('E2E promoted DNS flush');
    await expect(authedPage.getByTestId('promote-owner-scope-organization')).toBeChecked();
    await authedPage.getByTestId('promote-submit').click();

    await expect
      .poll(() => psql(`SELECT status FROM script_proposals WHERE id = '${seed.verifiedId}'`), { timeout: 30_000 })
      .toBe('promoted');
    promotedScriptId = psql(`SELECT id FROM scripts WHERE origin_proposal_id = '${seed.verifiedId}'`);
    expect(promotedScriptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(psql(`SELECT origin FROM scripts WHERE id = '${promotedScriptId}'`)).toBe('ai_proposal');
    expect(psql(`SELECT count(*) FROM script_versions WHERE script_id = '${promotedScriptId}' AND origin = 'ai_proposal' AND review_id IS NOT NULL`)).toBe('1');
  });

  test('the promoted script shows its origin, Reviewed badge and provenance panel', async () => {
    const page = new ScriptProposalsPage(authedPage);
    await page.gotoScripts();
    await expect(authedPage.getByTestId('script-col-origin')).toBeVisible();
    await authedPage.getByTestId('script-origin-filter').selectOption('ai_proposal');
    await expect(authedPage.getByTestId(`script-row-${promotedScriptId}`)).toBeVisible();
    await expect(authedPage.getByTestId(`script-badge-reviewed-${promotedScriptId}`)).toBeVisible();

    await page.gotoScript(promotedScriptId);
    await expect(authedPage.getByTestId('script-provenance-origin')).toBeVisible();
    await expect(authedPage.getByTestId('script-provenance-review-summary')).toContainText('Flushes the local DNS cache');
    await expect(authedPage.getByTestId('script-provenance-proposal-link')).toHaveAttribute(
      'href', expect.stringContaining(seed.verifiedId),
    );
  });
});
