/**
 * Wisp W07 — the specialist coordinator against real Postgres (plan
 * "Integration case this wave owns", Review Focus 2/3, depth one).
 *
 *   - an `analysis` request whose grantor's ceiling lacks ai_workspace:execute
 *     is refused `workspace_execute_required` and writes NO run;
 *   - an asks-first request from an assessment mints ONE
 *     `wisp_specialist_request` approval card under the run's agent principal
 *     (the agent guardrail carve-out, intent creation, approver resolution all
 *     real), and a retry with the same request id converges on it;
 *   - a request whose requesting run is itself a child is refused depth_exceeded.
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
import { actionIntents, aiAgentRuns, aiAgents, devices, wispGrantRevisions, wispGrants } from '../../db/schema';
import type { WispCeilingSnapshot } from '../../db/schema/wisp';
import { createAndEnqueueAgentRun, registerAgentRunEnqueuer } from '../../services/aiAgents/runService';
import { requestSpecialist } from '../../services/wisp/coordinator';
import { wispSpecialistRequestHandler } from '../../services/aiToolsWisp';
import { createActionIntent } from '../../services/actionIntents/intentService';
import { buildAgentAuthContext } from '../../services/aiAgents/agentAuthContext';
import type { AuthContext } from '../../middleware/auth';
import { specialistDedupeKey } from '../../services/wisp/specialistLaunchers';
import { WISP_SPECIALIST_REQUEST_TOOL } from '../../services/wisp/specialistPolicy';
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

type Perm = { resource: string; action: string };

async function seedTenant(grantorPerms: Perm[]) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const grantor = await createUser({ partnerId: partner.id, email: `wisp-spec-${randomUUID()}@wisp.test` });
  const role = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(role.id, grantorPerms);
  await assignUserToPartner(grantor.id, partner.id, role.id, 'all');
  // A second partner member who may approve the card.
  const admin = await createUser({ partnerId: partner.id, email: `wisp-spec-admin-${randomUUID()}@wisp.test` });
  const adminRole = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(adminRole.id, [{ resource: '*', action: '*' }]);
  await assignUserToPartner(admin.id, partner.id, adminRole.id, 'all');

  const site = await createSite({ orgId: org.id });
  const unique = randomUUID().slice(0, 8);
  const [device] = await sys(() => db.insert(devices).values({
    orgId: org.id, siteId: site.id, agentId: `wisp-spec-${unique}`, hostname: `wisp-spec-${unique}`,
    osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
  }).returning({ id: devices.id }));
  await sys(() => db.insert(aiAgents).values({
    partnerId: partner.id, orgId: null, kind: 'triage', name: 'Wisp Triage', enabled: true, mode: 'shadow', model: null,
    toolAllowlist: ['query_devices'],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: { maxConcurrentRuns: 5, maxRunsPerHour: 50, maxBudgetCentsPerDay: 1000 },
    triggers: { alertSeverities: ['critical', 'high'], respectMaintenanceWindows: false },
    recipients: { userIds: [], roleIds: [] }, instructions: null, cooldownSeconds: 0, createdBy: admin.id,
  } as never));

  const permissionKeys = grantorPerms.map((p) => `${p.resource}:${p.action}`);
  const grant = await sys(async () => {
    const [g] = await db.insert(wispGrants).values({
      partnerId: partner.id, orgId: null, grantorUserId: grantor.id, status: 'active',
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    }).returning({ id: wispGrants.id });
    const snapshot: WispCeilingSnapshot = {
      version: 1, permissionKeys, orgIds: [org.id], siteIds: null, toolAllowlist: null, deniedTools: [],
    };
    const [r] = await db.insert(wispGrantRevisions).values({
      grantId: g!.id, partnerId: partner.id, revision: 1, ceilingSnapshot: snapshot,
      factorProof: { method: 'step_up', verifiedAt: new Date().toISOString() },
    }).returning({ id: wispGrantRevisions.id });
    await db.update(wispGrants).set({ currentRevisionId: r!.id }).where(eq(wispGrants.id, g!.id));
    return { grantId: g!.id, revisionId: r!.id };
  });
  return { partner, org, grantor, admin, deviceId: device!.id, grant };
}

/** Wisp's own assessment run under the grant (fixture: admitted, then profiled). */
async function seedAssessmentRun(t: Awaited<ReturnType<typeof seedTenant>>, deviceId: string) {
  const r = await createAndEnqueueAgentRun({
    orgId: t.org.id, kind: 'triage', triggerKind: 'manual', deviceId, dedupeKey: `manual:${randomUUID()}`,
    grant: { grantId: t.grant.grantId, grantRevisionId: t.grant.revisionId },
  });
  if (!r.created) throw new Error(`expected admission, got ${r.skipped}`);
  await sys(() => db.update(aiAgentRuns).set({ profile: 'assessment' }).where(eq(aiAgentRuns.id, r.run.id)));
  return r.run.id;
}

