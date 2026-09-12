import './setup';

import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { beforeEach, expect, it, vi } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { aiBudgetReservations, scriptProposalReviews, scriptProposals } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

/**
 * AI script authoring W02 — `runScriptReview` against a real Postgres: the
 * reviews chain (static_scan → model), the proposed → reviewed /
 * review_failed transition, classifier-derived floors, the budget
 * reservation settling exactly once, retry idempotency, and the inline
 * wait (`waitForReviewCompletion`) returning the MODEL row, never the
 * static-scan row. Only the Anthropic client is faked — `llmConfigResolver`'s
 * billing-source resolution, `aiBudgetReservations`, `aiCostTracker`,
 * `transitionProposal` and the RLS-enforced writes are all real.
 */
const runDb = it.runIf(!!process.env.DATABASE_URL);

const { messagesCreateMock } = vi.hoisted(() => ({ messagesCreateMock: vi.fn() }));

vi.mock('../../services/llm/llmConfigResolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/llm/llmConfigResolver')>();
  return {
    ...actual,
    getAnthropicClientForPartner: vi.fn(async () => ({
      client: { messages: { create: messagesCreateMock } },
      resolved: { source: 'platform', model: 'claude-sonnet-4-6', catalog: null },
    })),
    resolveWireModel: vi.fn((_resolved: unknown, model: string) => ({ model })),
  };
});

import { runScriptReview } from '../../services/scriptProposals/reviewer';
import { waitForReviewCompletion } from '../../services/scriptProposals/reviewQueue';

const VALID_VERDICT = {
  summary: 'Restarts the print spooler service.',
  goalMatch: 'yes',
  riskTier: 'low',
  blastRadius: ['spooler queue drains'],
  reversible: true,
  verificationAdequate: true,
  findings: [{ severity: 'info', text: 'No destructive operations detected.' }],
  recommendedAction: 'approve',
};

async function seedOrg() {
  const partner = await withSystemDbAccessContext(() => createPartner());
  const org = await withSystemDbAccessContext(() => createOrganization({ partnerId: partner.id }));
  return { partner, org };
}

async function seedProposedProposal(orgId: string, touchClasses: string[] = ['services']) {
  return withSystemDbAccessContext(async () => {
    const [proposal] = await db.insert(scriptProposals).values({
      orgId, authorKind: 'chat_session', language: 'powershell', content: 'Restart-Service -Name Spooler',
      contentDigest: randomUUID().replace(/-/g, '').padEnd(64, '0'), timeoutSeconds: 60,
      goal: 'Fix the print queue', expectedEffect: 'Spooler restarts',
      verification: { kind: 'service_running', name: 'Spooler' }, targetDeviceIds: [randomUUID()],
      scannerVersion: '2026-09-11.1', basicHits: [], strictHits: [], touchClasses,
      status: 'proposed', expiresAt: new Date(Date.now() + 3600_000),
    }).returning();
    return proposal!;
  });
}

async function reviewsFor(proposalId: string) {
  return withSystemDbAccessContext(() =>
    db.select().from(scriptProposalReviews)
      .where(eq(scriptProposalReviews.proposalId, proposalId))
      .orderBy(asc(scriptProposalReviews.createdAt)));
}

async function proposalById(proposalId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(scriptProposals).where(eq(scriptProposals.id, proposalId)));
  return row!;
}

async function reservationsFor(orgId: string) {
  return withSystemDbAccessContext(() =>
    db.select().from(aiBudgetReservations).where(eq(aiBudgetReservations.orgId, orgId)));
}

