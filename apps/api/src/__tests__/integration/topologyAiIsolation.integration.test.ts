import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';

// Provider governance is mocked so topology AI reads as available. Nothing in
// this suite reaches a model: there is no model call on any path exercised.
vi.mock('../../services/llm/llmConfigResolver', async (original) => ({
  ...await original<object>(),
  resolveLlmConfigForOrg: vi.fn(async () => ({ source: 'platform', apiKey: 'test-key', model: 'claude-sonnet-4-6' })),
}));
// Observe the artifact-capture decision (M4-D6) without changing it.
const capture = vi.hoisted(() => ({ contexts: [] as Array<{ tool: string; ctx: unknown }> }));
vi.mock('../../services/artifacts/toolResultCapture', async (original) => {
  const actual = await original<typeof import('../../services/artifacts/toolResultCapture')>();
  return {
    ...actual,
    captureContextFrom: (...args: Parameters<typeof actual.captureContextFrom>) => actual.captureContextFrom(...args),
    captureLargeToolResult: async (raw: string, ctx: Parameters<typeof actual.captureLargeToolResult>[1]) => {
      capture.contexts.push({ tool: ctx?.toolName ?? '(exempt)', ctx });
      return actual.captureLargeToolResult(raw, ctx);
    },
  };
});

import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { actionIntents, approvalRequests, organizationUsers, topologyDiagnosticRuns } from '../../db/schema';
import { buildOrgAccessClosures, dbAccessContextFromAuth, type AuthContext } from '../../middleware/auth';
import { computeEffectDigestForRelease } from '../../services/actionIntents/effectDigest';
import { createActionIntent, transitionIntent } from '../../services/actionIntents/intentService';
import { createSession } from '../../services/aiAgent';
import { executeTool } from '../../services/aiTools';
import { decideApprovalRequest } from '../../services/approvals/decideApprovalRequest';
import { createAccessToken } from '../../services/jwt';
import { clearPermissionCache, getUserPermissions } from '../../services/permissions';
import { requireTopologySiteAccess, TopologyError, type TopologyRequestContext } from '../../services/topology/access';
import { reauthorizeTopologyAiCitations } from '../../services/topology/aiCitations';
import { runApprovedTopologyDiagnostic } from '../../services/topology/aiDiagnosticApproval';
import { buildTopologyAiEvidence } from '../../services/topology/aiEvidence';
import { TOPOLOGY_AI_TOOL_NAMES } from '../../services/topology/aiToolGate';
import { getTopologyDiagnosticRun } from '../../services/topology/diagnosticRuns';
import { topologyRoutes } from '../../routes/topology';
import { seedTopologyEligibleOrigin, type TopologyEligibleOrigin } from '../helpers/topologyEligibleOrigin';
import { assignUserToOrganization, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

/**
 * M4 Task 6 (#6000): adversarial isolation of everything an investigation
 * produces, against real Postgres with a REAL eligible origin, the real
 * intent/approval chain and the real M1 run:
 *   - another ORG can neither read the investigation, reuse its session to
 *     propose, decide its approval, see its intent, nor read its run;
 *   - a same-org user restricted to ANOTHER SITE gets the same refusals;
 *   - citations re-authorize to nothing for either;
 *   - no topology tool result is ever artifact-captured (M4-D6), while a
 *     non-exempt control tool IS offered to capture (the check is not vacuous);
 *   - a replayed/spent approval never starts a second run for anyone.
 */
const system = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn, 'topology ai isolation test'));
const asUser = <T>(auth: AuthContext, fn: () => Promise<T>) => runOutsideDbContext(() => withDbAccessContext(dbAccessContextFromAuth(auth), fn));

let a: TopologyEligibleOrigin;
let b: TopologyEligibleOrigin;

async function openSession(f: TopologyEligibleOrigin): Promise<string> {
  const graphRevision = await f.graphRevision();
  const session = await asUser(f.auth, () => createSession(f.auth, {
    pageContext: { type: 'topology', siteId: f.siteId, subject: { kind: 'node', id: f.nodeId }, view: 'overview', graphRevision },
  } as Parameters<typeof createSession>[1]));
  return session.id;
}

const chatAuth = (auth: AuthContext, sessionId: string): AuthContext => ({ ...auth, aiOrigin: { kind: 'ai_assistant', sessionId } });

async function propose(f: TopologyEligibleOrigin, auth: AuthContext, siteId = f.siteId) {
  return runOutsideDbContext(async () => createActionIntent(auth, {
    toolName: 'diagnose_connectivity',
    input: { site_id: siteId, subject: { kind: 'node', id: f.nodeId }, recipe_id: 'gateway_basic', recipe_version: 1, graph_revision: await f.graphRevision() },
    source: 'chat',
  }));
}