beforeEach(() => {
  vi.stubEnv('IS_HOSTED', 'true');
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('BREEZE_WISP_ENABLED', 'true');
  vi.stubEnv('BREEZE_AI_WORKSPACE_ENABLED', 'true');
  registerAgentRunEnqueuer(async (runId) => ({ enqueued: true, jobId: `agent-run:${runId}` }));
});
afterEach(() => {
  registerAgentRunEnqueuer(null);
  vi.unstubAllEnvs();
});

describe('Wisp specialist coordinator (real Postgres)', () => {
  it('analysis without ai_workspace:execute in the grantor\'s ceiling → workspace_execute_required, and no run row', async () => {
    const t = await seedTenant([
      { resource: 'ai_sessions', action: 'use' },
      { resource: 'ai_agents', action: 'write' },
      { resource: 'devices', action: 'read' },
    ]);
    const runId = await seedAssessmentRun(t, t.deviceId);
    const requestId = randomUUID();
    const result = await requestSpecialist({
      grantId: t.grant.grantId, grantRevisionId: t.grant.revisionId, orgId: t.org.id, kind: 'analysis',
      params: { goal: 'Why are three devices slow?' }, requestedByRunId: runId,
    }, { requestId });
    expect(result).toEqual({ refused: 'workspace_execute_required' });
    const rows = await sys(() => db.select({ id: aiAgentRuns.id }).from(aiAgentRuns)
      .where(and(eq(aiAgentRuns.orgId, t.org.id), eq(aiAgentRuns.dedupeKey, specialistDedupeKey(requestId)))));
    expect(rows).toEqual([]);
  });

  it('an asks-first kind from an assessment mints ONE approval card under the run\'s agent principal; a retry converges on it', async () => {
    const t = await seedTenant([
      { resource: 'ai_sessions', action: 'use' },
      { resource: 'ai_agents', action: 'write' },
      { resource: 'devices', action: 'read' },
    ]);
    const runId = await seedAssessmentRun(t, t.deviceId);
    const requestId = randomUUID();
    const input = {
      grantId: t.grant.grantId, grantRevisionId: t.grant.revisionId, orgId: t.org.id, kind: 'patch_plan' as const,
      params: {}, requestedByRunId: runId,
    };
    const first = await requestSpecialist(input, { requestId, reason: 'Patch compliance dropped this week' });
    expect(first).toMatchObject({ needsApproval: true });
    const second = await requestSpecialist(input, { requestId, reason: 'Patch compliance dropped this week' });
    expect(second).toEqual(first);

    const intents = await sys(() => db.select().from(actionIntents)
      .where(and(eq(actionIntents.orgId, t.org.id), eq(actionIntents.actionName, WISP_SPECIALIST_REQUEST_TOOL))));
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      status: 'pending_approval', source: 'ai_agent', requestingAgentRunId: runId, originPrincipalKind: 'ai_agent',
    });
    expect((intents[0]!.arguments as { requestId: string }).requestId).toBe(requestId);
    // No child was admitted: the card is the ask.
    const children = await sys(() => db.select({ id: aiAgentRuns.id }).from(aiAgentRuns)
      .where(eq(aiAgentRuns.requestedByRunId, runId)));
    expect(children).toEqual([]);
  });

  it('a request naming a child run as its requester is refused depth_exceeded (depth is one)', async () => {
    const t = await seedTenant([
      { resource: 'ai_sessions', action: 'use' },
      { resource: 'ai_agents', action: 'write' },
      { resource: 'devices', action: 'read' },
    ]);
    const parent = await seedAssessmentRun(t, t.deviceId);
    const child = await createAndEnqueueAgentRun({
      orgId: t.org.id, kind: 'triage', triggerKind: 'manual', deviceId: t.deviceId, dedupeKey: `manual:${randomUUID()}`,
      grant: { grantId: t.grant.grantId, grantRevisionId: t.grant.revisionId, requestedByRunId: parent },
    });
    if (!child.created) throw new Error(`expected child admission, got ${child.skipped}`);
    // Even dressed up as an assessment, a depth-1 run cannot request.
    await sys(() => db.update(aiAgentRuns).set({ profile: 'assessment' }).where(eq(aiAgentRuns.id, child.run.id)));
    const result = await requestSpecialist({
      grantId: t.grant.grantId, grantRevisionId: t.grant.revisionId, orgId: t.org.id, kind: 'sweep',
      params: {}, requestedByRunId: child.run.id,
    }, { requestId: randomUUID() });
    expect(result).toEqual({ refused: 'depth_exceeded' });
  });

  it('a card approved, then the grant paused before release → grant_inactive and no child (Review Focus 1)', async () => {
    const t = await seedTenant([
      { resource: 'ai_sessions', action: 'use' },
      { resource: 'ai_agents', action: 'write' },
      { resource: 'devices', action: 'read' },
    ]);
    const runId = await seedAssessmentRun(t, t.deviceId);
    const requestId = randomUUID();
    const card = await requestSpecialist({
      grantId: t.grant.grantId, grantRevisionId: t.grant.revisionId, orgId: t.org.id, kind: 'patch_plan',
      params: {}, requestedByRunId: runId,
    }, { requestId, reason: 'Patch compliance dropped this week' });
    if (!('needsApproval' in card)) throw new Error(`expected a card, got ${JSON.stringify(card)}`);

    // Approved by the partner admin, claimed for release…
    await sys(() => db.update(actionIntents).set({
      status: 'executing', decidedByUserId: t.admin.id, decidedAt: new Date(), decidedVia: 'human',
    } as never).where(eq(actionIntents.id, card.intentId)));
    // …and the grantor paused Wisp in between.
    await sys(() => db.update(wispGrants).set({ status: 'paused', pausedReason: 'user_paused', pausedAt: new Date() } as never)
      .where(eq(wispGrants.id, t.grant.grantId)));

    const [intent] = await sys(() => db.select().from(actionIntents).where(eq(actionIntents.id, card.intentId)));
    const out = JSON.parse(await wispSpecialistRequestHandler(
      intent!.arguments as Record<string, unknown>, {} as AuthContext, { actionIntentId: card.intentId },
    ));
    expect(out).toEqual({ error: 'grant_inactive' });
    const children = await sys(() => db.select({ id: aiAgentRuns.id }).from(aiAgentRuns)
      .where(eq(aiAgentRuns.requestedByRunId, runId)));
    expect(children).toEqual([]);
  });

  it('the same request id twice admits exactly one child run (Review Focus 3, real dedupe key)', async () => {
    const t = await seedTenant([
      { resource: 'ai_sessions', action: 'use' },
      { resource: 'ai_agents', action: 'write' },
      { resource: 'devices', action: 'read' },
    ]);
    const runId = await seedAssessmentRun(t, t.deviceId);
    const approver = {
      principal: { kind: 'user_session' },
      user: { id: t.admin.id, email: 'admin@wisp.test', name: 'Admin', isPlatformAdmin: false },
      token: null, partnerId: t.partner.id, orgId: null, scope: 'partner',
      accessibleOrgIds: [t.org.id], partnerOrgAccess: 'all',
      orgCondition: () => undefined, canAccessOrg: (id: string) => id === t.org.id,
    } as unknown as AuthContext;
    const requestId = randomUUID();
    const input = {
      grantId: t.grant.grantId, grantRevisionId: t.grant.revisionId, orgId: t.org.id, kind: 'remediation_research' as const,
      params: { deviceId: t.deviceId }, requestedByRunId: runId,
    };
    const opts = { requester: { kind: 'approval' as const, intentId: randomUUID(), auth: approver }, requestId };
    const a = await requestSpecialist(input, opts);
    const b = await requestSpecialist(input, opts);
    expect(a).toMatchObject({ admitted: true });
    expect(b).toEqual(a);
    const rows = await sys(() => db.select().from(aiAgentRuns)
      .where(and(eq(aiAgentRuns.orgId, t.org.id), eq(aiAgentRuns.dedupeKey, specialistDedupeKey(requestId)))));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      depth: 1, requestedByRunId: runId, parentGrantRevisionId: t.grant.revisionId, grantId: t.grant.grantId,
      profile: 'remediation_research',
    });

    // A child outlives its parent (retention): pointers clear, org and depth stay.
    await sys(() => db.delete(aiAgentRuns).where(eq(aiAgentRuns.id, runId)));
    const [orphan] = await sys(() => db.select().from(aiAgentRuns).where(eq(aiAgentRuns.id, rows[0]!.id)));
    expect(orphan).toMatchObject({ depth: 1, requestedByRunId: null, orgId: t.org.id });
  });

  it('no other agent path can mint the carrier: createActionIntent refuses it without the coordinator mint', async () => {
    const t = await seedTenant([
      { resource: 'ai_sessions', action: 'use' },
      { resource: 'ai_agents', action: 'write' },
      { resource: 'devices', action: 'read' },
    ]);
    const runId = await seedAssessmentRun(t, t.deviceId);
    const [run] = await sys(() => db.select().from(aiAgentRuns).where(eq(aiAgentRuns.id, runId)));
    const [agent] = await sys(() => db.select().from(aiAgents).where(eq(aiAgents.id, run!.agentId)));
    const agentAuth = buildAgentAuthContext(agent!, { id: runId, orgId: t.org.id, deviceId: null, deviceSiteId: null }, { id: t.org.id, partnerId: t.partner.id });
    await expect(createActionIntent(agentAuth, {
      toolName: WISP_SPECIALIST_REQUEST_TOOL,
      input: { requestId: randomUUID(), kind: 'patch_plan', orgId: t.org.id, grantId: t.grant.grantId, grantRevisionId: t.grant.revisionId, params: {}, reason: 'x' },
      source: 'ai_agent',
      orgId: t.org.id,
    })).rejects.toMatchObject({ code: 'coordinator_carrier_only' });
    const intents = await sys(() => db.select({ id: actionIntents.id }).from(actionIntents)
      .where(and(eq(actionIntents.orgId, t.org.id), eq(actionIntents.actionName, WISP_SPECIALIST_REQUEST_TOOL))));
    expect(intents).toEqual([]);
  });
});
