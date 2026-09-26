import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';

// Provider governance is mocked so topology AI reads as available; nothing in
// this suite ever reaches a model (there is no model call on this path at all).
vi.mock('../../services/llm/llmConfigResolver', async (original) => ({
  ...await original<object>(),
  resolveLlmConfigForOrg: vi.fn(async () => ({ source: 'platform', apiKey: 'test-key', model: 'claude-sonnet-4-6' })),
}));

import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { actionIntents, approvalRequests, permissions as permissionRows, rolePermissions, topologyChangeOutbox, topologyDiagnosticRuns } from '../../db/schema';
import { dbAccessContextFromAuth, type AuthContext } from '../../middleware/auth';
import { releaseApprovedIntent } from '../../jobs/intentReleaseWorker';
import { buildAuthContextForIntent } from '../../services/actionIntents/actorContext';
import { computeEffectDigestForRelease } from '../../services/actionIntents/effectDigest';
import { ActionIntentError, createActionIntent, transitionIntent } from '../../services/actionIntents/intentService';
import { createSession } from '../../services/aiAgent';
import { decideApprovalRequest } from '../../services/approvals/decideApprovalRequest';
import { clearPermissionCache } from '../../services/permissions';
import type { ToolExecutionContext } from '../../services/toolExecutionContext';
import { runApprovedTopologyDiagnostic, TOPOLOGY_AI_PROPOSAL_TTL_MS } from '../../services/topology/aiDiagnosticApproval';
import { seedTopologyEligibleOrigin, type TopologyEligibleOrigin } from '../helpers/topologyEligibleOrigin';
import { createSite } from './db-utils';
import { getTestDb } from './setup';

/**
 * M4 Task 4 (#6000), amendments M4-D1/M4-D3, against real Postgres: one
 * AI-proposed diagnostic bound to the existing approval effect. A real eligible
 * origin (real ingest + reconcile), the real intent creation, the real decide
 * core, the real durable release worker and the real M1 run/outbox. Proves:
 * the auto-selected origin is pinned in the arguments, the approval text and
 * the digest; only a FRESH hardware factor approves; the durable actor's
 * synthesized `mfa: true` is never authority; a tampered digest, an expired
 * proposal, a spent approval, a lost permission, a foreign site, a moved
 * origin and `flags.ai` off all start ZERO runs.
 */
const system = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn, 'topology ai approval test'));
const asUser = <T>(auth: AuthContext, fn: () => Promise<T>) => runOutsideDbContext(() => withDbAccessContext(dbAccessContextFromAuth(auth), fn));

let f: TopologyEligibleOrigin;
let sessionId: string;

async function openSession(): Promise<string> {
  const graphRevision = await f.graphRevision();
  const session = await asUser(f.auth, () => createSession(f.auth, {
    pageContext: { type: 'topology', siteId: f.siteId, subject: { kind: 'node', id: f.nodeId }, view: 'overview', graphRevision },
  } as Parameters<typeof createSession>[1]));
  return session.id;
}

const chatAuth = (id = sessionId): AuthContext => ({ ...f.auth, aiOrigin: { kind: 'ai_assistant', sessionId: id } });

async function propose(overrides: Record<string, unknown> = {}, auth: AuthContext = chatAuth()) {
  return runOutsideDbContext(async () => createActionIntent(auth, {
    toolName: 'diagnose_connectivity',
    input: {
      site_id: f.siteId, subject: { kind: 'node', id: f.nodeId }, recipe_id: 'gateway_basic', recipe_version: 1,
      graph_revision: await f.graphRevision(), ...overrides,
    },
    source: 'chat',
  }));
}

async function proposalError(overrides: Record<string, unknown> = {}, auth?: AuthContext): Promise<string> {
  const error = await propose(overrides, auth).then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ActionIntentError);
  return (error as ActionIntentError).code;
}

const readIntent = (id: string) => system(async () => (await db.select().from(actionIntents).where(eq(actionIntents.id, id)).limit(1))[0]!);
const runCount = () => system(async () => (await db.select({ id: topologyDiagnosticRuns.id }).from(topologyDiagnosticRuns)
  .where(eq(topologyDiagnosticRuns.orgId, f.orgId))).length);

