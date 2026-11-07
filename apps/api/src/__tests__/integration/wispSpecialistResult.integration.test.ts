/**
 * Wisp delegation W2 (#11085) — the specialist post-back and continuation
 * against real Postgres. The unit suites mock the rows; what only SQL can prove
 * is here:
 *   - exactly one post per (run, status) and per (intent, status), whatever
 *     retries (Review Focus 5), with `org_id` = the run's org;
 *   - the reconciler re-sweep finds a run with no post, posts it once, and
 *     then no longer finds it (the NOT EXISTS on the dedupe key);
 *   - a run stopped by a paused grant still posts and says why (Review Focus 2);
 *     a revoked grant, or an org out of the ceiling, posts nothing;
 *   - a continuation's seed reads the prior run's real intents and labels, and
 *     a second continuation replays the first.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: vi.fn(async () => 'test-event-id') };
});

import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  actionIntents, aiAgentRuns, aiAgents, approvalRequests, devices, partnerUsers, userNotifications, wispGrantRevisions, wispGrants, wispThreadPosts,
} from '../../db/schema';
import type { WispCeilingSnapshot } from '../../db/schema/wisp';
import { createActionIntent } from '../../services/actionIntents/intentService';
import { buildAgentAuthContext } from '../../services/aiAgents/agentAuthContext';
import { registerAgentRunEnqueuer } from '../../services/aiAgents/runService';
import { selectRunIntentsForCaller } from '../../services/aiAgents/runIntentsForCaller';
import { CONTINUATION_NO_REPEAT_LINE } from '../../services/aiAgents/troubleshootProfile';
import type { AuthContext } from '../../middleware/auth';
import { requestSpecialist } from '../../services/wisp/coordinator';
import {
  postSpecialistResult,
  postSpecialistStepOutcome,
  resweepSpecialistResults,
  specialistResultDedupeKey,
  specialistStepDedupeKey,
} from '../../services/wisp/specialistResult';
import {
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { usePlatformAiKeyPlaceholder } from './helpers/platformAiKey';

usePlatformAiKeyPlaceholder();

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
const sys = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);

const PERMS = [
  { resource: 'ai_sessions', action: 'use' },
  { resource: 'ai_agents', action: 'write' },
  { resource: 'devices', action: 'read' },
  { resource: 'devices', action: 'write' },
  { resource: 'devices', action: 'execute' },
];

async function seedTenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  // A second org inside the ceiling: narrowing the grantor to it alone leaves
  // the grant live but the run's org out of reach.
  const otherOrg = await createOrganization({ partnerId: partner.id });
  const grantor = await createUser({ partnerId: partner.id, email: `wisp-post-${randomUUID()}@wisp.test` });
  const role = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(role.id, PERMS);
  await assignUserToPartner(grantor.id, partner.id, role.id, 'all');
  const admin = await createUser({ partnerId: partner.id, email: `wisp-post-admin-${randomUUID()}@wisp.test` });
  const adminRole = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(adminRole.id, [{ resource: '*', action: '*' }]);
  await assignUserToPartner(admin.id, partner.id, adminRole.id, 'all');

  const site = await createSite({ orgId: org.id });
  const unique = randomUUID().slice(0, 8);
  const [device] = await sys(() => db.insert(devices).values({
    orgId: org.id, siteId: site.id, agentId: `wisp-post-${unique}`, hostname: `wisp-post-${unique}`,
    osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
  }).returning({ id: devices.id, hostname: devices.hostname }));

  const grant = await sys(async () => {
    const [g] = await db.insert(wispGrants).values({
      partnerId: partner.id, orgId: null, grantorUserId: grantor.id, status: 'active',
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    }).returning({ id: wispGrants.id });
    const snapshot: WispCeilingSnapshot = {
      version: 1, permissionKeys: PERMS.map((p) => `${p.resource}:${p.action}`), orgIds: [org.id, otherOrg.id], siteIds: null,
      toolAllowlist: null, deniedTools: [],
    };
    const [r] = await db.insert(wispGrantRevisions).values({
      grantId: g!.id, partnerId: partner.id, revision: 1, ceilingSnapshot: snapshot,
      factorProof: { method: 'step_up', verifiedAt: new Date().toISOString() },
    }).returning({ id: wispGrantRevisions.id });
    await db.update(wispGrants).set({ currentRevisionId: r!.id }).where(eq(wispGrants.id, g!.id));
    return { grantId: g!.id, revisionId: r!.id };
  });
  const approver = {
    principal: { kind: 'user_session' },
    user: { id: grantor.id, email: 'grantor@wisp.test', name: 'Grantor', isPlatformAdmin: false },
    token: null, partnerId: partner.id, orgId: null, scope: 'partner',
    accessibleOrgIds: [org.id], partnerOrgAccess: 'all',
    orgCondition: () => undefined, canAccessOrg: (id: string) => id === org.id,
  } as unknown as AuthContext;
  return { partner, org, otherOrg, grantor, admin, deviceId: device!.id, hostname: device!.hostname, grant, approver };
}

type Tenant = Awaited<ReturnType<typeof seedTenant>>;

/** A real admission through the coordinator (user path), returning the run and its agent auth. */
async function admit(t: Tenant, params: Record<string, unknown> = {}) {
  const requestId = randomUUID();
  const result = await requestSpecialist(
    {
      grantId: t.grant.grantId, grantRevisionId: t.grant.revisionId, orgId: t.org.id, kind: 'device_troubleshooting',
      params: { deviceId: t.deviceId, goal: 'Outlook crashes on start', ...params }, requestedByRunId: null,
    },
    { requester: { kind: 'user', auth: t.approver }, requestId },
  );
  expect(result).toMatchObject({ admitted: true });
  const runId = (result as { runId: string }).runId;
  const [run] = await sys(() => db.select().from(aiAgentRuns).where(eq(aiAgentRuns.id, runId)));
  const [agent] = await sys(() => db.select().from(aiAgents).where(eq(aiAgents.id, run!.agentId)));
  const [device] = await sys(() => db.select({ siteId: devices.siteId }).from(devices).where(eq(devices.id, t.deviceId)));
  const auth = buildAgentAuthContext(
    agent!,
    { id: run!.id, orgId: t.org.id, deviceId: t.deviceId, deviceSiteId: device!.siteId },
    { id: t.org.id, partnerId: t.partner.id },
  );
  return { runId, auth, requestId };
}

