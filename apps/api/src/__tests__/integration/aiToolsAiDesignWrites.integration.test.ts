/**
 * Integration test — W16 PR B (#6786): the two design multiplexers against real Postgres as the unprivileged
 * `breeze_app` role, through the REAL durable pipeline (`createActionIntent` -> approve via `approvalRoutes` ->
 * `releaseApprovedIntent`, the function the worker's job processor calls), with the requesting session gone.
 *
 * Proven:
 *   - Decision 8: a baseline create released by the worker succeeds for a full-partner admin; the same intent for a
 *     member narrowed to `selected` fails and writes no row;
 *   - #11135: `manage_org_portal_settings:set_sensitive_access`, filed by a partner admin and approved by a second
 *     user, is released by the worker and lands (it used to fail closed on the organization axis);
 *   - a schedule delete released after an override changed refuses, and the baseline survives;
 *   - an org caller's override cannot reach another partner's baseline;
 *   - an override delete blocked by a real FOR UPDATE held by a concurrent disarm re-evaluates, and refuses;
 *   - a four-eyes Fleet Design apply and rollback release end to end on the organization axis;
 *   - an apply released after a device left the function's group refuses and writes no ledger row;
 *   - a change committed after digest verification and before the handler's lock refuses (`CONTENT_CHANGED`);
 *   - two concurrent releases of one apply: one applies, the other finds the ledger moved and refuses;
 *   - a rollback released after someone assigned the policy elsewhere refuses, and the digest binds it.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { fleetDesignOutcomeFromSubmission, type FleetDesignApproval, type FleetDesignOutcome, type FleetDesignReportSummary, type FleetDesignSubmission } from '@breeze/shared';

vi.hoisted(() => {
  process.env.BREEZE_AI_AGENTS_ENABLED = 'true';
});

import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  aiAgents,
  aiAgentSchedules,
  configPolicyAssignments,
  deviceGroupMemberships,
  devices,
  fleetDesignAppliedItems,
  portalBranding,
  reportRuns,
  reports,
} from '../../db/schema';
import { actionIntents } from '../../db/schema/actionIntents';
import { approvalRequests } from '../../db/schema/approvals';
import { partnerUsers } from '../../db/schema/users';
import { buildDbAccessContext, buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { approvalRoutes } from '../../routes/approvals';
import { releaseApprovedIntent } from '../../jobs/intentReleaseWorker';
import { computeEffectDigestForRelease } from '../../services/actionIntents/effectDigest';
import { createActionIntent } from '../../services/actionIntents/intentService';
import { executeTool } from '../../services/aiTools';
import { applyFleetDesign } from '../../services/fleetDesign/apply';
import { createAccessToken } from '../../services/jwt';
import { clearPermissionCache, PERMISSIONS } from '../../services/permissions';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

type Person = { id: string; email: string; roleId: string };

function partnerAuth(user: Person, partnerId: string, orgId: string, partnerOrgAccess: 'all' | 'selected' = 'all'): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([orgId]);
  return {
    principal: { kind: 'user_session' },
    user: { id: user.id, email: user.email, name: 'Fixture', isPlatformAdmin: false },
    token: { sub: user.id, email: user.email, roleId: user.roleId, orgId, partnerId, scope: 'partner', type: 'access', mfa: true },
    partnerId,
    orgId,
    scope: 'partner',
    accessibleOrgIds: [orgId],
    partnerOrgAccess,
    orgCondition,
    canAccessOrg,
    canAccessSite: () => true,
  } as unknown as AuthContext;
}

async function approve(approver: Person, orgId: string, partnerId: string, approvalRowId: string, scope: 'organization' | 'partner' = 'organization') {
  const token = await createAccessToken({
    sub: approver.id, email: approver.email, roleId: approver.roleId, orgId: scope === 'organization' ? orgId : null, partnerId, scope, mfa: false, aep: 1, mep: 1, sid: randomUUID(),
  });
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return app.request(`/approvals/${approvalRowId}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

const intentRow = (intentId: string) => withSystemDbAccessContext(async () => {
  const [row] = await db.select().from(actionIntents).where(eq(actionIntents.id, intentId)).limit(1);
  return row!;
});

/** Files through the real service, decides through the real route, releases through the worker's function. */
async function fileAndRelease(
  auth: AuthContext,
  toolName: string,
  input: Record<string, unknown>,
  approver: Person,
  opts: { approverScope?: 'organization' | 'partner'; beforeRelease?: () => Promise<void> } = {},
) {
  const snapshot = await createActionIntent(auth, { toolName, input, source: 'chat', orgId: auth.orgId! } as never);
  expect(snapshot.status, JSON.stringify(snapshot)).toBe('pending_approval');
  const [row] = await withSystemDbAccessContext(() => db.select({ id: approvalRequests.id }).from(approvalRequests).where(eq(approvalRequests.intentId, snapshot.id)));
  const res = await approve(approver, auth.orgId!, auth.partnerId!, row!.id, opts.approverScope);
  expect(res.status, await res.clone().text()).toBe(200);
  await opts.beforeRelease?.();
  clearPermissionCache();
  await releaseApprovedIntent(snapshot.id);
  return intentRow(snapshot.id);
}