async function authenticator(): Promise<string> {
  const [row] = await getTestDb().execute(sql`INSERT INTO authenticator_devices (user_id,kind,public_key,is_platform_bound)
    VALUES (${f.env.user.id}::uuid,'webauthn_platform','test-public-key',true) RETURNING id`);
  return String(row!.id);
}

/** The real decide core; `fresh` supplies the verified ceremony the batch path would (the ONLY faked step). */
async function decide(approvalId: string, fresh: boolean) {
  const preverified = fresh
    ? { preverifiedAssurance: { requiredLevel: 3, decidedAssuranceLevel: 3, decidedVia: 'webauthn_platform', authenticatorDeviceId: await authenticator() } as const }
    : {};
  // Under the decider's own request context, as the approve route runs it.
  return asUser(f.auth, () => decideApprovalRequest({ auth: f.auth, id: approvalId, status: 'approved', ...preverified }));
}

async function proposeAndApprove() {
  const intent = await propose();
  const approvalId = intent.requesterApprovalRequestId!;
  expect((await decide(approvalId, true)).httpStatus).toBe(200);
  expect((await readIntent(intent.id)).status).toBe('approved');
  return intent;
}

/** The inline release's own steps: win the CAS, recompute and match the digest, execute with its context. */
async function releaseInline(intentId: string, mutate: (context: ToolExecutionContext) => ToolExecutionContext = (c) => c, now?: () => Date) {
  const intent = await readIntent(intentId);
  if (intent.status === 'approved') expect(await transitionIntent(intentId, 'approved', 'executing', { executedAt: null, executionStartedAt: new Date() })).toBe(true);
  const recomputed = await system(() => computeEffectDigestForRelease(intent.actionName, intent.arguments, db));
  expect(recomputed.digest).toBe(intent.effectDigest);
  const context = mutate({ ...recomputed.context, actionIntentId: intentId });
  return JSON.parse(await asUser(f.auth, () => runApprovedTopologyDiagnostic(intent.arguments, f.auth, context, now))) as Record<string, string>;
}

async function revokeRolePermission(resource: string, action: string) {
  const database = getTestDb();
  const ids = (await database.select({ id: permissionRows.id }).from(permissionRows)
    .where(and(eq(permissionRows.resource, resource), eq(permissionRows.action, action)))).map((row) => row.id);
  await database.delete(rolePermissions).where(and(eq(rolePermissions.roleId, f.env.role.id), inArray(rolePermissions.permissionId, ids)));
  await clearPermissionCache(f.env.user.id);
}

beforeEach(async () => {
  f = await seedTopologyEligibleOrigin();
  sessionId = await openSession();
});

afterEach(async () => {
  await clearPermissionCache();
});

