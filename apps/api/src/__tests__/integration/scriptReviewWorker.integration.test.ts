import './setup';

import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { beforeEach, expect, it, vi } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { aiBudgetReservations, aiInvocations, scriptProposalReviews, scriptProposals } from '../../db/schema';
import { seedRegistryPartner } from './helpers/aiModelRegistrySeed';

/**
 * AI script authoring W02 — `runScriptReview` against a real Postgres: the
 * reviews chain (static_scan → model), the proposed → reviewed /
 * review_failed transition, classifier-derived floors, the budget
 * reservation settling exactly once, retry idempotency, and the inline
 * wait (`waitForReviewCompletion`) returning the MODEL row, never the
 * static-scan row. Only the Anthropic client is faked — `resolveModel` (the
 * org's `script_reviewer` assignment on a seeded registry partner),
 * `aiBudgetReservations`, `settleInvocation`, `transitionProposal` and the
 * RLS-enforced writes are all real.
 */
const runDb = it.runIf(!!process.env.DATABASE_URL);

const { messagesCreateMock, createMessageOverride } = vi.hoisted(() => ({
  messagesCreateMock: vi.fn(),
  // Set by one case to fail the dispatch the way createMessage does when a
  // refusal's client-side fallback throws; null = the real createMessage.
  createMessageOverride: { fn: null as null | ((...args: unknown[]) => Promise<never>) },
}));

vi.mock('../../services/aiModels/connectionFactory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/aiModels/connectionFactory')>();
  return {
    ...actual,
    // Only the client is faked; resolveModel, createMessage, settlement and the
    // reservation are the real ones.
    anthropicClientFor: vi.fn(() => ({ messages: { create: messagesCreateMock } })),
    createMessage: (...args: Parameters<typeof actual.createMessage>) =>
      createMessageOverride.fn ? createMessageOverride.fn(...args) : actual.createMessage(...args),
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
  const seeded = await seedRegistryPartner('platform');
  return { partner: { id: seeded.partnerId }, org: { id: seeded.orgId }, modelId: seeded.modelId };
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
  // The seeded platform connection is only usable on a deployment with a platform key.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-script-review-integration-placeholder';
  messagesCreateMock.mockReset();
  createMessageOverride.fn = null;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

runDb('a clean proposal becomes reviewed: static_scan + model rows, classifier floor applied, reservation settled once', async () => {
  const { org, modelId } = await seedOrg();
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
    // The model is the org's script_reviewer assignment (W03), not the env default.
    model: modelId, inputTokens: 420, outputTokens: 90, goalMatch: 'yes', reversible: true,
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

  // One ledger row, priced from the registry rate bound at admission (200/1000
  // cents per M): 420 in + 90 out = 0.084 + 0.09 cents.
  const ledger = await withSystemDbAccessContext(() =>
    db.select().from(aiInvocations).where(eq(aiInvocations.orgId, org.id)));
  expect(ledger).toHaveLength(1);
  expect(ledger[0]).toMatchObject({ surface: 'script_reviewer', sourceRef: `script-review:${proposal.id}`, fundingSource: 'platform' });
  expect(Number(ledger[0]!.costCents)).toBeCloseTo(0.174, 4);

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

runDb('a refused attempt whose fallback call then fails is BILLED: reservation settled at its real cost, one ledger row', async () => {
  const { org, modelId } = await seedOrg();
  const proposal = await seedProposedProposal(org.id);
  const { MessageDispatchError } = await import('../../services/aiModels/connectionFactory');
  const timeout = new Error('The operation was aborted due to timeout');
  timeout.name = 'TimeoutError';
  createMessageOverride.fn = async () => {
    throw new MessageDispatchError([{ wireModel: modelId, message: {
      model: modelId, stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [],
      usage: { input_tokens: 420, output_tokens: 90 },
    } as never }], timeout);
  };

  const review = await runScriptReview({ proposalId: proposal.id, orgId: org.id, attempt: 1 });

  // Classified on the underlying cause, as before.
  expect(review).toMatchObject({ reviewerKind: 'model', status: 'timeout' });
  const [reservation] = await reservationsFor(org.id);
  expect(reservation).toMatchObject({ status: 'settled' });
  // 420 in + 90 out at the registry rate (200/1000 cents per M) — not zero.
  expect(Number(reservation!.actualCostCents)).toBeCloseTo(0.174, 4);
  const ledger = await withSystemDbAccessContext(() =>
    db.select().from(aiInvocations).where(eq(aiInvocations.orgId, org.id)));
  expect(ledger).toHaveLength(1);
  expect(ledger[0]).toMatchObject({ stopReason: 'error', refusalCategory: 'cyber' });
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