const settle = (runId: string, status: string, extra: Record<string, unknown> = {}) =>
  sys(() => db.update(aiAgentRuns).set({ status, finishedAt: new Date(), ...extra } as never).where(eq(aiAgentRuns.id, runId)));

const postsFor = (grantId: string) =>
  sys(() => db.select().from(wispThreadPosts).where(and(eq(wispThreadPosts.grantId, grantId), eq(wispThreadPosts.kind, 'specialist_result'))));

const propose = (t: Tenant, auth: AuthContext, summary: string) => createActionIntent(auth, {
  toolName: 'set_device_context',
  input: { deviceId: t.deviceId, contextType: 'issue', summary },
  source: 'ai_agent',
  orgId: t.org.id,
});

beforeEach(() => {
  vi.stubEnv('IS_HOSTED', 'true');
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('BREEZE_WISP_ENABLED', 'true');
  registerAgentRunEnqueuer(async (runId) => ({ enqueued: true, jobId: `agent-run:${runId}` }));
});
afterEach(() => {
  registerAgentRunEnqueuer(null);
  vi.unstubAllEnvs();
});

describe('postSpecialistResult (real Postgres)', () => {
  it('a completed run writes one post + one notification with the run org and link; a retry writes nothing more', async () => {
    const t = await seedTenant();
    const { runId } = await admit(t);
    await settle(runId, 'completed', { summary: 'Outlook profile is corrupt.' });

    await expect(postSpecialistResult(runId)).resolves.toEqual({ posted: true });
    await expect(postSpecialistResult(runId)).resolves.toEqual({ posted: false, reason: 'already_posted' });

    const posts = await postsFor(t.grant.grantId);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      orgId: t.org.id,
      kind: 'specialist_result',
      link: `/ai-agents/runs/${runId}`,
      dedupeKey: specialistResultDedupeKey(runId, 'completed'),
      title: `Device troubleshooting on ${t.hostname}: finished`,
    });
    expect(posts[0]!.body).toContain('Outlook profile is corrupt.');
    const notes = await sys(() => db.select().from(userNotifications).where(and(
      eq(userNotifications.userId, t.grantor.id),
      eq(userNotifications.dedupeKey, specialistResultDedupeKey(runId, 'completed')),
    )));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ orgId: t.org.id, link: `/ai-agents/runs/${runId}` });
  });

  it('awaiting_approval counts only the run\'s own still-pending intents', async () => {
    const t = await seedTenant();
    const a = await admit(t);
    const sibling = await admit(t);
    const pending = await propose(t, a.auth, 'Profile looks corrupt');
    const decided = await propose(t, a.auth, 'Roaming profile is oversized');
    await propose(t, sibling.auth, 'Another run: disk nearly full');
    await sys(() => db.update(actionIntents).set({ status: 'rejected', decidedAt: new Date(), decidedVia: 'human' } as never)
      .where(eq(actionIntents.id, decided.id)));
    await settle(a.runId, 'awaiting_approval', { summary: 'Two fixes proposed', intentIds: [pending.id, decided.id] });

    await postSpecialistResult(a.runId);
    const [post] = (await postsFor(t.grant.grantId)).filter((p) => p.link?.includes(a.runId));
    expect(post!.title).toContain('waiting for your approval');
    expect(post!.body).toContain('1 step is waiting for your approval.');
  });

  it('Review Focus 2: a run stopped by a paused grant still posts, and says why', async () => {
    const t = await seedTenant();
    const { runId } = await admit(t);
    await settle(runId, 'failed', { errorCode: 'grant_inactive' });
    await sys(() => db.update(wispGrants).set({ status: 'paused', pausedAt: new Date(), pausedReason: 'user_paused' } as never)
      .where(eq(wispGrants.id, t.grant.grantId)));

    await expect(postSpecialistResult(runId)).resolves.toEqual({ posted: true });
    const [post] = await postsFor(t.grant.grantId);
    expect(post!.title).toBe(`Device troubleshooting on ${t.hostname}: stopped because the Wisp grant is no longer active`);
  });

  it('a revoked grant posts nothing (its thread is no longer readable)', async () => {
    const t = await seedTenant();
    const { runId } = await admit(t);
    await settle(runId, 'completed');
    await sys(() => db.update(wispGrants).set({ status: 'revoked', revokedAt: new Date() } as never)
      .where(eq(wispGrants.id, t.grant.grantId)));
    await expect(postSpecialistResult(runId)).resolves.toEqual({ posted: false, reason: 'grant_inactive' });
    expect(await postsFor(t.grant.grantId)).toHaveLength(0);
  });

  it('an org that left the ceiling posts nothing: org_out_of_ceiling', async () => {
    const t = await seedTenant();
    const { runId } = await admit(t);
    await settle(runId, 'completed');
    // The grantor's live access narrows to the other org: the grant stays
    // live (one org left) but the run's org is out of reach.
    await sys(() => db.update(partnerUsers).set({ orgAccess: 'selected', orgIds: [t.otherOrg.id] })
      .where(and(eq(partnerUsers.userId, t.grantor.id), eq(partnerUsers.partnerId, t.partner.id))));
    await expect(postSpecialistResult(runId)).resolves.toEqual({ posted: false, reason: 'org_out_of_ceiling' });
    expect(await postsFor(t.grant.grantId)).toHaveLength(0);
  });
});

