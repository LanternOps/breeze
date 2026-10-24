/**
 * The identity_offboarding real-Postgres harness, shared by the R1c release
 * gate (`aiOperatorIdentityGate.integration.test.ts`, wave #6171).
 *
 * Copied from R1a's `aiOperatorIdentityOffboardingE2E.integration.test.ts`,
 * which stays byte-for-byte unchanged (deviation G7: duplication accepted so
 * R1a's evidence file is never edited). Not a test file (no `.test.ts`
 * suffix), so no runner collects it.
 *
 * The provider fakes cannot live here: `vi.mock` factories are hoisted into
 * each test file, so the gate suite declares the same provider mocks over a
 * `vi.hoisted` state object and hands that object to this module with
 * `bindFakeProviders` before any test runs.
 *
 * Differences from the R1a copy, each deliberate:
 *  - `walkEffects` keeps the one-dispatch-per-wake and prefix checks but does
 *    NOT assert the mail-before-lockout ordering: that property is the gate's
 *    own assertion, and keeping a second copy here would let the gate's
 *    mutation proof fail in the harness instead of in the assertion under test.
 *  - `seedTenant` takes an optional frozen-snapshot allowlist.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import { M365_PERMISSION_PROFILES } from '@breeze/shared/m365';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  actionIntents,
  aiAgentRuns,
  aiAgents,
  aiOperatorOperations,
  aiOperatorPlanApprovalEffects,
  aiOperatorPlanApprovals,
  aiOperatorTasks,
  aiOperatorTaskSteps,
  contactExternalLinks,
  contacts,
  googleWorkspaceConnections,
  m365Connections,
} from '../../db/schema';
import { callerVerificationPolicies } from '../../db/schema/callerVerification';
import { PERMISSIONS } from '../../services/permissions';
import { admitTask } from '../../services/aiOperator/taskService';
import { handleTaskWake } from '../../services/aiOperator/taskCoordinator';
import { transitionIntent } from '../../services/actionIntents/intentService';
import { planEffectOperationKey } from '../../services/aiOperator/planApproval';
import { IDENTITY_OFFBOARDING_EFFECT_TOOLS } from '../../services/aiOperator/recipes/identityOffboarding';
import { patchChecklistItem } from '../../services/ticketChecklistService';
import { approveRealWay, type PlanTenant } from './planApprovalFixtures';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';

export const CATALOG: readonly string[] = [...IDENTITY_OFFBOARDING_EFFECT_TOOLS];
export const STEP = 'effects';

export const system = <T>(fn: () => Promise<T>): Promise<T> => runOutsideDbContext(() => withSystemDbAccessContext(fn));

// ---------------------------------------------------------------------------
// The scripted provider tenant (state owned by the test file's vi.hoisted)
// ---------------------------------------------------------------------------

export interface GoogleGroup { id: string; email: string; name: string; role: 'OWNER' | 'MEMBER' }
export interface GoogleLicense { productId: string; skuId: string; name: string }
export interface M365Group { id: string; name: string; groupTypes: string[] }
export interface FakeWorld {
  google: { id: string; email: string; suspended: boolean; groups: GoogleGroup[]; licenses: GoogleLicense[] };
  m365: { id: string; upn: string; enabled: boolean; licenses: string[]; allGroups: M365Group[]; memberOf: string[] };
}
export interface FakeProviders {
  world: FakeWorld;
  googleConnId: string | null;
  m365Calls: number;
}

let fake: FakeProviders | null = null;

/** Hand the test file's hoisted provider state to the harness. Call once, at module scope. */
export function bindFakeProviders(f: FakeProviders): void {
  fake = f;
}

function providers(): FakeProviders {
  if (!fake) throw new Error('identityOffboardingHarness: bindFakeProviders() was not called');
  return fake;
}

