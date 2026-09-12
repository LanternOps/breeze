import './setup';

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { scriptProposalReviews, scriptProposals } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { executeOrgMerge } from '../../services/orgMerge';

/**
 * AI script authoring W01b — org erasure and org-merge fence coverage for
 * `script_proposals` / `script_proposal_reviews` (spec §5).
 */
const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seedProposalWithReview(orgId: string, status: 'reviewed' | 'promoted' = 'reviewed') {
  return withSystemDbAccessContext(async () => {
    const [proposal] = await db.insert(scriptProposals).values({
      orgId, authorKind: 'chat_session', language: 'bash', content: 'echo hi',
      contentDigest: 'a'.repeat(64), timeoutSeconds: 60, goal: 'g', expectedEffect: 'e',
      verification: { kind: 'exit_code', equals: 0 }, targetDeviceIds: [orgId],
      scannerVersion: '2026-09-11.1', status, expiresAt: new Date(Date.now() + 3600_000),
    }).returning();
    await db.insert(scriptProposalReviews).values({
      orgId, proposalId: proposal!.id, reviewerKind: 'model', status: 'completed', riskTier: 'low',
    });
    return proposal!.id;
  });
}

runDb('org erasure removes reviews before proposals without an FK violation', async () => {
  const partner = await withSystemDbAccessContext(() => createPartner());
  const org = await withSystemDbAccessContext(() => createOrganization({ partnerId: partner.id }));
  const actor = await withSystemDbAccessContext(() => createUser({
    partnerId: partner.id, orgId: null, email: `sp-cascade-${randomUUID().slice(0, 8)}@example.test`,
  }));
  const proposalId = await seedProposalWithReview(org.id);

  const stats = await cascadeDeleteOrg(org.id, actor.id);
  expect(stats.tablesDeleted.organizations).toBe(1);
  expect(stats.tablesDeleted.script_proposal_reviews).toBe(1);
  expect(stats.tablesDeleted.script_proposals).toBe(1);

  const left = await withSystemDbAccessContext(() =>
    db.select().from(scriptProposals).where(eq(scriptProposals.id, proposalId)));
  expect(left).toHaveLength(0);
  const reviewsLeft = await withSystemDbAccessContext(() =>
    db.select().from(scriptProposalReviews).where(eq(scriptProposalReviews.proposalId, proposalId)));
  expect(reviewsLeft).toHaveLength(0);
});

let priorDrain: string | undefined;
beforeEach(() => { priorDrain = process.env.ORG_MERGE_FENCE_DRAIN_MS; process.env.ORG_MERGE_FENCE_DRAIN_MS = '0'; });
afterEach(() => {
  if (priorDrain === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
  else process.env.ORG_MERGE_FENCE_DRAIN_MS = priorDrain;
});

runDb('an org merge expires live proposals in the loser and leaves terminal ones alone', async () => {
  const partner = await withSystemDbAccessContext(() => createPartner());
  const loser = await withSystemDbAccessContext(() => createOrganization({ partnerId: partner.id }));
  const survivor = await withSystemDbAccessContext(() => createOrganization({ partnerId: partner.id }));
  const actor = await withSystemDbAccessContext(() => createUser({
    partnerId: partner.id, orgId: null, email: `sp-merge-${randomUUID().slice(0, 8)}@example.test`,
  }));
  const liveId = await seedProposalWithReview(loser.id, 'reviewed');
  const terminalId = await seedProposalWithReview(loser.id, 'promoted');

  await executeOrgMerge({
    loserOrgId: loser.id,
    survivorOrgId: survivor.id,
    partnerId: partner.id,
    performedBy: actor.id,
    performedByEmail: actor.email,
  });

  const [live] = await withSystemDbAccessContext(() =>
    db.select().from(scriptProposals).where(eq(scriptProposals.id, liveId)));
  const [terminal] = await withSystemDbAccessContext(() =>
    db.select().from(scriptProposals).where(eq(scriptProposals.id, terminalId)));

  expect(live!.status).toBe('expired');
  expect(live!.decisionNote).toContain('organization merge');
  // Left for erasure, NOT repointed: proposal history stays with the source org.
  expect(live!.orgId).toBe(loser.id);
  expect(terminal!.status).toBe('promoted');
  expect(terminal!.orgId).toBe(loser.id);
  // Review evidence stays with its proposal (composite FK held through the
  // deferred-constraint window).
  const reviews = await withSystemDbAccessContext(() =>
    db.select().from(scriptProposalReviews).where(eq(scriptProposalReviews.proposalId, liveId)));
  expect(reviews).toHaveLength(1);
  expect(reviews[0]!.orgId).toBe(loser.id);
});