describe('resweepSpecialistResults (real Postgres)', () => {
  it('finds a settled run with no post, posts it once, and then no longer finds it', async () => {
    const t = await seedTenant();
    const { runId } = await admit(t);
    await settle(runId, 'cancelled');

    const first = await resweepSpecialistResults(new Date());
    expect(first.failed).toBe(0);
    expect((await postsFor(t.grant.grantId)).map((p) => p.dedupeKey)).toEqual([specialistResultDedupeKey(runId, 'cancelled')]);
    expect(first.posted).toBeGreaterThanOrEqual(1);

    await resweepSpecialistResults(new Date());
    expect(await postsFor(t.grant.grantId)).toHaveLength(1);
  });

  it('skips a still-running run, and a run settled outside the 24 h window', async () => {
    const t = await seedTenant();
    const running = await admit(t);
    const old = await admit(t);
    await sys(() => db.update(aiAgentRuns).set({ status: 'running' } as never).where(eq(aiAgentRuns.id, running.runId)));
    await settle(old.runId, 'completed', {
      finishedAt: new Date(Date.now() - 25 * 3_600_000),
    });
    await resweepSpecialistResults(new Date());
    expect(await postsFor(t.grant.grantId)).toHaveLength(0);
  });
});

describe('postSpecialistStepOutcome (real Postgres)', () => {
  it('a released step posts once with the approval card\'s label; a redelivered release adds nothing', async () => {
    const t = await seedTenant();
    const { runId, auth } = await admit(t);
    const intent = await propose(t, auth, 'Profile looks corrupt');
    await settle(runId, 'awaiting_approval', { intentIds: [intent.id] });
    await sys(() => db.update(actionIntents).set({
      status: 'completed', executedAt: new Date(), result: { message: 'Context note saved' },
    } as never).where(eq(actionIntents.id, intent.id)));

    await expect(postSpecialistStepOutcome(intent.id)).resolves.toEqual({ posted: true });
    await expect(postSpecialistStepOutcome(intent.id)).resolves.toEqual({ posted: false, reason: 'already_posted' });

    const posts = await postsFor(t.grant.grantId);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ orgId: t.org.id, dedupeKey: specialistStepDedupeKey(intent.id, 'completed'), link: `/ai-agents/runs/${runId}` });
    expect(posts[0]!.body).toMatch(/^Approved step ran: /);
    expect(posts[0]!.body).toContain('Context note saved');
  });
});

