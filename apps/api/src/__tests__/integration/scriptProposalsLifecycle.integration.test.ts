import './setup';

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { devices, scriptExecutions, scriptProposalReviews, scriptProposals } from '../../db/schema';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { executeOrgMerge } from '../../services/orgMerge';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { __testOnly as aiToolsScriptsTestOnly } from '../../services/aiToolsScripts';

// The proposal branch of run_script waits up to 60 s for the agent's result;
// no agent is attached here, so the wait is short-circuited. `queueCommand` and
// the rest of the module stay real — the execution row under test is written
// by the REAL dispatch path.
vi.mock('../../services/commandQueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/commandQueue')>()),
  waitForCommandResult: async (id: string) => ({ id, result: { status: 'completed', exitCode: 0 } }),
}));
vi.mock('../../config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config/env')>()),
  aiScriptAuthoringEnabled: () => true,
}));

/**
 * AI script authoring W01b — org erasure and org-merge fence coverage for
 * `script_proposals` / `script_proposal_reviews` (spec §5), plus (#5645) the
 * §4.1 provenance snapshot written by a real release.
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

// #5645 — `script_executions.approval_method` is the §4.1 provenance snapshot
// the W06 risk dashboard ("unattended runs") and the device-activity audit row
// derive from. It must be DERIVED from the releasing intent's decision record
// (§4.6), and this is the only place the derived value is proven to reach a
// real row through the real dispatch path (`buildExecutionValues` is mocked
// everywhere else).
runDb('a reviewer-decided (unattended) release stamps unattended_reviewer_gated on the execution row', async () => {
  const partner = await withSystemDbAccessContext(() => createPartner());
  const org = await withSystemDbAccessContext(() => createOrganization({ partnerId: partner.id }));
  const user = await withSystemDbAccessContext(() => createUser({
    partnerId: partner.id, orgId: org.id, email: `sp-method-${randomUUID().slice(0, 8)}@example.test`,
  }));
  const site = await withSystemDbAccessContext(() => createSite({ orgId: org.id }));
  // Online, but its agent has no live socket: the command stays pending
  // rather than being sent, and the mocked wait above returns at once.
  const [device] = await withSystemDbAccessContext(() => db.insert(devices).values({
    orgId: org.id, siteId: site.id, agentId: `sp-method-agent-${randomUUID()}`, hostname: `sp-method-${randomUUID().slice(0, 6)}`,
    osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
  }).returning({ id: devices.id }));
  const intentId = randomUUID();
  const [proposal] = await withSystemDbAccessContext(() => db.insert(scriptProposals).values({
    orgId: org.id, authorKind: 'chat_session', language: 'powershell', content: 'Get-Date',
    contentDigest: 'b'.repeat(64), timeoutSeconds: 60, runAs: 'system', goal: 'g', expectedEffect: 'e',
    verification: { kind: 'exit_code', equals: 0 }, targetDeviceIds: [device!.id],
    scannerVersion: '2026-09-11.1', status: 'reviewed', riskTier: 'low', intentId,
    expiresAt: new Date(Date.now() + 3600_000),
  }).returning());

  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([org.id]);
  const auth = {
    principal: { kind: 'user_session' },
    user: { id: user.id, email: user.email, name: 'U', isPlatformAdmin: false },
    partnerId: partner.id, orgId: org.id, scope: 'organization', accessibleOrgIds: [org.id], orgCondition, canAccessOrg,
  } as AuthContext;

  // Exactly the context bag both release paths build for a lane intent
  // (jobs/intentReleaseWorker.ts, services/aiAgentSdk.ts): the id it is
  // releasing plus that intent's decision record.
  const out = JSON.parse(await withDbAccessContext(
    { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id], accessiblePartnerIds: [], userId: user.id },
    () => aiToolsScriptsTestOnly.runScriptHandler(
      { proposalId: proposal!.id, deviceIds: [device!.id] },
      auth,
      { actionIntentId: intentId, releaseDecision: { approvalScope: 'supervised', decidedVia: 'script_reviewer' } },
    ),
  ));
  expect(out.results[device!.id].error, JSON.stringify(out)).toBeUndefined();

  const rows = await withSystemDbAccessContext(() =>
    db.select().from(scriptExecutions).where(eq(scriptExecutions.proposalId, proposal!.id)));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.sourceKind).toBe('proposal');
  expect(rows[0]!.approvedBy).toBe(user.id);
  expect(rows[0]!.approvalMethod).toBe('unattended_reviewer_gated');
});