beforeEach(() => {
  messagesCreateMock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

runDb('a clean proposal becomes reviewed: static_scan + model rows, classifier floor applied, reservation settled once', async () => {
  const { org } = await seedOrg();
  // `credentials` is a HIGH floor class; the model under-scores it as `low`.
  const proposal = await seedProposedProposal(org.id, ['credentials']);
  messagesCreateMock.mockResolvedValueOnce({
    usage: { input_tokens: 420, output_tokens: 90 },
    content: [{ type: 'text', text: JSON.stringify(VALID_VERDICT) }],
  });

  const review = await runScriptReview({ proposalId: proposal.id, orgId: org.id, attempt: 1 });

  expect(review).toMatchObject({ reviewerKind: 'model', status: 'completed', riskTier: 'high', recommendedAction: 'approve' });
  expect(messagesCreateMock).toHaveBeenCalledTimes(1);

  const rows = await reviewsFor(proposal.id);
  expect(rows.map((r) => [r.reviewerKind, r.status])).toEqual([['static_scan', 'completed'], ['model', 'completed']]);
  expect(rows[1]).toMatchObject({
    model: 'claude-sonnet-4-6', inputTokens: 420, outputTokens: 90, goalMatch: 'yes', reversible: true,
    verificationAdequate: true,
  });
  expect(rows[1]!.budgetReservationId).toBeTruthy();
  // The persisted verdict carries the FLOORED tier, not the model's own.
  expect((rows[1]!.verdict as { riskTier: string }).riskTier).toBe('high');

  const after = await proposalById(proposal.id);
  expect(after.status).toBe('reviewed');
  expect(after.riskTier).toBe('high');

  const reservations = await reservationsFor(org.id);
  expect(reservations).toHaveLength(1);
  expect(reservations[0]).toMatchObject({
    idempotencyKey: `script-review:${proposal.id}:1`, status: 'settled', billingSource: 'platform',
  });
  expect(reservations[0]!.id).toBe(rows[1]!.budgetReservationId);

  // The inline wait W01b's propose_script uses returns the MODEL row.
  const awaited = await waitForReviewCompletion(proposal.id, 5_000);
  expect(awaited).toMatchObject({ id: rows[1]!.id, reviewerKind: 'model' });
});

runDb('a retry of the same job after success is a no-op: same row back, no second model call, no second reservation', async () => {
  const { org } = await seedOrg();
  const proposal = await seedProposedProposal(org.id);
  messagesCreateMock.mockResolvedValue({
    usage: { input_tokens: 100, output_tokens: 20 },
    content: [{ type: 'text', text: JSON.stringify(VALID_VERDICT) }],
  });

  const first = await runScriptReview({ proposalId: proposal.id, orgId: org.id, attempt: 1 });
  const second = await runScriptReview({ proposalId: proposal.id, orgId: org.id, attempt: 1 });

  expect(second.id).toBe(first.id);
  expect(messagesCreateMock).toHaveBeenCalledTimes(1);
  expect(await reviewsFor(proposal.id)).toHaveLength(2);
  expect(await reservationsFor(org.id)).toHaveLength(1);
});

runDb('an unparseable verdict fails closed: model row failed, proposal review_failed, reservation still settled', async () => {
  const { org } = await seedOrg();
  const proposal = await seedProposedProposal(org.id);
  messagesCreateMock.mockResolvedValueOnce({
    usage: { input_tokens: 300, output_tokens: 40 },
    content: [{ type: 'text', text: 'I refuse to answer in JSON.' }],
  });

  const review = await runScriptReview({ proposalId: proposal.id, orgId: org.id, attempt: 1 });

  expect(review).toMatchObject({ reviewerKind: 'model', status: 'failed', riskTier: null, inputTokens: 300, outputTokens: 40 });
  const rows = await reviewsFor(proposal.id);
  expect(rows.map((r) => [r.reviewerKind, r.status])).toEqual([['static_scan', 'completed'], ['model', 'failed']]);

  const after = await proposalById(proposal.id);
  expect(after.status).toBe('review_failed');
  expect(after.riskTier).toBeNull();
  expect(after.decisionNote).toContain('parseable');

  const reservations = await reservationsFor(org.id);
  expect(reservations).toHaveLength(1);
  expect(reservations[0]!.status).toBe('settled');

  // The failed model row is what the inline wait reports — never the scan row.
  const awaited = await waitForReviewCompletion(proposal.id, 5_000);
  expect(awaited).toMatchObject({ reviewerKind: 'model', status: 'failed' });
});

runDb('a provider timeout fails closed with a timeout-classified row and the reservation settled at zero', async () => {
  const { org } = await seedOrg();
  const proposal = await seedProposedProposal(org.id);
  const timeout = new Error('The operation was aborted due to timeout');
  timeout.name = 'TimeoutError';
  messagesCreateMock.mockRejectedValueOnce(timeout);

  const review = await runScriptReview({ proposalId: proposal.id, orgId: org.id, attempt: 1 });

  expect(review).toMatchObject({ reviewerKind: 'model', status: 'timeout', inputTokens: 0, outputTokens: 0 });
  expect((await proposalById(proposal.id)).status).toBe('review_failed');
  const [reservation] = await reservationsFor(org.id);
  expect(reservation).toMatchObject({ status: 'settled' });
  expect(Number(reservation!.actualCostCents)).toBe(0);
});

runDb('a proposal in a different org is invisible to the job: nothing written, nothing reserved', async () => {
  const { org } = await seedOrg();
  const { org: otherOrg } = await seedOrg();
  const proposal = await seedProposedProposal(otherOrg.id);

  await expect(runScriptReview({ proposalId: proposal.id, orgId: org.id, attempt: 1 }))
    .rejects.toMatchObject({ name: 'ProposalNotReviewableError' });

  expect(messagesCreateMock).not.toHaveBeenCalled();
  expect(await reviewsFor(proposal.id)).toHaveLength(0);
  expect((await proposalById(proposal.id)).status).toBe('proposed');
  expect(await reservationsFor(org.id)).toHaveLength(0);
});