describe('continuation (real Postgres)', () => {
  it('seeds from the prior run\'s real intents, keys on (prior, chain), and a second continuation replays the first', async () => {
    const t = await seedTenant();
    const prior = await admit(t);
    const released = await propose(t, prior.auth, 'Profile looks corrupt');
    await sys(() => db.update(actionIntents).set({
      status: 'completed', executedAt: new Date(), result: { message: 'Context note saved' },
    } as never).where(eq(actionIntents.id, released.id)));
    await settle(prior.runId, 'completed', { summary: 'Found a corrupt profile.' });

    const first = await admit(t, { continueFromRunId: prior.runId });
    const [run] = await sys(() => db.select().from(aiAgentRuns).where(eq(aiAgentRuns.id, first.runId)));
    expect(run!.dedupeKey).toBe(`wisp-specialist-continue-${prior.runId}-1`);
    const continuation = (run!.triggerRef as { continuation: { fromRunId: string; chain: number; seed: string } }).continuation;
    expect(continuation).toMatchObject({ fromRunId: prior.runId, chain: 1 });
    expect(continuation.seed).toContain(CONTINUATION_NO_REPEAT_LINE);
    expect(continuation.seed).toContain('Found a corrupt profile.');
    expect(continuation.seed).toContain('Context note saved');
    expect(Buffer.byteLength(continuation.seed, 'utf8')).toBeLessThanOrEqual(4096);
    expect(run!.modeAtStart).toBe('shadow');

    const second = await admit(t, { continueFromRunId: prior.runId });
    expect(second.runId).toBe(first.runId);
  });

  it('refuses a still-running prior run', async () => {
    const t = await seedTenant();
    const prior = await admit(t);
    await sys(() => db.update(aiAgentRuns).set({ status: 'running' } as never).where(eq(aiAgentRuns.id, prior.runId)));
    const result = await requestSpecialist(
      {
        grantId: t.grant.grantId, grantRevisionId: t.grant.revisionId, orgId: t.org.id, kind: 'device_troubleshooting',
        params: { deviceId: t.deviceId, goal: 'Keep going please', continueFromRunId: prior.runId }, requestedByRunId: null,
      },
      { requester: { kind: 'user', auth: t.approver }, requestId: randomUUID() },
    );
    expect(result).toEqual({ refused: 'continuation_refused', detail: 'not_settled' });
  });
});