async function seedPartner(grants: Array<{ resource: string; action: string }>, orgAccess: 'all' | 'selected' = 'all') {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });

  const requesterRole = await createRole({ scope: 'partner', partnerId: partner.id, name: `W16B ${randomUUID()}` });
  await grantRolePermissions(requesterRole.id, grants);
  const requesterRow = await createUser({ partnerId: partner.id, orgId: null, email: `w16b-req-${randomUUID()}@example.com` });
  const membership = await assignUserToPartner(requesterRow.id, partner.id, requesterRole.id, orgAccess);

  const approverRole = await createRole({ scope: 'organization', orgId: org.id, name: `W16B approver ${randomUUID()}` });
  await grantRolePermissions(approverRole.id, [PERMISSIONS.APPROVALS_DECIDE]);
  const approverRow = await createUser({ partnerId: partner.id, orgId: org.id, email: `w16b-app-${randomUUID()}@example.com` });
  await assignUserToOrganization(approverRow.id, org.id, approverRole.id);

  const requester: Person = { id: requesterRow.id, email: requesterRow.email, roleId: requesterRole.id };
  const approver: Person = { id: approverRow.id, email: approverRow.email, roleId: approverRole.id };
  return { partner, org, site, requester, approver, membership, auth: partnerAuth(requester, partner.id, org.id, orgAccess) };
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

const scheduleGrants = [PERMISSIONS.AI_AGENTS_READ, PERMISSIONS.AI_AGENTS_WRITE, PERMISSIONS.APPROVALS_DECIDE];

async function seedSchedules(orgAccess: 'all' | 'selected' = 'all') {
  const f = await seedPartner(scheduleGrants, orgAccess);
  const [agent] = await withSystemDbAccessContext(() => db.insert(aiAgents).values({
    orgId: null, partnerId: f.partner.id, kind: 'triage', name: 'W16B triage', enabled: true, createdBy: f.requester.id, limits: {},
  }).returning());
  return { ...f, agentId: agent!.id };
}

const baselineValues = (partnerId: string, agentId: string, over: Record<string, unknown> = {}) => ({
  orgId: null, partnerId, agentId, baselineScheduleId: null, kind: 'sweep' as const, cron: '0 2 * * *', timezone: 'UTC',
  sweepKinds: ['disk_pressure', 'stale_agents'] as never, enabled: true, updatedAt: new Date(), ...over,
});

async function seedBaseline(partnerId: string, agentId: string, over: Record<string, unknown> = {}) {
  const [row] = await getTestDb().insert(aiAgentSchedules).values(baselineValues(partnerId, agentId, over) as never).returning();
  return row!;
}