export function freshWorld(): FakeWorld {
  return {
    google: {
      id: 'g-dana-101', email: 'dana@customer.example', suspended: false,
      groups: [{ id: 'gg-sales', email: 'sales@customer.example', name: 'Sales', role: 'MEMBER' }],
      licenses: [{ productId: 'Google-Apps', skuId: '1010020027', name: 'Workspace Business Starter' }],
    },
    m365: {
      id: '7f0e8c1a-3b2d-4c5e-9a61-0d2f4b6c8e01', upn: 'dana@customer.example', enabled: true,
      licenses: ['c42b9cae-ea4f-4ab7-9717-81576235ccac'],
      allGroups: [
        { id: 'a1b2c3d4-0000-4000-8000-00000000a001', name: 'All Staff', groupTypes: ['Unified'] },
        { id: 'a1b2c3d4-0000-4000-8000-00000000a002', name: 'Finance', groupTypes: [] },
      ],
      memberOf: ['a1b2c3d4-0000-4000-8000-00000000a001'],
    },
  };
}

export async function cleanWorld(): Promise<void> {
  const w = providers().world;
  w.google.groups = [];
  w.google.licenses = [];
  w.google.suspended = true;
  w.m365.memberOf = [];
  w.m365.licenses = [];
  w.m365.enabled = false;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export interface Tenant {
  partnerId: string;
  orgId: string;
  siteId: string;
  requesterId: string;
  requesterName: string;
  requesterOrgUserId: string;
  approverId: string;
  approverName: string;
  agentId: string;
  contactId: string;
  m365ConnId: string;
  googleConnId: string;
}

async function userWithRole(partnerId: string, orgId: string, name: string) {
  const role = await createRole({ scope: 'organization', orgId });
  await grantRolePermissions(role.id, [PERMISSIONS.APPROVALS_DECIDE, PERMISSIONS.ORGS_WRITE, PERMISSIONS.ORGS_READ]);
  const user = await createUser({
    partnerId, orgId, name, email: `${name.split(' ')[0]!.toLowerCase()}-${randomUUID().slice(0, 8)}@msp.example`,
  });
  const membership = await assignUserToOrganization(user.id, orgId, role.id);
  return { user, orgUserId: (membership as { id: string }).id };
}

/**
 * Every app role the actions profile declares, in the CANONICAL order the
 * `m365_connections_observed_grants_check` constraint requires.
 */
export function allActionGrants() {
  const key = (g: { resourceApplicationId: string; appRoleId: string }) => `${g.resourceApplicationId}/${g.appRoleId}`;
  return [...(M365_PERMISSION_PROFILES['customer-graph-actions'].applicationPermissionAssignments ?? [])]
    .sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
}

export async function seedTenant(opts: {
  observedGrants?: ReturnType<typeof allActionGrants>;
  /**
   * The partner's caller-verification tier for `disable_user`. Default 0: the
   * only configuration under which `m365_disable_user` can be minted from a
   * plan today. `null` = no policy row, i.e. the product default (tier 2).
   */
  disableUserTier?: number | null;
} = {}): Promise<Tenant> {
  const f = providers();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const requester = await userWithRole(partner.id, org.id, 'Rita Requester');
  const approver = await userWithRole(partner.id, org.id, 'Avery Approver');

  const seeded = await system(async () => {
    const [agent] = await db.insert(aiAgents).values({
      partnerId: partner.id, orgId: null, kind: 'helpdesk', name: 'Helpdesk Operator',
      enabled: true, mode: 'shadow', toolAllowlist: [...CATALOG],
      protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
      limits: { maxConcurrentRuns: 5, maxRunsPerHour: 50, maxBudgetCentsPerDay: 1000 },
      triggers: { alertSeverities: ['critical', 'high'], respectMaintenanceWindows: false },
      recipients: { userIds: [], roleIds: [] }, cooldownSeconds: 0, createdBy: requester.user.id,
    }).returning({ id: aiAgents.id });
    const profile = M365_PERMISSION_PROFILES['customer-graph-actions'];
    const [m365] = await db.insert(m365Connections).values({
      orgId: org.id, tenantId: randomUUID(), clientId: 'test-client-id',
      profile: 'customer-graph-actions', authMode: 'application-certificate',
      credentialDomain: 'customer-graph-actions',
      vaultRef: 'akv://test-vault.example/m365-customer-graph-actions/00000000000000000000000000000000',
      credentialVersion: '00000000000000000000000000000000',
      permissionManifestVersion: profile.version, status: 'active',
      observedGrants: opts.observedGrants ?? allActionGrants(), grantsVerifiedAt: new Date(),
    } as never).returning({ id: m365Connections.id });
    const [google] = await db.insert(googleWorkspaceConnections).values({
      orgId: org.id, customerDomain: 'customer.example', adminEmail: 'admin@customer.example',
      serviceAccountEmail: 'svc@customer.example', serviceAccountKey: 'unused-the-client-is-faked', status: 'active',
    } as never).returning({ id: googleWorkspaceConnections.id });
    const [contact] = await db.insert(contacts).values({
      orgId: org.id, name: 'Dana Example', email: f.world.google.email,
    }).returning({ id: contacts.id });
    await db.insert(contactExternalLinks).values([
      { orgId: org.id, contactId: contact!.id, system: 'm365', externalId: f.world.m365.id },
      { orgId: org.id, contactId: contact!.id, system: 'google', externalId: f.world.google.id },
    ]);
    const tier = opts.disableUserTier === undefined ? 0 : opts.disableUserTier;
    if (tier !== null) {
      await db.insert(callerVerificationPolicies).values({ partnerId: partner.id, orgId: null, requiredTierDisableUser: tier });
    }
    return { agentId: agent!.id, m365ConnId: m365!.id, googleConnId: google!.id, contactId: contact!.id };
  });
  f.googleConnId = seeded.googleConnId;
  return {
    partnerId: partner.id, orgId: org.id, siteId: site.id,
    requesterId: requester.user.id, requesterName: 'Rita Requester', requesterOrgUserId: requester.orgUserId,
    approverId: approver.user.id, approverName: 'Avery Approver',
    ...seeded,
  };
}

export function policySnapshot(agentId: string, toolAllowlist: readonly string[] = CATALOG) {
  return {
    schemaVersion: 1, agentId, kind: 'helpdesk',
    effective: {
      enabled: true, mode: 'shadow', model: null, toolAllowlist: [...toolAllowlist],
      protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
      limits: {}, triggers: {}, recipients: { userIds: [], roleIds: [] }, instructions: null, cooldownSeconds: 0,
    },
    resolvedAt: new Date().toISOString(),
  };
}

/** The fake model: a completed run for `stepKey` whose outcome is its submitted task step. */
export async function insertCompletedRun(t: Tenant, taskId: string, stepKey: 'intake' | 'review', nextStep: Record<string, unknown>) {
  const now = new Date();
  await system(() => db.insert(aiAgentRuns).values({
    agentId: t.agentId, orgId: t.orgId, deviceId: null,
    triggerKind: 'manual' as const, dedupeKey: `operator-task:${taskId}:${stepKey}:0`,
    modeAtStart: 'shadow' as const, policySnapshot: policySnapshot(t.agentId) as never,
    status: 'completed' as const, startedAt: now, finishedAt: now,
    taskId, taskStepKey: stepKey, taskAttemptOrdinal: 0, promptVersion: 'identity_offboarding/v1',
    outcome: {
      taskStep: {
        version: 1,
        findings: [{ text: `${stepKey} looked at the request`, sourceKind: 'other', sourceId: stepKey, observedAt: now.toISOString() }],
        nextStep,
      },
    } as never,
  } as never));
}

// ---------------------------------------------------------------------------
// Driving a task
// ---------------------------------------------------------------------------

export interface Admitted { t: Tenant; taskId: string; cutoffAt: string }

export async function admit(t: Tenant, over: Record<string, unknown> = {}): Promise<Admitted> {
  const cutoffAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const res = await admitTask({
    orgId: t.orgId, agentId: t.agentId, objective: 'Offboard Dana Example',
    originKind: 'manual', requesterUserId: t.requesterId,
    workflowKey: 'identity_offboarding', workflowVersion: 1,
    recipeInput: { contactId: t.contactId, forwardTo: 'manager@customer.example', cutoffAt, ...over },
  });
  if (!res.ok) throw new Error(`admitTask refused: ${res.refusal} (${res.detail})`);
  await insertCompletedRun(t, res.taskId, 'intake', {
    kind: 'step', key: 'confirm_identity',
    inputs: { candidateContactIds: [t.contactId], ambiguous: false, rationale: 'The named contact matches both directory accounts.' },
  });
  await insertCompletedRun(t, res.taskId, 'review', {
    kind: 'step', key: 'effects',
    inputs: { flags: [], exceptions: [], summary: 'The plan matches the request; nothing unusual was found.' },
  });
  return { t, taskId: res.taskId, cutoffAt };
}

export const wake = (a: Admitted) => handleTaskWake({ orgId: a.t.orgId, taskId: a.taskId, sourceKind: 'test', sourceId: a.taskId });

export async function readTask(a: Admitted) {
  const [row] = await system(() => db.select().from(aiOperatorTasks).where(eq(aiOperatorTasks.id, a.taskId)));
  return row!;
}

export async function readSteps(a: Admitted, stepKey: string) {
  return system(() => db.select().from(aiOperatorTaskSteps)
    .where(and(eq(aiOperatorTaskSteps.taskId, a.taskId), eq(aiOperatorTaskSteps.stepKey, stepKey)))
    .orderBy(asc(aiOperatorTaskSteps.attemptOrdinal)));
}

export const operations = (a: Admitted) =>
  system(() => db.select().from(aiOperatorOperations).where(eq(aiOperatorOperations.taskId, a.taskId)));
export const childIntents = (a: Admitted) =>
  system(() => db.select().from(actionIntents).where(eq(actionIntents.taskId, a.taskId)));
export const planIntents = (a: Admitted) =>
  system(() => db.select().from(actionIntents)
    .where(and(eq(actionIntents.orgId, a.t.orgId), eq(actionIntents.actionName, 'operator_plan'))));
export const approvals = (a: Admitted) =>
  system(() => db.select().from(aiOperatorPlanApprovals).where(eq(aiOperatorPlanApprovals.taskId, a.taskId)));
export const approvalEffects = (a: Admitted) =>
  system(() => db.select().from(aiOperatorPlanApprovalEffects)
    .where(eq(aiOperatorPlanApprovalEffects.taskId, a.taskId))
    .orderBy(asc(aiOperatorPlanApprovalEffects.ordinal)));

export function tenantCtx(t: Tenant, userId: string): DbAccessContext {
  return {
    scope: 'organization', orgId: t.orgId, accessibleOrgIds: [t.orgId],
    accessiblePartnerIds: [t.partnerId], userId,
  } as DbAccessContext;
}

/** A real tick: the request-path patch that writes done_at and the outbox row. */
export async function tickAs(t: Tenant, userId: string, itemId: string) {
  await withDbAccessContext(tenantCtx(t, userId), () => patchChecklistItem(itemId, { done: true }, { userId }));
}

export interface PlanKey { key: string; toolName: string; ordinal: number; provider: string }

/** The plan's operation keys, in plan order, from the SEALED approval rows. */
export async function planKeys(a: Admitted): Promise<PlanKey[]> {
  return (await approvalEffects(a)).map((e) => ({
    key: planEffectOperationKey({ stepKey: STEP, planRevision: e.planRevision, toolName: e.toolName, targetId: e.targetId, ordinal: e.ordinal }),
    toolName: e.toolName, ordinal: e.ordinal, provider: e.provider,
  }));
}

/** Simulate the release of every in-flight child effect. */
export async function releaseInFlight(a: Admitted): Promise<number> {
  const pending = (await operations(a)).filter((o) => o.resultState === 'pending' && o.intentId);
  for (const op of pending) {
    await system(() => db.update(aiOperatorOperations)
      .set({ resultState: 'succeeded', resultAt: new Date(), dispatchedAt: new Date() })
      .where(eq(aiOperatorOperations.id, op.id)));
    await transitionIntent(op.intentId!, ['approved', 'executing'], 'completed', { executedAt: new Date() });
  }
  return pending.length;
}

export async function openWindow(a: Admitted): Promise<void> {
  const past = new Date(Date.now() - 60_000).toISOString();
  await system(() => db.execute(sql`
    UPDATE ai_operator_tasks
       SET checkpoint = jsonb_set(checkpoint, '{dispatchNotBefore}', to_jsonb(${past}::text)),
           next_wake_at = now()
     WHERE id = ${a.taskId}`));
}

/** Admit and drive to the confirm_identity item; tick it; discover; review; propose. */
export async function driveToProposed(t: Tenant, over: Record<string, unknown> = {}): Promise<Admitted> {
  const a = await admit(t, over);
  await wake(a); // intake
  await wake(a); // confirm_identity opens the item
  const [confirm] = await readSteps(a, 'confirm_identity');
  await tickAs(t, t.requesterId, confirm!.checklistItemId!);
  await wake(a); // confirm_identity done -> discover
  await wake(a); // discover -> review
  await wake(a); // review -> effects
  await wake(a); // effects proposes the plan
  const task = await readTask(a);
  expect(task.waitReason, `task should be waiting on the plan approval (${task.state}/${task.outcomeDetail})`).toBe('approval');
  return a;
}

/** The plan's approver as a PlanTenant view, for the shared approval fixtures. */
export function asPlanTenant(t: Tenant, approverId: string = t.approverId): PlanTenant {
  return { orgId: t.orgId, partnerId: t.partnerId, aId: t.requesterId, bId: approverId } as unknown as PlanTenant;
}

export async function approve(a: Admitted): Promise<void> {
  const [plan] = await planIntents(a);
  await approveRealWay(asPlanTenant(a.t), plan!.id);
}

/** Approved, and the first post-approval wake held the walk at the cutoff. */
export async function driveToApprovedAndHeld(t: Tenant, over: Record<string, unknown> = {}): Promise<Admitted> {
  const a = await driveToProposed(t, over);
  await approve(a);
  await wake(a);
  const held = await readTask(a);
  expect(held.waitReason).toBe('maintenance_window');
  return a;
}

/**
 * Walk the effects step one wake at a time until `stopAfterOps` operations
 * exist (or the step ends), releasing each child as it is minted. Asserts after
 * EVERY wake: exactly one new dispatch, and the operation set is a prefix of
 * the plan. Returns the number of effects wakes.
 */
export async function walkEffects(a: Admitted, opts: { stopAfterOps?: number } = {}): Promise<number> {
  const plan = await planKeys(a);
  let wakes = 0;
  for (let guard = 0; guard < 40; guard += 1) {
    const before = await readTask(a);
    if (before.currentStepKey !== STEP || !['waiting', 'running', 'queued'].includes(before.state)) break;
    const opsBefore = (await operations(a)).length;
    if (opts.stopAfterOps !== undefined && opsBefore >= opts.stopAfterOps) break;
    await wake(a);
    wakes += 1;
    const ops = await operations(a);
    const after = await readTask(a);
    if (after.currentStepKey === STEP && after.state === 'waiting') {
      expect(ops.length, `wake ${wakes}: exactly one new operation`).toBe(opsBefore + 1);
    } else {
      expect(ops.length, `wake ${wakes}: the final wake dispatches nothing`).toBe(opsBefore);
    }
    expect(ops.map((o) => o.operationKey).sort(), `wake ${wakes}: operations are a prefix of the plan`)
      .toEqual(plan.slice(0, ops.length).map((p) => p.key).sort());
    await releaseInFlight(a);
  }
  return wakes;
}