async function authenticator(userId: string): Promise<string> {
  const [row] = await getTestDb().execute(sql`INSERT INTO authenticator_devices (user_id,kind,public_key,is_platform_bound)
    VALUES (${userId}::uuid,'webauthn_platform','test-public-key',true) RETURNING id`);
  return String(row!.id);
}

/** The real decide core; the verified ceremony is the only faked step. */
async function decide(auth: AuthContext, approvalId: string) {
  const preverified = { preverifiedAssurance: { requiredLevel: 3, decidedAssuranceLevel: 3, decidedVia: 'webauthn_platform', authenticatorDeviceId: await authenticator(auth.user.id) } as const };
  return asUser(auth, () => decideApprovalRequest({ auth, id: approvalId, status: 'approved', ...preverified }));
}

async function releaseInline(intentId: string) {
  const [intent] = await system(() => db.select().from(actionIntents).where(eq(actionIntents.id, intentId)).limit(1));
  if (intent!.status === 'approved') expect(await transitionIntent(intentId, 'approved', 'executing', { executedAt: null, executionStartedAt: new Date() })).toBe(true);
  const recomputed = await system(() => computeEffectDigestForRelease(intent!.actionName, intent!.arguments, db));
  return JSON.parse(await asUser(a.auth, () => runApprovedTopologyDiagnostic(intent!.arguments, a.auth, { ...recomputed.context, actionIntentId: intentId }))) as Record<string, string>;
}

/** A same-org user of `f` with the same role, restricted to `siteIds`. */
async function restrictedPeer(f: TopologyEligibleOrigin, siteIds: string[]) {
  const user = await createUser({ partnerId: f.env.partner.id, orgId: f.orgId });
  await assignUserToOrganization(user.id, f.orgId, f.env.role.id);
  await getTestDb().update(organizationUsers).set({ siteIds }).where(and(eq(organizationUsers.userId, user.id), eq(organizationUsers.orgId, f.orgId)));
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([f.orgId]);
  const auth: AuthContext = {
    ...f.auth,
    user: { id: user.id, email: user.email, name: 'Site-restricted peer', isPlatformAdmin: false },
    token: { ...f.auth.token!, sub: user.id, email: user.email },
    orgCondition, canAccessOrg,
  };
  const token = await createAccessToken({ sub: user.id, email: user.email, roleId: f.env.role.id, orgId: f.orgId, partnerId: f.env.partner.id,
    scope: 'organization', mfa: true, aep: 1, mep: 1, sid: crypto.randomUUID() });
  return { user, auth, token };
}

async function permissionsOf(auth: AuthContext) {
  return (await getUserPermissions(auth.user.id, { partnerId: auth.partnerId ?? undefined, orgId: auth.orgId ?? undefined, scope: auth.scope }))!;
}

async function siteAccessRefused(auth: AuthContext, siteId: string): Promise<boolean> {
  const permissions = await permissionsOf(auth);
  return asUser(auth, () => requireTopologySiteAccess(auth, permissions, siteId, 'read')).then(() => false, (error: unknown) => {
    if (error instanceof TopologyError) return true;
    throw error;
  });
}

const topologyApp = () => new Hono().route('/topology', topologyRoutes);
const readRunOverHttp = (token: string, siteId: string, runId: string) =>
  topologyApp().request(`/topology/sites/${siteId}/diagnostic-runs/${runId}`, { headers: { Authorization: `Bearer ${token}` } });

beforeEach(async () => {
  capture.contexts.length = 0;
  a = await seedTopologyEligibleOrigin();
  b = await seedTopologyEligibleOrigin();
});
afterEach(async () => { await clearPermissionCache(); });