async function seedOverride(orgId: string, baseline: { id: string; agentId: string }, over: Record<string, unknown> = {}) {
  const [row] = await getTestDb().insert(aiAgentSchedules).values({
    orgId, partnerId: null, agentId: baseline.agentId, baselineScheduleId: baseline.id, kind: 'sweep', cron: '0 2 * * *', timezone: 'UTC',
    sweepKinds: ['disk_pressure', 'stale_agents'] as never, enabled: true, updatedAt: new Date(), ...over,
  } as never).returning();
  return row!;
}

const schedulesOf = (partnerId: string) => getTestDb().select().from(aiAgentSchedules).where(eq(aiAgentSchedules.partnerId, partnerId));

describe('manage_ai_agent_schedules released by the worker (Decision 8)', () => {
  const createBaselineInput = (agentId: string) => ({
    action: 'create', ownerScope: 'partner', kind: 'sweep', agentId, cron: '0 2 * * *', timezone: 'UTC', sweepKinds: ['disk_pressure'], enabled: true,
  });

  runDb('a baseline create succeeds for a full-partner admin, with the requesting session gone', async () => {
    const f = await seedSchedules();
    const intent = await fileAndRelease(f.auth, 'manage_ai_agent_schedules', createBaselineInput(f.agentId), f.requester, { approverScope: 'partner' });
    expect(intent.status, JSON.stringify(intent.result)).toBe('completed');
    const rows = await schedulesOf(f.partner.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: f.partner.id, orgId: null, enabled: true, actMode: null });
  });

  runDb('the same intent for a member narrowed to selected fails, and writes no row', async () => {
    const f = await seedSchedules();
    const intent = await fileAndRelease(f.auth, 'manage_ai_agent_schedules', createBaselineInput(f.agentId), f.requester, {
      approverScope: 'partner',
      beforeRelease: async () => {
        await getTestDb().update(partnerUsers).set({ orgAccess: 'selected', orgIds: [f.org.id] }).where(eq(partnerUsers.id, f.membership.id));
      },
    });
    expect(intent.status).toBe('failed');
    await expect(schedulesOf(f.partner.id)).resolves.toHaveLength(0);
  });

  runDb('a baseline delete released after an override changed refuses, and the baseline survives', async () => {
    const f = await seedSchedules();
    const baseline = await seedBaseline(f.partner.id, f.agentId);
    const override = await seedOverride(f.org.id, baseline);
    const intent = await fileAndRelease(f.auth, 'manage_ai_agent_schedules', { action: 'delete', scheduleId: baseline.id }, f.approver, {
      beforeRelease: async () => {
        await getTestDb().update(aiAgentSchedules).set({ enabled: false }).where(eq(aiAgentSchedules.id, override.id));
      },
    });
    expect(intent.status).toBe('failed');
    expect(intent.errorCode).toBe('content_changed');
    await expect(schedulesOf(f.partner.id)).resolves.toHaveLength(1);
  });

  runDb('CONTROL: the same delete with nothing changed lands, and cascades the override', async () => {
    const f = await seedSchedules();
    const baseline = await seedBaseline(f.partner.id, f.agentId);
    const override = await seedOverride(f.org.id, baseline);
    const intent = await fileAndRelease(f.auth, 'manage_ai_agent_schedules', { action: 'delete', scheduleId: baseline.id }, f.approver);
    expect(intent.status, JSON.stringify(intent.result)).toBe('completed');
    await expect(schedulesOf(f.partner.id)).resolves.toHaveLength(0);
    await expect(getTestDb().select().from(aiAgentSchedules).where(eq(aiAgentSchedules.id, override.id))).resolves.toHaveLength(0);
  });
});

