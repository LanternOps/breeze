import './setup';

import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { aiSessions, scriptProposals } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import {
  attachProposalToSession, consumeProposalForIntent, createScriptProposal,
} from '../../services/scriptProposals';

/**
 * AI script authoring W01b — live-DB coverage that a mocked route test cannot
 * see: (1) proposal creation inside a real request transaction must not
 * poison it (a caught error inside `withDbAccessContext` still aborts the tx
 * and turns a mapped 409 into a 500 at commit); (2) the single-consumption
 * CAS is only real under concurrent transactions; (3) the chat session
 * back-fill is org-scoped.
 */
const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgContext(orgId: string, userId: string | null = null): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId };
}

async function seedOrg() {
  const partner = await withSystemDbAccessContext(() => createPartner());
  const org = await withSystemDbAccessContext(() => createOrganization({ partnerId: partner.id }));
  return { partner, org };
}

async function seedReviewedProposal(orgId: string, deviceId: string): Promise<string> {
  const auth = { orgId, user: { id: null }, principal: { kind: 'user_session' } } as never;
  const { proposal } = await withDbAccessContext(orgContext(orgId), () =>
    createScriptProposal(auth, {
      language: 'bash', content: 'echo hi', goal: 'g', expectedEffect: 'e',
      verification: { kind: 'exit_code', equals: 0 }, deviceIds: [deviceId],
      runAs: 'system', timeoutSeconds: 60,
    }, { kind: 'chat_session', sessionId: null }));
  await withSystemDbAccessContext(() => db.update(scriptProposals)
    .set({ status: 'reviewed', riskTier: 'low' }).where(eq(scriptProposals.id, proposal.id)));
  return proposal.id;
}

runDb('creates a proposal inside a real request transaction without poisoning it', async () => {
  const { org } = await seedOrg();
  const proposalId = await seedReviewedProposal(org.id, org.id);

  // The tx must still be usable AFTER the write — the 409-becomes-500 trap is
  // a transaction that was silently aborted by a caught error earlier in it.
  const rows = await withDbAccessContext(orgContext(org.id), async () => {
    await db.select().from(scriptProposals).where(eq(scriptProposals.id, proposalId));
    return db.select().from(scriptProposals).where(eq(scriptProposals.orgId, org.id));
  });
  expect(rows.length).toBeGreaterThan(0);
  expect(rows[0]!.contentDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(rows[0]!.status).toBe('reviewed');
});

runDb('exactly one of two concurrent run_script calls consumes the proposal', async () => {
  const { org } = await seedOrg();
  const proposalId = await seedReviewedProposal(org.id, org.id);

  const [a, b] = await Promise.all([
    withSystemDbAccessContext(() => consumeProposalForIntent(db, proposalId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')),
    withSystemDbAccessContext(() => consumeProposalForIntent(db, proposalId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')),
  ]);

  expect([a, b].filter(Boolean)).toHaveLength(1);
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(scriptProposals).where(eq(scriptProposals.id, proposalId)));
  expect(row!.intentId).not.toBeNull();
  // Status is left at `reviewed` — the approval lifecycle belongs to the intent.
  expect(row!.status).toBe('reviewed');
});

runDb('a consumed proposal cannot be consumed again, and an expired one never can', async () => {
  const { org } = await seedOrg();

  const consumed = await seedReviewedProposal(org.id, org.id);
  await withSystemDbAccessContext(() => consumeProposalForIntent(db, consumed, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
  await expect(withSystemDbAccessContext(() =>
    consumeProposalForIntent(db, consumed, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'))).resolves.toBe(false);

  // `expires_at` is trigger-immutable, so an expired proposal has to be born
  // expired: seeded directly rather than aged after the fact.
  const [staleRow] = await withSystemDbAccessContext(() => db.insert(scriptProposals).values({
    orgId: org.id, authorKind: 'chat_session', language: 'bash', content: 'echo stale',
    contentDigest: 'c'.repeat(64), timeoutSeconds: 60, goal: 'g', expectedEffect: 'e',
    verification: { kind: 'exit_code', equals: 0 }, targetDeviceIds: [org.id],
    scannerVersion: '2026-09-11.1', status: 'reviewed', riskTier: 'low',
    expiresAt: new Date(Date.now() - 1000),
  }).returning({ id: scriptProposals.id }));
  await expect(withSystemDbAccessContext(() =>
    consumeProposalForIntent(db, staleRow!.id, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'))).resolves.toBe(false);
});

runDb('the chat session back-fill sets session_id once, org-scoped, and never for a foreign-org proposal', async () => {
  const { partner, org } = await seedOrg();
  const other = await withSystemDbAccessContext(() => createOrganization({ partnerId: partner.id }));
  const user = await withSystemDbAccessContext(() => createUser({ partnerId: partner.id, orgId: org.id }));
  const [session] = await withSystemDbAccessContext(() => db.insert(aiSessions).values({
    orgId: org.id, userId: user.id, title: 'sp-test',
  }).returning({ id: aiSessions.id }));
  const proposalId = await seedReviewedProposal(org.id, org.id);
  const foreignId = await seedReviewedProposal(other.id, other.id);

  // Same org: attributed.
  await expect(withDbAccessContext(orgContext(org.id), () =>
    attachProposalToSession(proposalId, org.id, session!.id))).resolves.toBe(true);
  // Foreign org's proposal id, caller's org: NOT attributed (org predicate + RLS).
  await expect(withDbAccessContext(orgContext(org.id), () =>
    attachProposalToSession(foreignId, org.id, session!.id))).resolves.toBe(false);
  // Second attribution is a no-op (session_id IS NULL guard).
  await expect(withDbAccessContext(orgContext(org.id), () =>
    attachProposalToSession(proposalId, org.id, session!.id))).resolves.toBe(false);

  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(scriptProposals).where(eq(scriptProposals.id, proposalId)));
  expect(row!.sessionId).toBe(session!.id);
  const [foreign] = await withSystemDbAccessContext(() =>
    db.select().from(scriptProposals).where(eq(scriptProposals.id, foreignId)));
  expect(foreign!.sessionId).toBeNull();
});