describe('investigation isolation across orgs and sites (M4 Task 6, real DB)', () => {
  it('another org cannot reuse the session to propose, decide the approval, see the intent, or read the run', async () => {
    const sessionA = await openSession(a);
    const approved = await propose(a, chatAuth(a.auth, sessionA));
    expect((await decide(a.auth, approved.requesterApprovalRequestId!)).httpStatus).toBe(200);
    const released = await releaseInline(approved.id);
    expect(released.runId, JSON.stringify(released)).toBeTruthy();
    const runs = () => system(() => db.select({ id: topologyDiagnosticRuns.id }).from(topologyDiagnosticRuns).where(eq(topologyDiagnosticRuns.orgId, a.orgId)));
    expect(await runs()).toHaveLength(1);

    // A pending proposal from a second investigation in org A.
    const pending = await propose(a, chatAuth(a.auth, await openSession(a)));
    expect(pending.status).toBe('pending_approval');

    // Org B reusing org A's session id as its AI origin: refused, nothing written.
    const intentCount = () => system(async () => (await db.select({ id: actionIntents.id }).from(actionIntents)
      .where(sql`${actionIntents.orgId} IN (${a.orgId}::uuid, ${b.orgId}::uuid)`)).length);
    const before = await intentCount();
    const hijack = await propose(b, chatAuth(b.auth, sessionA), a.siteId).then(() => null, (error: { code?: string }) => error.code);
    expect(hijack).toBeTruthy();
    expect(await intentCount()).toBe(before);
    // Org B deciding org A's approval row: refused, row untouched.
    const foreignDecision = await decide(b.auth, pending.requesterApprovalRequestId!);
    expect(foreignDecision.httpStatus).not.toBe(200);
    const [row] = await system(() => db.select({ status: approvalRequests.status }).from(approvalRequests).where(eq(approvalRequests.id, pending.requesterApprovalRequestId!)));
    expect(row?.status).toBe('pending');
    // Org B cannot even see org A's intent or run under its own RLS.
    expect(await asUser(b.auth, () => db.select({ id: actionIntents.id }).from(actionIntents).where(eq(actionIntents.id, pending.id)))).toEqual([]);
    expect(await asUser(b.auth, () => db.select({ id: topologyDiagnosticRuns.id }).from(topologyDiagnosticRuns).where(eq(topologyDiagnosticRuns.id, released.runId!)))).toEqual([]);
    // ...nor through the run read route, by naming either site.
    for (const siteId of [a.siteId, b.siteId]) {
      const res = await readRunOverHttp(b.env.token, siteId, released.runId!);
      expect([403, 404], `site ${siteId === a.siteId ? 'A' : 'B'}`).toContain(res.status);
    }
    expect(await siteAccessRefused(b.auth, a.siteId)).toBe(true);
    expect(await asUser(b.auth, () => getTopologyDiagnosticRun(b.context, released.runId!))).toBeNull();
    // The owner still reads it; the spent approval never starts a second run.
    expect((await readRunOverHttp(a.env.token, a.siteId, released.runId!)).status).toBe(200);
    expect((await releaseInline(approved.id)).runId).toBe(released.runId);
    expect(await runs()).toHaveLength(1);
  });

  it('a same-org user WITH access to the site still cannot propose through another user\'s session (the origin binding, not site access, refuses)', async () => {
    const sessionA = await openSession(a);
    const peer = await restrictedPeer(a, [a.siteId]);
    await clearPermissionCache(peer.user.id);
    // Positive control: the peer can pin and propose from its OWN session at this site.
    const graphRevision = await a.graphRevision();
    const own = await asUser(peer.auth, () => createSession(peer.auth, {
      pageContext: { type: 'topology', siteId: a.siteId, subject: { kind: 'node', id: a.nodeId }, view: 'overview', graphRevision },
    } as Parameters<typeof createSession>[1]));
    expect((await propose(a, chatAuth(peer.auth, own.id))).status).toBe('pending_approval');
    const before = (await system(() => db.select({ id: actionIntents.id }).from(actionIntents).where(eq(actionIntents.orgId, a.orgId)))).length;
    const hijack = await propose(a, chatAuth(peer.auth, sessionA)).then(() => null, (error: { code?: string }) => error.code);
    expect(hijack).toBe('topology_session_required');
    expect((await system(() => db.select({ id: actionIntents.id }).from(actionIntents).where(eq(actionIntents.orgId, a.orgId)))).length).toBe(before);
  });

  it('a same-org user restricted to another site gets the same refusals', async () => {
    const siteB = await createSite({ orgId: a.orgId });
    const peer = await restrictedPeer(a, [siteB.id]);
    await clearPermissionCache(peer.user.id);
    const sessionA = await openSession(a);
    const pending = await propose(a, chatAuth(a.auth, sessionA));
    expect((await decide(a.auth, pending.requesterApprovalRequestId!)).httpStatus).toBe(200);
    const released = await releaseInline(pending.id);

    expect(await siteAccessRefused(peer.auth, a.siteId)).toBe(true);
    expect([403, 404]).toContain((await readRunOverHttp(peer.token, a.siteId, released.runId!)).status);
    expect([403, 404]).toContain((await readRunOverHttp(peer.token, siteB.id, released.runId!)).status);
    // The peer cannot propose through the owner's session, nor pin a session to site A.
    const hijack = await propose(a, chatAuth(peer.auth, sessionA)).then(() => null, (error: { code?: string }) => error.code);
    expect(hijack).toBeTruthy();
    const pinned = await asUser(peer.auth, () => createSession(peer.auth, {
      pageContext: { type: 'topology', siteId: a.siteId, subject: { kind: 'node', id: a.nodeId }, view: 'overview', graphRevision: '1' },
    } as Parameters<typeof createSession>[1])).then(() => 'created', () => 'refused');
    expect(pinned).toBe('refused');
    // Positive control: the same peer CAN pin its own site, so the refusal above is the site boundary.
    const ownPin = await asUser(peer.auth, () => createSession(peer.auth, {
      pageContext: { type: 'topology', siteId: siteB.id, subject: { kind: 'node', id: a.nodeId }, view: 'overview', graphRevision: '1' },
    } as Parameters<typeof createSession>[1])).then(() => 'created', (error: unknown) => `refused: ${error instanceof Error ? error.message : String(error)}`);
    expect(ownPin).toBe('created');
    // And cannot decide another investigation's pending approval.
    const second = await propose(a, chatAuth(a.auth, await openSession(a)));
    expect((await decide(peer.auth, second.requesterApprovalRequestId!)).httpStatus).not.toBe(200);
  });

  it('citations re-authorize to nothing for another org or a site-restricted peer, and to everything for the owner', async () => {
    const graphRevision = await a.graphRevision();
    const snapshot = await asUser(a.auth, () => buildTopologyAiEvidence(a.context,
      { siteId: a.siteId, subject: { kind: 'node', id: a.nodeId }, view: 'overview', graphRevision }, new Date(), { investigationId: crypto.randomUUID() }));
    const ids = Object.keys(snapshot.manifest);
    expect(ids.length).toBeGreaterThan(0);
    expect((await asUser(a.auth, () => reauthorizeTopologyAiCitations(a.context, ids, snapshot))).unavailable).toEqual([]);

    const foreign = await asUser(b.auth, () => reauthorizeTopologyAiCitations(b.context, ids, snapshot));
    expect(foreign).toEqual({ allowed: [], unavailable: ids });
    // Even presenting org A's scope with org B's identity.
    const forged: TopologyRequestContext = { ...b.context, scope: a.scope };
    expect((await asUser(b.auth, () => reauthorizeTopologyAiCitations(forged, ids, snapshot))).allowed).toEqual([]);

    const siteB = await createSite({ orgId: a.orgId });
    const peer = await restrictedPeer(a, [siteB.id]);
    await clearPermissionCache(peer.user.id);
    const peerCtx: TopologyRequestContext = { ...a.context, auth: peer.auth, permissions: await permissionsOf(peer.auth) };
    expect((await asUser(peer.auth, () => reauthorizeTopologyAiCitations(peerCtx, ids, snapshot))).allowed).toEqual([]);
  });

  it('never artifact-captures a topology tool result (M4-D6), while a non-exempt control tool is offered to capture', async () => {
    const sessionA = await openSession(a);
    const binding = { kind: 'ai_session' as const, sessionId: sessionA };
    const captureScope = { orgId: a.orgId, sessionId: sessionA };
    const auth = chatAuth(a.auth, sessionA);
    const inputs: Record<string, Record<string, unknown>> = {
      get_topology: { site_id: a.siteId, view: 'overview' },
      get_topology_monitoring_status: { site_id: a.siteId },
      get_recent_network_changes: { site_id: a.siteId, since: new Date(Date.now() - 3_600_000).toISOString(), until: new Date().toISOString() },
      get_topology_impact: { site_id: a.siteId, subject_kind: 'node', subject_id: a.nodeId },
    };
    for (const [name, input] of Object.entries(inputs)) {
      expect(TOPOLOGY_AI_TOOL_NAMES).toContain(name);
      const before = capture.contexts.length;
      await asUser(auth, () => executeTool(name, input, auth, { topologyBinding: binding, capture: captureScope }));
      const offered = capture.contexts.slice(before);
      // The handler produced a result (one capture decision), and it took the null-context passthrough.
      expect(offered, name).toEqual([{ tool: '(exempt)', ctx: null }]);
    }
    // Control: an ordinary, non-exempt core tool with the same capture scope IS offered a capture context.
    const before = capture.contexts.length;
    await asUser(auth, () => executeTool('list_sites', {}, auth, { capture: captureScope }));
    expect(capture.contexts.slice(before).some(({ ctx }) => ctx !== null)).toBe(true);
    const [artifacts] = await system(() => db.execute(sql`SELECT count(*)::int AS n FROM ai_run_artifacts WHERE session_id = ${sessionA}::uuid`));
    expect(Number(artifacts!.n)).toBe(0);
  });
});