describe('diagnose_connectivity proposal (M4-D1/M4-D3, real DB)', () => {
  it('pins the auto-selected origin in the immutable arguments, the approval text and the effect digest', async () => {
    const before = Date.now();
    const intent = await propose();
    const row = await readIntent(intent.id);
    expect(row).toMatchObject({ actionName: 'diagnose_connectivity', approvalScope: 'supervised', status: 'pending_approval', orgId: f.orgId });
    expect(row.arguments).toMatchObject({ site_id: f.siteId, origin_device_id: f.deviceId, context_key: expect.any(String), family: 'ipv4' });
    const expires = Date.parse(String(row.arguments.proposal_expires_at));
    expect(expires).toBeGreaterThanOrEqual(before + TOPOLOGY_AI_PROPOSAL_TTL_MS - 1000);
    expect(expires).toBeLessThanOrEqual(Date.now() + TOPOLOGY_AI_PROPOSAL_TTL_MS);
    expect(row.effectDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(row.reason).toContain('diag-origin');
    expect(row.impactSummary).toContain(f.deviceId.slice(0, 8));
    // The pinned material re-derives identically from current state.
    expect((await system(() => computeEffectDigestForRelease('diagnose_connectivity', row.arguments, db))).digest).toBe(row.effectDigest);
    // Immutable: the digest can never be swapped for another effect.
    await expect(getTestDb().execute(sql`UPDATE action_intents SET effect_digest = ${'f'.repeat(64)} WHERE id = ${intent.id}::uuid`)).rejects.toBeTruthy();
  });

  it('is refused outside the site-pinned topology session, for a foreign site or subject, and with flags.ai off', async () => {
    // Not a chat session at all, and a general (unpinned) chat session.
    expect(await proposalError({}, f.auth)).toBe('topology_session_required');
    const general = await asUser(f.auth, () => createSession(f.auth, { pageContext: { type: 'dashboard' } } as Parameters<typeof createSession>[1]));
    expect(await proposalError({}, chatAuth(general.id))).toBe('topology_session_required');
    // Cross-site target: another site in the SAME org, the actor allowed both.
    const siteB = await createSite({ orgId: f.orgId });
    expect(await proposalError({ site_id: siteB.id })).toBe('topology_site_mismatch');
    expect(await proposalError({ subject: { kind: 'node', id: randomUUID() } })).toBe('diagnostic_not_plannable');
    expect(await proposalError({ graph_revision: '999999' })).toBe('graph_revision_changed');
    await f.setFlags({ ai: false });
    expect(await proposalError()).toBe('topology_ai_disabled');
    expect(await system(async () => (await db.select().from(actionIntents).where(eq(actionIntents.orgId, f.orgId))).length)).toBe(0);
  });

  it('refuses a proposer without execute on the site', async () => {
    await revokeRolePermission('devices', 'execute');
    expect(await proposalError()).toBe('topology_permission_denied');
  });
});

describe('diagnose_connectivity approval and release (M4-D3, real DB)', () => {
  it('a session-tap approval is refused; a fresh-factor approval releases through the durable worker onto one M1 run + outbox', async () => {
    const intent = await propose();
    const tap = await decide(intent.requesterApprovalRequestId!, false);
    expect(tap.httpStatus).toBe(403);
    expect(tap.body).toMatchObject({ error: 'step_up_required', reason: 'fresh_mfa_required' });
    expect((await readIntent(intent.id)).status).toBe('pending_approval');

    expect((await decide(intent.requesterApprovalRequestId!, true)).httpStatus).toBe(200);
    await releaseApprovedIntent(intent.id);

    const released = await readIntent(intent.id);
    expect(released.status, JSON.stringify(released.result)).toBe('completed');
    const runs = await system(() => db.select().from(topologyDiagnosticRuns).where(eq(topologyDiagnosticRuns.orgId, f.orgId)));
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run).toMatchObject({ siteId: f.siteId, requesterId: f.env.user.id, idempotencyKey: `topology-intent:${intent.id}`, recipeId: 'gateway_basic' });
    expect((run.originSnapshot as { deviceId: string }).deviceId).toBe(f.deviceId);
    // M3-D13 generalized: the approved run carries a frozen requester authority.
    expect(run.requesterAuthority).toMatchObject({ version: 1, userId: f.env.user.id });
    const outbox = await system(() => db.select().from(topologyChangeOutbox).where(eq(topologyChangeOutbox.aggregateId, run.id)));
    expect(outbox).toHaveLength(1);
    expect(JSON.stringify(released.result)).toContain(run.id);
  });

  it('a replayed acceptance reuses the one run, and a spent approval can never start another', async () => {
    const intent = await proposeAndApprove();
    const first = await releaseInline(intent.id);
    expect(first.runId, JSON.stringify(first)).toBeTruthy();
    const replay = await releaseInline(intent.id);
    expect(replay.runId).toBe(first.runId);
    expect(await runCount()).toBe(1);
    expect(await transitionIntent(intent.id, 'executing', 'completed', { executedAt: new Date() })).toBe(true);
    const row = await readIntent(intent.id);
    const recomputed = await system(() => computeEffectDigestForRelease('diagnose_connectivity', row.arguments, db));
    const spent = JSON.parse(await asUser(f.auth, () => runApprovedTopologyDiagnostic(row.arguments, f.auth, { ...recomputed.context, actionIntentId: intent.id })));
    expect(spent.code).toBe('acceptance_replayed');
    expect(await runCount()).toBe(1);
  });

  it('a tampered proposal digest or proposal never binds the approval', async () => {
    const intent = await proposeAndApprove();
    const tamperedDigest = await releaseInline(intent.id, (context) => ({
      ...context, verifiedTopologyDiagnostic: { ...context.verifiedTopologyDiagnostic!, effectDigest: 'f'.repeat(64) },
    }));
    expect(tamperedDigest.code).toBe('acceptance_invalid');
    const tamperedProposal = await releaseInline(intent.id, (context) => ({
      ...context,
      verifiedTopologyDiagnostic: { ...context.verifiedTopologyDiagnostic!, proposal: { ...context.verifiedTopologyDiagnostic!.proposal, context_key: 'other' } },
    }));
    expect(tamperedProposal.code).toBe('acceptance_invalid');
    expect(await runCount()).toBe(0);
  });

  it('an expired proposal never starts, even with a valid approval', async () => {
    const intent = await proposeAndApprove();
    const expiry = Date.parse(String((await readIntent(intent.id)).arguments.proposal_expires_at));
    const result = await releaseInline(intent.id, (c) => c, () => new Date(expiry + 1000));
    expect(result.code).toBe('proposal_expired');
    expect(await runCount()).toBe(0);
  });

  it('an approval recorded without a fresh factor never starts a run — the durable actor\'s synthesized mfa:true is not authority', async () => {
    const intent = await propose();
    // A decision that skipped the fresh-factor gate (a session tap written by
    // any path that bypasses decideApprovalRequest's check).
    await system(async () => {
      await db.update(approvalRequests).set({ status: 'approved', decidedAt: new Date(), decidedVia: 'session_tap', decidedAssuranceLevel: 1 })
        .where(eq(approvalRequests.id, intent.requesterApprovalRequestId!));
      await db.update(actionIntents).set({
        status: 'approved', decidedAt: new Date(), decidedByUserId: f.env.user.id, decidedVia: 'session_tap', decidedAssuranceLevel: 1,
        releaseBy: new Date(Date.now() + 10 * 60_000),
      }).where(eq(actionIntents.id, intent.id));
    });
    const durableAuth = await buildAuthContextForIntent(await readIntent(intent.id));
    expect(durableAuth?.token?.mfa).toBe(true);

    await releaseApprovedIntent(intent.id);
    const released = await readIntent(intent.id);
    expect(released.status).toBe('failed');
    expect(JSON.stringify(released.result)).toContain('fresh_mfa_required');
    expect(await runCount()).toBe(0);
  });

  it('an approver without the tool permission cannot approve, and a lost execute permission blocks the release', async () => {
    const refused = await propose();
    // The tool's own RBAC pair (TOOL_PERMISSIONS), re-checked live at decide.
    await revokeRolePermission('devices', 'execute');
    expect((await decide(refused.requesterApprovalRequestId!, true)).httpStatus).toBe(403);
    expect((await readIntent(refused.id)).status).toBe('pending_approval');

    f = await seedTopologyEligibleOrigin();
    sessionId = await openSession();
    const intent = await proposeAndApprove();
    // The topology execute floor (requireTopologySiteAccess('execute')), re-checked live at release.
    await revokeRolePermission('topology', 'execute');
    await releaseApprovedIntent(intent.id);
    expect((await readIntent(intent.id)).status).toBe('failed');
    expect(await runCount()).toBe(0);
  });

  it('an origin moved to another site after approval fails closed with no re-selected origin (actor allowed both sites)', async () => {
    const intent = await proposeAndApprove();
    const siteB = await createSite({ orgId: f.orgId });
    await f.scoped(() => db.execute(sql`UPDATE devices SET site_id = ${siteB.id}::uuid WHERE id = ${f.deviceId}::uuid`));
    await releaseApprovedIntent(intent.id);
    const released = await readIntent(intent.id);
    expect(released.status).toBe('failed');
    expect(released.errorCode).toBe('content_changed');
    expect(await runCount()).toBe(0);
  });

  it('flags.ai off after approval blocks the release', async () => {
    const intent = await proposeAndApprove();
    await f.setFlags({ ai: false });
    await releaseApprovedIntent(intent.id);
    const released = await readIntent(intent.id);
    expect(released.status).toBe('failed');
    expect(JSON.stringify(released.result)).toContain('topology_ai_disabled');
    expect(await runCount()).toBe(0);
  });
});