describe('step re-sweep (real Postgres)', () => {
  it('a released step whose post-back was lost is posted by the reconciler once', async () => {
    const t = await seedTenant();
    const { runId, auth } = await admit(t);
    const intent = await propose(t, auth, 'Profile looks corrupt');
    await settle(runId, 'awaiting_approval', { intentIds: [intent.id] });
    await postSpecialistResult(runId);
    await sys(() => db.update(actionIntents).set({
      status: 'completed', executedAt: new Date(), statusChangedAt: new Date(), result: { message: 'Context note saved' },
    } as never).where(eq(actionIntents.id, intent.id)));

    const first = await resweepSpecialistResults(new Date());
    expect(first.failed).toBe(0);
    const keys = (await postsFor(t.grant.grantId)).map((p) => p.dedupeKey).sort();
    expect(keys).toEqual([specialistResultDedupeKey(runId, 'awaiting_approval'), specialistStepDedupeKey(intent.id, 'completed')].sort());

    await resweepSpecialistResults(new Date());
    expect(await postsFor(t.grant.grantId)).toHaveLength(2);
  });

  it('a revoked grant\'s runs are not candidates at all', async () => {
    const t = await seedTenant();
    const { runId } = await admit(t);
    await settle(runId, 'completed');
    await sys(() => db.update(wispGrants).set({ status: 'revoked', revokedAt: new Date() } as never)
      .where(eq(wispGrants.id, t.grant.grantId)));
    const out = await resweepSpecialistResults(new Date());
    expect(out.skipped.grant_inactive ?? 0).toBe(0);
    expect(await postsFor(t.grant.grantId)).toHaveLength(0);
  });
});

describe('run-detail intents for the caller (real Postgres, user RLS)', () => {
  it('each approver sees only their own pending approval row; a user with none gets nulls', async () => {
    const t = await seedTenant();
    const { runId, auth } = await admit(t);
    const intent = await propose(t, auth, 'Profile looks corrupt');
    const rows = await sys(() => db.select({ id: approvalRequests.id, userId: approvalRequests.userId, status: approvalRequests.status })
      .from(approvalRequests).where(eq(approvalRequests.intentId, intent.id)));
    const pending = rows.filter((r) => r.status === 'pending');
    // The fixture fans out to at least two approvers; this case needs two.
    expect(pending.length).toBeGreaterThanOrEqual(2);
    const outsider = await createUser({ partnerId: t.partner.id, email: `wisp-post-out-${randomUUID()}@wisp.test` });

    const readAs = (userId: string) => withDbAccessContext({
      scope: 'partner', orgId: null, accessibleOrgIds: [t.org.id], accessiblePartnerIds: [t.partner.id], userId,
    } as DbAccessContext, () => selectRunIntentsForCaller({ runId, runOrgId: t.org.id, userId, orgCondition: undefined }));

    for (const row of pending) {
      const [mine] = await readAs(row.userId);
      expect(mine).toMatchObject({ id: intent.id, approvalRequestId: row.id });
      expect(mine!.actionLabel).toEqual(expect.any(String));
    }
    const [theirs] = await readAs(outsider.id);
    expect(theirs).toMatchObject({ id: intent.id, approvalRequestId: null, actionLabel: null });

    // The join's own user predicate isolates too, without RLS (system scope):
    // RLS is the boundary, the predicate is the belt.
    const sysRead = (userId: string) => sys(() => selectRunIntentsForCaller({ runId, runOrgId: t.org.id, userId, orgCondition: undefined }));
    const [outsiderNoRls] = await sysRead(outsider.id);
    expect(outsiderNoRls).toMatchObject({ approvalRequestId: null });
    for (const row of pending) {
      const [mine] = await sysRead(row.userId);
      expect(mine).toMatchObject({ approvalRequestId: row.id });
    }
  });
});
