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
 *   - a rollback released after someone assigned the policy elsewhere refuses, and the digest binds it;
 *   - a baseline delete needs a full-partner approver at fan-out, at decide and at release, while an org-level override
 *     delete keeps the org's approver set.
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

/** A second partner member holding `approvals:decide`: a baseline delete's eligible approver when `orgAccess` is `all`. */
async function addPartnerApprover(partnerId: string, opts: { orgAccess?: 'all' | 'selected'; orgIds?: string[] } = {}): Promise<Person & { membershipId: string }> {
  const role = await createRole({ scope: 'partner', partnerId, name: `W16B partner approver ${randomUUID()}` });
  await grantRolePermissions(role.id, [PERMISSIONS.APPROVALS_DECIDE]);
  const row = await createUser({ partnerId, orgId: null, email: `w16b-papp-${randomUUID()}@example.com` });
  const membership = await assignUserToPartner(row.id, partnerId, role.id, opts.orgAccess ?? 'all');
  if (opts.orgIds) await getTestDb().update(partnerUsers).set({ orgIds: opts.orgIds }).where(eq(partnerUsers.id, membership.id));
  return { id: row.id, email: row.email, roleId: role.id, membershipId: membership.id };
}

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

  runDb('a member with selected access can still release an override write in an org they reach', async () => {
    const f = await seedSchedules('selected');
    await getTestDb().update(partnerUsers).set({ orgIds: [f.org.id] }).where(eq(partnerUsers.id, f.membership.id));
    const baseline = await seedBaseline(f.partner.id, f.agentId);
    const override = await seedOverride(f.org.id, baseline);
    const intent = await fileAndRelease(f.auth, 'manage_ai_agent_schedules', { action: 'update', scheduleId: override.id, enabled: false }, f.requester, { approverScope: 'partner' });
    expect(intent.status, JSON.stringify(intent.result)).toBe('completed');
    const [row] = await getTestDb().select().from(aiAgentSchedules).where(eq(aiAgentSchedules.id, override.id));
    expect(row!.enabled).toBe(false);
  });

  runDb('a baseline delete released after an override changed refuses, and the baseline survives', async () => {
    const f = await seedSchedules();
    const baseline = await seedBaseline(f.partner.id, f.agentId);
    const override = await seedOverride(f.org.id, baseline);
    const partnerApprover = await addPartnerApprover(f.partner.id);
    const intent = await fileAndRelease(f.auth, 'manage_ai_agent_schedules', { action: 'delete', scheduleId: baseline.id }, partnerApprover, {
      approverScope: 'partner',
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
    const partnerApprover = await addPartnerApprover(f.partner.id);
    const intent = await fileAndRelease(f.auth, 'manage_ai_agent_schedules', { action: 'delete', scheduleId: baseline.id }, partnerApprover, { approverScope: 'partner' });
    expect(intent.status, JSON.stringify(intent.result)).toBe('completed');
    await expect(schedulesOf(f.partner.id)).resolves.toHaveLength(0);
    await expect(getTestDb().select().from(aiAgentSchedules).where(eq(aiAgentSchedules.id, override.id))).resolves.toHaveLength(0);
  });
});