describe('manage_ai_agent_schedules against real rows', () => {
  const run = (auth: AuthContext, input: Record<string, unknown>) => withDbAccessContext(
    buildDbAccessContext({ scope: auth.scope, orgId: auth.orgId, accessibleOrgIds: auth.accessibleOrgIds ?? [], partnerId: auth.partnerId, userId: auth.user.id }),
    () => executeTool('manage_ai_agent_schedules', input, auth),
  ).then((raw) => JSON.parse(raw) as Record<string, any>);

  runDb("an org caller's override cannot reach another partner's baseline", async () => {
    const f = await seedSchedules();
    const foreign = await seedSchedules();
    const foreignBaseline = await seedBaseline(foreign.partner.id, foreign.agentId);
    const orgRole = await createRole({ scope: 'organization', orgId: f.org.id, name: `W16B org ${randomUUID()}` });
    await grantRolePermissions(orgRole.id, scheduleGrants);
    const orgUser = await createUser({ partnerId: f.partner.id, orgId: f.org.id, email: `w16b-org-${randomUUID()}@example.com` });
    await assignUserToOrganization(orgUser.id, f.org.id, orgRole.id);
    const { orgCondition, canAccessOrg } = buildOrgAccessClosures([f.org.id]);
    const auth = {
      ...f.auth, scope: 'organization', orgCondition, canAccessOrg, partnerOrgAccess: null,
      user: { id: orgUser.id, email: orgUser.email, name: 'Org', isPlatformAdmin: false },
      token: { sub: orgUser.id, email: orgUser.email, roleId: orgRole.id, orgId: f.org.id, partnerId: f.partner.id, scope: 'organization', type: 'access', mfa: true },
    } as unknown as AuthContext;

    const out = await run(auth, { action: 'create', ownerScope: 'organization', orgId: f.org.id, baselineScheduleId: foreignBaseline.id, enabled: true, sweepKinds: [] });
    expect(out.code).toBe('baseline_wrong_partner');
    await expect(getTestDb().select().from(aiAgentSchedules).where(eq(aiAgentSchedules.orgId, f.org.id))).resolves.toHaveLength(0);
  });

  runDb('an armed baseline refuses a widening from the tool', async () => {
    const f = await seedSchedules();
    const baseline = await seedBaseline(f.partner.id, f.agentId, { actMode: true, enabled: false });
    const out = await run(f.auth, { action: 'update', scheduleId: baseline.id, enabled: true });
    expect(out.code).toBe('armed_widening_refused');
    const [row] = await getTestDb().select().from(aiAgentSchedules).where(eq(aiAgentSchedules.id, baseline.id));
    expect(row!.enabled).toBe(false);
  });

  runDb('an override delete blocked by a FOR UPDATE held by a concurrent disarm re-evaluates, and refuses', async () => {
    const f = await seedSchedules();
    const baseline = await seedBaseline(f.partner.id, f.agentId, { actMode: true });
    const override = await seedOverride(f.org.id, baseline);

    let commit!: () => void;
    const gate = new Promise<void>((resolve) => { commit = resolve; });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => { locked = resolve; });
    const disarm = getTestDb().transaction(async (tx) => {
      await tx.select({ id: aiAgentSchedules.id }).from(aiAgentSchedules).where(eq(aiAgentSchedules.id, override.id)).for('update');
      await tx.update(aiAgentSchedules).set({ actMode: false }).where(eq(aiAgentSchedules.id, override.id));
      locked();
      await gate;
    });
    await isLocked;

    let settled = false;
    const deleting = run(f.auth, { action: 'delete', scheduleId: override.id }).finally(() => { settled = true; });
    // It reads the row without a lock first, so give it time to reach the locked read and block there.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(settled, 'the delete waits on the row lock').toBe(false);
    commit();
    await disarm;

    const out = await deleting;
    expect(out.code).toBe('armed_widening_refused');
    await expect(getTestDb().select().from(aiAgentSchedules).where(eq(aiAgentSchedules.id, override.id))).resolves.toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// #11135: the W18 action in the same registry
// ---------------------------------------------------------------------------

describe('manage_org_portal_settings:set_sensitive_access released by the worker (#11135)', () => {
  const grants = [PERMISSIONS.ORGS_READ, PERMISSIONS.ORGS_WRITE];
  const input = (orgId: string) => ({ action: 'set_sensitive_access', orgId, flags: { enablePatchDetail: true } });

  runDb('filed by a partner admin, approved by a second user, released with the session gone: it lands', async () => {
    const f = await seedPartner(grants);
    const intent = await fileAndRelease(f.auth, 'manage_org_portal_settings', input(f.org.id), f.approver);
    expect(intent.status, JSON.stringify(intent.result)).toBe('completed');
    const [row] = await getTestDb().select().from(portalBranding).where(eq(portalBranding.orgId, f.org.id));
    expect(row?.enablePatchDetail).toBe(true);
  });

  runDb('a flag changed after approval still refuses: the digest re-check is intact', async () => {
    const f = await seedPartner(grants);
    await getTestDb().insert(portalBranding).values({ orgId: f.org.id });
    const intent = await fileAndRelease(f.auth, 'manage_org_portal_settings', input(f.org.id), f.approver, {
      beforeRelease: async () => {
        await getTestDb().update(portalBranding).set({ enablePhysicalPlacement: true }).where(eq(portalBranding.orgId, f.org.id));
      },
    });
    expect(intent.errorCode).toBe('content_changed');
    const [row] = await getTestDb().select().from(portalBranding).where(eq(portalBranding.orgId, f.org.id));
    expect(row?.enablePatchDetail).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fleet Designs
// ---------------------------------------------------------------------------

const fleetGrants = [PERMISSIONS.DEVICES_READ, PERMISSIONS.DEVICES_WRITE, PERMISSIONS.AI_AGENTS_READ, PERMISSIONS.AI_AGENTS_WRITE];

let deviceSeq = 0;
async function seedDevice(orgId: string, siteId: string): Promise<string> {
  deviceSeq += 1;
  const [device] = await getTestDb().insert(devices).values({
    orgId, siteId, agentId: `agent-w16b-${Date.now()}-${deviceSeq}`, hostname: `w16b-${deviceSeq}`, osType: 'windows', osVersion: '11', architecture: 'x64', agentVersion: '1.0.0',
  }).returning({ id: devices.id });
  return device!.id;
}

function outcomeFor(deviceIds: string[]): FleetDesignOutcome {
  const submission: FleetDesignSubmission = {
    found: { summary: ['fixture'], findings: [] },
    functions: [{ functionKey: 'file_server', deviceIds, confidence: 0.9, evidence: ['SMB shares active'] }],
    monitoring: [{
      functionKey: 'file_server',
      watches: [{ watchType: 'service', name: 'LanmanServer', alertOnStop: true, autoRestart: true, rationale: 'Core service' }],
      alertRules: [],
    }],
    retired: [],
    automation: [],
    legacy: [],
    baseline: { notes: [] },
    unsure: { lowConfidenceFunctions: [], unreachableDevices: [], needsHuman: [], roleCorrections: [] },
  } as unknown as FleetDesignSubmission;
  return fleetDesignOutcomeFromSubmission(submission, {
    deviceIds: new Set(deviceIds),
    baseline: { alertsPer100EndpointsPerMonth: null, ticketsPerMonth: null, precursors: [] },
    generatedAt: new Date().toISOString(),
  });
}

async function seedFleet() {
  const f = await seedPartner(fleetGrants);
  const deviceIds = [await seedDevice(f.org.id, f.site.id), await seedDevice(f.org.id, f.site.id)];
  const outcome = outcomeFor(deviceIds);
  const [report] = await getTestDb().insert(reports).values({
    orgId: f.org.id, name: 'Fleet Design', type: 'ai_fleet_design', config: {}, schedule: 'one_time', format: 'pdf', createdBy: null,
  }).returning({ id: reports.id });
  const summary = { fleetDesign: { schemaVersion: outcome.schemaVersion, outcome, runId: null, orgName: 'Fixture', generatedAt: new Date().toISOString() } } as unknown as FleetDesignReportSummary;
  const [run] = await getTestDb().insert(reportRuns).values({
    reportId: report!.id, status: 'completed', startedAt: new Date(), completedAt: new Date(), rowCount: 0, result: { rows: [], rowCount: 0, summary },
  }).returning({ id: reportRuns.id });
  return { ...f, deviceIds, reportRunId: run!.id };
}

const functionsOnly: FleetDesignApproval = { functions: ['file_server'], monitoring: [], retired: [], automation: [], legacy: [], roleCorrections: [], displacementsAccepted: [] };
const monitoringOnly: FleetDesignApproval = { ...functionsOnly, functions: [], monitoring: ['monitoring:file_server:watch:0'] };

const ledgerOf = (reportRunId: string) => getTestDb().select().from(fleetDesignAppliedItems).where(eq(fleetDesignAppliedItems.reportRunId, reportRunId));

const contextOf = (auth: AuthContext) => buildDbAccessContext({ scope: auth.scope, orgId: auth.orgId, accessibleOrgIds: auth.accessibleOrgIds ?? [], partnerId: auth.partnerId, userId: auth.user.id });

/** The first half of a design, applied directly, so the next apply reuses a real group. */
const applyFunctions = (f: Awaited<ReturnType<typeof seedFleet>>) => withDbAccessContext(contextOf(f.auth), () => applyFleetDesign(f.auth, f.reportRunId, functionsOnly));

/** The digest a release would verify, read as the release paths read it. */
const verified = async (input: Record<string, unknown>) => {
  const result = await withSystemDbAccessContext(() => computeEffectDigestForRelease('manage_fleet_designs', input, db));
  expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(result.context?.verifiedFleetDesignBinding).toEqual({ digest: result.digest });
  return result.context!.verifiedFleetDesignBinding!;
};

const runFleet = (auth: AuthContext, input: Record<string, unknown>, binding?: { digest: string }) => withDbAccessContext(
  contextOf(auth),
  () => executeTool('manage_fleet_designs', input, auth, binding ? { context: { actionIntentId: randomUUID(), verifiedFleetDesignBinding: binding } } : undefined),
).then((raw) => JSON.parse(raw) as Record<string, any>);

describe('manage_fleet_designs released by the worker', () => {
  const applyInput = (reportRunId: string, approval: FleetDesignApproval) => ({ action: 'apply', reportRunId, approval });

  runDb('a four-eyes apply lands end to end, then a four-eyes rollback undoes it', async () => {
    const f = await seedFleet();
    const applied = await fileAndRelease(f.auth, 'manage_fleet_designs', applyInput(f.reportRunId, functionsOnly), f.approver);
    expect(applied.status, JSON.stringify(applied.result)).toBe('completed');
    expect((await ledgerOf(f.reportRunId)).map((r) => r.status)).toEqual(['applied']);

    const rolled = await fileAndRelease(f.auth, 'manage_fleet_designs', { action: 'rollback', reportRunId: f.reportRunId }, f.approver);
    expect(rolled.status, JSON.stringify(rolled.result)).toBe('completed');
    expect((await ledgerOf(f.reportRunId)).map((r) => r.status)).toEqual(['rolled_back']);
  });

  runDb('an apply released after a device left the function group refuses, and writes no ledger row', async () => {
    const f = await seedFleet();
    await applyFunctions(f);
    const before = (await ledgerOf(f.reportRunId)).length;
    const intent = await fileAndRelease(f.auth, 'manage_fleet_designs', applyInput(f.reportRunId, monitoringOnly), f.approver, {
      beforeRelease: async () => {
        await getTestDb().delete(deviceGroupMemberships).where(eq(deviceGroupMemberships.deviceId, f.deviceIds[0]!));
      },
    });
    expect(intent.status).toBe('failed');
    expect(intent.errorCode).toBe('content_changed');
    await expect(ledgerOf(f.reportRunId)).resolves.toHaveLength(before);
  });

  runDb('a rollback released after the policy gained an assignment refuses', async () => {
    const f = await seedFleet();
    await applyFunctions(f);
    const applied = await fileAndRelease(f.auth, 'manage_fleet_designs', applyInput(f.reportRunId, monitoringOnly), f.approver);
    expect(applied.status, JSON.stringify(applied.result)).toBe('completed');
    const [policyRow] = await getTestDb().select().from(fleetDesignAppliedItems).where(and(
      eq(fleetDesignAppliedItems.reportRunId, f.reportRunId),
      eq(fleetDesignAppliedItems.itemKind, 'policy'),
    ));
    const intent = await fileAndRelease(f.auth, 'manage_fleet_designs', { action: 'rollback', reportRunId: f.reportRunId }, f.approver, {
      beforeRelease: async () => {
        await getTestDb().insert(configPolicyAssignments).values({ configPolicyId: policyRow!.createdRefs!.policyId!, level: 'site', targetId: f.site.id, priority: 5 });
      },
    });
    expect(intent.errorCode).toBe('content_changed');
    expect((await ledgerOf(f.reportRunId)).every((r) => r.status === 'applied')).toBe(true);
  });
});

describe('manage_fleet_designs under the report-run lock (Review Focus #3)', () => {
  const input = (reportRunId: string, approval: FleetDesignApproval = functionsOnly) => ({ action: 'apply', reportRunId, approval });

  runDb('a change committed after verification and before the lock refuses: CONTENT_CHANGED, no ledger row', async () => {
    const f = await seedFleet();
    const args = input(f.reportRunId);
    const binding = await verified(args);
    await getTestDb().update(devices).set({ deviceRoleSource: 'manual' }).where(eq(devices.id, f.deviceIds[0]!));
    const out = await runFleet(f.auth, args, binding);
    expect(out.code).toBe('CONTENT_CHANGED');
    await expect(ledgerOf(f.reportRunId)).resolves.toHaveLength(0);
  });

  runDb('CONTROL: with nothing changed the verified digest matches under the caller context, and it applies', async () => {
    const f = await seedFleet();
    const args = input(f.reportRunId);
    const out = await runFleet(f.auth, args, await verified(args));
    expect(out.error).toBeUndefined();
    expect(out.applied).toEqual(['functions:file_server']);
  });

  runDb('no binding is refused against a real report', async () => {
    const f = await seedFleet();
    const out = await runFleet(f.auth, input(f.reportRunId));
    expect(out.code).toBe('APPROVAL_REQUIRED');
    await expect(ledgerOf(f.reportRunId)).resolves.toHaveLength(0);
  });

  runDb('two concurrent releases of one apply: one applies, the other refuses on the moved ledger', async () => {
    const f = await seedFleet();
    const args = input(f.reportRunId);
    const binding = await verified(args);
    const results = await Promise.all([runFleet(f.auth, args, binding), runFleet(f.auth, args, binding)]);
    const codes = results.map((r) => r.code).sort();
    expect(codes).toEqual(['CONTENT_CHANGED', undefined].sort());
    expect(results.filter((r) => Array.isArray(r.applied))).toHaveLength(1);
    await expect(ledgerOf(f.reportRunId)).resolves.toHaveLength(1);
  });

  runDb("a foreign partner's report is the same not found, and no digest is consumed", async () => {
    const f = await seedFleet();
    const foreign = await seedFleet();
    const args = input(foreign.reportRunId);
    const out = await runFleet(f.auth, args, await verified(args));
    expect(out.code).toBe('NOT_FOUND');
    await expect(ledgerOf(foreign.reportRunId)).resolves.toHaveLength(0);
  });

  runDb('a preview reads the design under the caller context, with no approval', async () => {
    const f = await seedFleet();
    const preview = await runFleet(f.auth, { action: 'preview', reportRunId: f.reportRunId, approval: functionsOnly });
    expect(preview.functions[0]).toMatchObject({ functionKey: 'file_server', deviceCount: 2 });
  });
});
