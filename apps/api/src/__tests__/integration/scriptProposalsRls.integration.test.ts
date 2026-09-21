import './setup';

import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { scriptProposalReviews, scriptProposals } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

/**
 * AI script authoring W01b — RLS forge, immutability and append-only coverage
 * for `script_proposals` / `script_proposal_reviews` (spec §5, §7).
 *
 * Why the second half of each forge matters: an insert-only 42501 test passes
 * for the wrong reason when the `breeze_app` GRANT is missing. Each forge is
 * therefore paired with a positive control proving org A sees the row and org
 * B sees none.
 */
const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

async function seedTwoOrgs() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const [proposal] = await db.insert(scriptProposals).values({
      orgId: orgA.id, authorKind: 'chat_session', language: 'bash',
      content: 'echo hi', contentDigest: 'a'.repeat(64), timeoutSeconds: 60,
      goal: 'g', expectedEffect: 'e', verification: { kind: 'exit_code', equals: 0 },
      targetDeviceIds: [orgA.id], scannerVersion: '2026-09-11.1', status: 'reviewed',
      expiresAt: new Date(Date.now() + 3600_000),
    }).returning();
    return { orgAId: orgA.id, orgBId: orgB.id, proposalId: proposal!.id };
  });
}

runDb('refuses a forged cross-tenant script_proposals insert with 42501', async () => {
  const { orgAId, orgBId } = await seedTwoOrgs();
  await expect(
    withDbAccessContext(orgContext(orgBId), () => db.insert(scriptProposals).values({
      orgId: orgAId, authorKind: 'chat_session', language: 'bash', content: 'echo forged',
      contentDigest: 'b'.repeat(64), timeoutSeconds: 60, goal: 'g', expectedEffect: 'e',
      verification: { kind: 'exit_code', equals: 0 }, targetDeviceIds: [orgAId],
      scannerVersion: '2026-09-11.1', expiresAt: new Date(Date.now() + 3600_000),
    })),
    // A Drizzle insert rejection wraps the Postgres error under `.cause`.
  ).rejects.toMatchObject({ cause: { code: '42501' } });
});

runDb('positive control: org A sees its proposal and org B sees none', async () => {
  const { orgAId, orgBId, proposalId } = await seedTwoOrgs();
  const seen = await withDbAccessContext(orgContext(orgAId), () =>
    db.select().from(scriptProposals).where(eq(scriptProposals.id, proposalId)));
  expect(seen).toHaveLength(1);
  const unseen = await withDbAccessContext(orgContext(orgBId), () =>
    db.select().from(scriptProposals).where(eq(scriptProposals.id, proposalId)));
  expect(unseen).toHaveLength(0);
});

runDb('refuses a forged cross-tenant script_proposal_reviews insert with 42501', async () => {
  const { orgAId, orgBId, proposalId } = await seedTwoOrgs();
  await expect(
    withDbAccessContext(orgContext(orgBId), () => db.insert(scriptProposalReviews).values({
      orgId: orgAId, proposalId, reviewerKind: 'model', status: 'completed', riskTier: 'low',
    })),
  ).rejects.toMatchObject({ cause: { code: '42501' } });
});

runDb('positive control: a review written for org A is visible to org A and invisible to org B', async () => {
  const { orgAId, orgBId, proposalId } = await seedTwoOrgs();
  const [review] = await withDbAccessContext(orgContext(orgAId), () => db.insert(scriptProposalReviews).values({
    orgId: orgAId, proposalId, reviewerKind: 'model', status: 'completed', riskTier: 'low',
  }).returning());
  const seen = await withDbAccessContext(orgContext(orgAId), () =>
    db.select().from(scriptProposalReviews).where(eq(scriptProposalReviews.id, review!.id)));
  expect(seen).toHaveLength(1);
  const unseen = await withDbAccessContext(orgContext(orgBId), () =>
    db.select().from(scriptProposalReviews).where(eq(scriptProposalReviews.id, review!.id)));
  expect(unseen).toHaveLength(0);
});

runDb('refuses a review whose org_id disagrees with its proposal (composite FK)', async () => {
  const { orgBId, proposalId } = await seedTwoOrgs();
  await expect(
    withSystemDbAccessContext(() => db.insert(scriptProposalReviews).values({
      orgId: orgBId, proposalId, reviewerKind: 'model', status: 'completed', riskTier: 'low',
    })),
  ).rejects.toMatchObject({ cause: { code: '23503' } });
});

runDb('refuses to mutate proposal content, and allows a lifecycle transition', async () => {
  const { orgAId, proposalId } = await seedTwoOrgs();
  await expect(
    withDbAccessContext(orgContext(orgAId), () =>
      db.update(scriptProposals).set({ content: 'rm -rf /' }).where(eq(scriptProposals.id, proposalId))),
  ).rejects.toMatchObject({ cause: { code: '42501' } });

  await expect(
    withDbAccessContext(orgContext(orgAId), () =>
      db.update(scriptProposals).set({ status: 'expired' }).where(eq(scriptProposals.id, proposalId))),
  ).resolves.toBeDefined();
});

runDb('refuses to update or delete a review as breeze_app — the evidence is append-only', async () => {
  const { orgAId, proposalId } = await seedTwoOrgs();
  const [review] = await withSystemDbAccessContext(() => db.insert(scriptProposalReviews).values({
    orgId: orgAId, proposalId, reviewerKind: 'model', status: 'completed', riskTier: 'low',
    summary: 'restarts the spooler',
  }).returning());

  await expect(
    withDbAccessContext(orgContext(orgAId), () => db.update(scriptProposalReviews)
      .set({ summary: 'rewritten' }).where(eq(scriptProposalReviews.id, review!.id))),
  ).rejects.toMatchObject({ cause: { code: expect.stringMatching(/^(42501|55000)$/) } });

  await expect(
    withDbAccessContext(orgContext(orgAId), () => db.delete(scriptProposalReviews)
      .where(eq(scriptProposalReviews.id, review!.id))),
  ).rejects.toMatchObject({ cause: { code: expect.stringMatching(/^(42501|55000)$/) } });
});