describe('approver scope for a partner-wide intent', () => {
  const approversOf = async (intentId: string) => {
    const rows = await withSystemDbAccessContext(() =>
      db.select({ id: approvalRequests.id, userId: approvalRequests.userId, riskSummary: approvalRequests.riskSummary })
        .from(approvalRequests)
        .where(eq(approvalRequests.intentId, intentId)));
    return rows;
  };

  /** A queued row for someone the fan-out left out: a card from before this rule, or a stale one. */
  async function queueStaleCard(intentId: string, userId: string) {
    const [source] = await getTestDb().select().from(approvalRequests).where(eq(approvalRequests.intentId, intentId)).limit(1);
    const { id: _id, createdAt: _createdAt, ...rest } = source!;
    const [row] = await getTestDb().insert(approvalRequests).values({ ...rest, userId } as never).returning({ id: approvalRequests.id });
    return row!.id;
  }

  const fileBaselineDelete = async (f: Awaited<ReturnType<typeof seedSchedules>>) => {
    const baseline = await seedBaseline(f.partner.id, f.agentId);
    const snapshot = await createActionIntent(f.auth, {
      toolName: 'manage_ai_agent_schedules', input: { action: 'delete', scheduleId: baseline.id }, source: 'chat', orgId: f.org.id,
    } as never);
    expect(snapshot.status, JSON.stringify(snapshot)).toBe('pending_approval');
    return { baseline, snapshot };
  };

  runDb('an org-axis admin and a selected member are not eligible for a baseline delete; a full-partner member is, and the card says so', async () => {
    const f = await seedSchedules();
    const partnerApprover = await addPartnerApprover(f.partner.id);
    const selected = await addPartnerApprover(f.partner.id, { orgAccess: 'selected', orgIds: [f.org.id] });
    const { snapshot } = await fileBaselineDelete(f);

    const rows = await approversOf(snapshot.id);
    expect(rows.map((r) => r.userId)).toEqual([partnerApprover.id]);
    expect(rows.map((r) => r.userId)).not.toContain(f.approver.id);
    expect(rows.map((r) => r.userId)).not.toContain(selected.id);
    expect(rows[0]!.riskSummary).toContain('needs a partner-level approver');
  });

  runDb('an org-axis admin holding a stale card is refused at decide, and the intent stays pending', async () => {
    const f = await seedSchedules();
    await addPartnerApprover(f.partner.id);
    const { snapshot, baseline } = await fileBaselineDelete(f);
    const staleRowId = await queueStaleCard(snapshot.id, f.approver.id);

    const res = await approve(f.approver, f.org.id, f.partner.id, staleRowId);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: 'approver_scope_required' });
    expect((await intentRow(snapshot.id)).status).toBe('pending_approval');
    await expect(getTestDb().select().from(aiAgentSchedules).where(eq(aiAgentSchedules.id, baseline.id))).resolves.toHaveLength(1);
  });

  runDb('a selected member holding a stale card is refused at decide', async () => {
    const f = await seedSchedules();
    await addPartnerApprover(f.partner.id);
    const selected = await addPartnerApprover(f.partner.id, { orgAccess: 'selected', orgIds: [f.org.id] });
    const { snapshot } = await fileBaselineDelete(f);
    const staleRowId = await queueStaleCard(snapshot.id, selected.id);

    const res = await approve(selected, f.org.id, f.partner.id, staleRowId, 'partner');

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: 'approver_scope_required' });
  });

  runDb('an approver narrowed to selected after approving is refused at release, and the baseline survives', async () => {
    const f = await seedSchedules();
    const partnerApprover = await addPartnerApprover(f.partner.id);
    const baseline = await seedBaseline(f.partner.id, f.agentId);
    const intent = await fileAndRelease(f.auth, 'manage_ai_agent_schedules', { action: 'delete', scheduleId: baseline.id }, partnerApprover, {
      approverScope: 'partner',
      beforeRelease: async () => {
        await getTestDb().update(partnerUsers).set({ orgAccess: 'selected', orgIds: [f.org.id] }).where(eq(partnerUsers.id, partnerApprover.membershipId));
      },
    });
    expect(intent.status).toBe('failed');
    expect(intent.errorCode).toBe('approver_scope_required');
    await expect(getTestDb().select().from(aiAgentSchedules).where(eq(aiAgentSchedules.id, baseline.id))).resolves.toHaveLength(1);
  });

  runDb("an org-level override delete keeps today's approver set, and an org admin can decide it", async () => {
    const f = await seedSchedules();
    const baseline = await seedBaseline(f.partner.id, f.agentId);
    const override = await seedOverride(f.org.id, baseline);
    const intent = await fileAndRelease(f.auth, 'manage_ai_agent_schedules', { action: 'delete', scheduleId: override.id }, f.approver);
    expect(intent.status, JSON.stringify(intent.result)).toBe('completed');
    expect((await approversOf(intent.id)).map((r) => r.userId)).toEqual([f.approver.id]);
    expect((await approversOf(intent.id))[0]!.riskSummary).not.toContain('partner-level');
    await expect(getTestDb().select().from(aiAgentSchedules).where(eq(aiAgentSchedules.id, override.id))).resolves.toHaveLength(0);
    await expect(getTestDb().select().from(aiAgentSchedules).where(eq(aiAgentSchedules.id, baseline.id))).resolves.toHaveLength(1);
  });

  runDb('a full-partner member who is also an org member is refused when deciding from an org session', async () => {
    const f = await seedSchedules();
    const dual = await addPartnerApprover(f.partner.id);
    await assignUserToOrganization(dual.id, f.org.id, f.approver.roleId);
    const { snapshot } = await fileBaselineDelete(f);
    const [row] = (await approversOf(snapshot.id)).filter((r) => r.userId === dual.id);

    const res = await approve({ ...dual, roleId: f.approver.roleId }, f.org.id, f.partner.id, row!.id, 'organization');

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: 'approver_scope_required' });
    expect((await intentRow(snapshot.id)).status).toBe('pending_approval');
  });

  runDb("an override in another org cannot use the session org's approvers: scope falls to the partner axis", async () => {
    const f = await seedSchedules();
    const partnerApprover = await addPartnerApprover(f.partner.id);
    const otherOrg = await createOrganization({ partnerId: f.partner.id });
    const baseline = await seedBaseline(f.partner.id, f.agentId);
    const override = await seedOverride(otherOrg.id, baseline);

    const snapshot = await createActionIntent(f.auth, {
      toolName: 'manage_ai_agent_schedules', input: { action: 'delete', scheduleId: override.id }, source: 'chat', orgId: f.org.id,
    } as never);

    expect(snapshot.status, JSON.stringify(snapshot)).toBe('pending_approval');
    expect((await approversOf(snapshot.id)).map((r) => r.userId)).toEqual([partnerApprover.id]);
  });

  runDb('with no other full-partner approver the requester gets the sole-operator row, not an org admin', async () => {
    const f = await seedSchedules();
    const { snapshot } = await fileBaselineDelete(f);
    expect((await approversOf(snapshot.id)).map((r) => r.userId)).toEqual([f.requester.id]);
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

  runDb('an override with actMode null under an armed baseline is allowed: the absent override already inherits', async () => {
    const f = await seedSchedules();
    const baseline = await seedBaseline(f.partner.id, f.agentId, { actMode: true });
    const out = await run(f.auth, { action: 'create', ownerScope: 'organization', orgId: f.org.id, baselineScheduleId: baseline.id, enabled: true, sweepKinds: ['disk_pressure'] });
    expect(out.error, JSON.stringify(out)).toBeUndefined();
    expect(out).toMatchObject({ ownerScope: 'organization', actMode: null });
  });

  runDb('a second override of the same baseline is override_exists, an envelope that survives the commit', async () => {
    const f = await seedSchedules();
    const baseline = await seedBaseline(f.partner.id, f.agentId);
    await seedOverride(f.org.id, baseline);
    const out = await run(f.auth, { action: 'create', ownerScope: 'organization', orgId: f.org.id, baselineScheduleId: baseline.id, enabled: true, sweepKinds: [] });
    expect(out.code).toBe('override_exists');
    await expect(getTestDb().select().from(aiAgentSchedules).where(eq(aiAgentSchedules.orgId, f.org.id))).resolves.toHaveLength(1);
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

function outcomeFor(deviceIds: string[], roleCorrections: string[] = []): FleetDesignOutcome {
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
    unsure: {
      lowConfidenceFunctions: [],
      unreachableDevices: [],
      needsHuman: [],
      roleCorrections: roleCorrections.map((deviceId) => ({ deviceId, currentRole: 'unknown', proposedRole: 'server', evidence: ['SMB shares active'], billingRelevant: true })),
    },
  } as unknown as FleetDesignSubmission;
  return fleetDesignOutcomeFromSubmission(submission, {
    deviceIds: new Set(deviceIds),
    baseline: { alertsPer100EndpointsPerMonth: null, ticketsPerMonth: null, precursors: [] },
    generatedAt: new Date().toISOString(),
  });
}

async function seedDesignRun(orgId: string, deviceIds: string[]) {
  const outcome = outcomeFor(deviceIds, deviceIds);
  const [report] = await getTestDb().insert(reports).values({
    orgId, name: 'Fleet Design', type: 'ai_fleet_design', config: {}, schedule: 'one_time', format: 'pdf', createdBy: null,
  }).returning({ id: reports.id });
  const summary = { fleetDesign: { schemaVersion: outcome.schemaVersion, outcome, runId: null, orgName: 'Fixture', generatedAt: new Date().toISOString() } } as unknown as FleetDesignReportSummary;
  const [run] = await getTestDb().insert(reportRuns).values({
    reportId: report!.id, status: 'completed', startedAt: new Date(), completedAt: new Date(), rowCount: 0, result: { rows: [], rowCount: 0, summary },
  }).returning({ id: reportRuns.id });
  return run!.id;
}

async function seedFleet() {
  const f = await seedPartner(fleetGrants);
  const deviceIds = [await seedDevice(f.org.id, f.site.id), await seedDevice(f.org.id, f.site.id)];
  return { ...f, deviceIds, reportRunId: await seedDesignRun(f.org.id, deviceIds) };
}

const functionsOnly: FleetDesignApproval = { functions: ['file_server'], monitoring: [], retired: [], automation: [], legacy: [], roleCorrections: [], displacementsAccepted: [] };
const monitoringOnly: FleetDesignApproval = { ...functionsOnly, functions: [], monitoring: ['monitoring:file_server:watch:0'] };

const ledgerOf = (reportRunId: string) => getTestDb().select().from(fleetDesignAppliedItems).where(eq(fleetDesignAppliedItems.reportRunId, reportRunId));

const contextOf = (auth: AuthContext) => buildDbAccessContext({ scope: auth.scope, orgId: auth.orgId, accessibleOrgIds: auth.accessibleOrgIds ?? [], partnerId: auth.partnerId, userId: auth.user.id });

/** The first half of a design, applied directly, so the next apply reuses a real group. */
const applyFunctions = (f: Awaited<ReturnType<typeof seedFleet>>) => withDbAccessContext(contextOf(f.auth), () => applyFleetDesign(f.auth, f.reportRunId, functionsOnly));

/** The digest a release would verify, read as the release paths read it. */
const verified = async (input: Record<string, unknown>, intentOrgId: string) => {
  const result = await withSystemDbAccessContext(() => computeEffectDigestForRelease('manage_fleet_designs', input, db, { intentOrgId }));
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

  runDb('role rollback restores this design\'s role, and leaves a later AI correction alone', async () => {
    const f = await seedFleet();
    const [ours, later] = f.deviceIds as [string, string];
    const roleOf = async (id: string) => (await getTestDb().select({ role: devices.deviceRole, source: devices.deviceRoleSource }).from(devices).where(eq(devices.id, id)))[0]!;
    const before = await roleOf(ours);

    const applied = await fileAndRelease(f.auth, 'manage_fleet_designs', applyInput(f.reportRunId, { ...functionsOnly, functions: [], roleCorrections: [ours, later] }), f.approver);
    expect(applied.status, JSON.stringify(applied.result)).toBe('completed');
    await expect(roleOf(ours)).resolves.toEqual({ role: 'server', source: 'ai' });
    const ledger = await ledgerOf(f.reportRunId);
    expect(ledger.every((r) => r.createdRefs?.deviceRole === 'server')).toBe(true);

    // A later design corrected this one again: still source 'ai', but no longer this design's role.
    await getTestDb().update(devices).set({ deviceRole: 'workstation' }).where(eq(devices.id, later));

    const rolled = await fileAndRelease(f.auth, 'manage_fleet_designs', { action: 'rollback', reportRunId: f.reportRunId }, f.approver);
    expect(rolled.status).toBe('failed');
    expect(JSON.stringify(rolled.result)).toContain(`roleCorrections:${later}`);
    await expect(roleOf(ours)).resolves.toEqual({ role: before.role, source: before.source });
    await expect(roleOf(later)).resolves.toEqual({ role: 'workstation', source: 'ai' });
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
    const binding = await verified(args, f.org.id);
    await getTestDb().update(devices).set({ deviceRoleSource: 'manual' }).where(eq(devices.id, f.deviceIds[0]!));
    const out = await runFleet(f.auth, args, binding);
    expect(out.code).toBe('CONTENT_CHANGED');
    await expect(ledgerOf(f.reportRunId)).resolves.toHaveLength(0);
  });

  runDb('CONTROL: with nothing changed the verified digest matches under the caller context, and it applies', async () => {
    const f = await seedFleet();
    const args = input(f.reportRunId);
    const out = await runFleet(f.auth, args, await verified(args, f.org.id));
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
    const binding = await verified(args, f.org.id);
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
    const out = await runFleet(f.auth, args, await verified(args, foreign.org.id));
    expect(out.code).toBe('NOT_FOUND');
    await expect(ledgerOf(foreign.reportRunId)).resolves.toHaveLength(0);
  });

  runDb("another org's design under one partner: no digest for this intent's org, and no intent is filed over it", async () => {
    const f = await seedFleet();
    const sibling = await createOrganization({ partnerId: f.partner.id });
    const siblingRun = await seedDesignRun(sibling.id, f.deviceIds);

    for (const args of [input(siblingRun), { action: 'rollback', reportRunId: siblingRun }]) {
      const here = await withSystemDbAccessContext(() => computeEffectDigestForRelease('manage_fleet_designs', args, db, { intentOrgId: f.org.id }));
      expect(here).toEqual({ digest: null });
      await verified(args, sibling.id);
    }

    await expect(createActionIntent(f.auth, {
      toolName: 'manage_fleet_designs', input: input(siblingRun), source: 'chat', orgId: f.org.id,
    } as never)).rejects.toMatchObject({ code: 'effect_digest_unresolvable' });
    const filed = await getTestDb().select({ id: actionIntents.id }).from(actionIntents).where(eq(actionIntents.orgId, f.org.id));
    expect(filed).toEqual([]);
  });

  runDb('a partner-owned report of the Fleet Design type has no digest for any org', async () => {
    const f = await seedFleet();
    const [report] = await getTestDb().insert(reports).values({
      orgId: null, partnerId: f.partner.id, name: 'Fleet Design', type: 'ai_fleet_design', config: {}, schedule: 'one_time', format: 'pdf', createdBy: null,
    }).returning({ id: reports.id });
    const [run] = await getTestDb().insert(reportRuns).values({
      reportId: report!.id, status: 'completed', startedAt: new Date(), completedAt: new Date(), rowCount: 0, result: { rows: [], rowCount: 0 },
    }).returning({ id: reportRuns.id });

    const result = await withSystemDbAccessContext(() => computeEffectDigestForRelease('manage_fleet_designs', { action: 'rollback', reportRunId: run!.id }, db, { intentOrgId: f.org.id }));
    expect(result).toEqual({ digest: null });
  });

  runDb('a preview reads the design under the caller context, with no approval', async () => {
    const f = await seedFleet();
    const preview = await runFleet(f.auth, { action: 'preview', reportRunId: f.reportRunId, approval: functionsOnly });
    expect(preview.functions[0]).toMatchObject({ functionKey: 'file_server', deviceCount: 2 });
  });
});
