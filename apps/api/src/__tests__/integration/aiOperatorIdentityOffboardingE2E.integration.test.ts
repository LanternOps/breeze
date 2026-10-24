/**
 * identity_offboarding, end to end against real Postgres (Recipe Library W06
 * R1a, #6171).
 *
 * WHAT IS REAL: every ai_operator_* table, contacts and their external links,
 * tickets and checklist items, action intents, plan approvals (decided and
 * released the real way), the coordinator and its lease CAS, every identity
 * advancer, `admitTask`, readiness (computed from real connection rows and the
 * real effective helpdesk agent), the requester gate, the ticket mover and the
 * org-merge service. Runs as `breeze_app` via ./setup.
 *
 * WHAT IS FAKED, and only this:
 *  - THE MODEL: completed `ai_agent_runs` rows for `intake` and `review`,
 *    inserted right after admission. The coordinator reads those rows; it never
 *    sees a model. Their policy snapshot carries the full effect catalog, which
 *    is the task's FROZEN allowlist (earliest task-linked run).
 *  - THE PROVIDERS' READS: `executeM365ReadActionByOrg`, and the Google
 *    `resolveContextByOrg` / `getDirectoryClient` / `getLicensingClient`, all
 *    answering from the mutable `fake.world` below, so admission, discovery and
 *    the verify step's residual re-read all see one scripted tenant.
 *    Admission finds both accounts through real `contact_external_links` rows
 *    (no provider lookup by address).
 *  - THE EFFECT PROBES: registry stubs. Pre-probe `unsatisfied`, post-probe
 *    `satisfied`; `google_signout` is registered `alwaysUnknown` and answers
 *    `unknown`. A child effect's "release" is simulated the way the replay
 *    suite does it: its operation row is stamped succeeded + dispatchedAt and
 *    its intent completed.
 */
import './setup';
import { getTestDb } from './setup';

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// The scripted provider tenant (hoisted: the mock factories close over it)
// ---------------------------------------------------------------------------

const fake = vi.hoisted(() => {
  interface GoogleGroup { id: string; email: string; name: string; role: 'OWNER' | 'MEMBER' }
  interface GoogleLicense { productId: string; skuId: string; name: string }
  interface M365Group { id: string; name: string; groupTypes: string[] }
  interface World {
    google: { id: string; email: string; suspended: boolean; groups: GoogleGroup[]; licenses: GoogleLicense[] };
    m365: { id: string; upn: string; enabled: boolean; licenses: string[]; allGroups: M365Group[]; memberOf: string[] };
  }
  return {
    world: null as unknown as World,
    googleConnId: null as string | null,
    /** Per-tool probe overrides, by phase. */
    probe: {} as Record<string, { pre?: 'satisfied' | 'unsatisfied' | 'unknown'; post?: 'satisfied' | 'unsatisfied' | 'unknown' }>,
    m365Calls: 0,
  };
});

function freshWorld(): typeof fake.world {
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

vi.mock('../../services/m365ControlPlane/readActionService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The Graph user lookup the caller-verification gate makes when an
  // `m365_disable_user` intent is minted (intentService.ts ~2070 ->
  // aiToolsM365.resolveM365CallerTarget). A provider read like the others.
  executeM365UserLookupForCallerTarget: async (_orgId: string, identifier: string) => {
    fake.m365Calls += 1;
    const w = fake.world.m365;
    if (identifier !== w.id && identifier !== w.upn) return { ok: false, code: 'graph_not_found', message: 'not found' };
    return { ok: true, kind: 'resource', resource: { id: w.id, userPrincipalName: w.upn, accountEnabled: w.enabled } };
  },
  executeM365ReadActionByOrg: async (_orgId: string, action: { type: string; userIdOrUpn?: string; groupId?: string; userId?: string }) => {
    fake.m365Calls += 1;
    const w = fake.world.m365;
    switch (action.type) {
      case 'm365.user.get':
        if (action.userIdOrUpn === w.id || action.userIdOrUpn === w.upn) {
          return {
            ok: true, kind: 'resource',
            resource: {
              id: w.id, userPrincipalName: w.upn, mail: w.upn, accountEnabled: w.enabled,
              assignedLicenses: w.licenses.map((skuId) => ({ skuId })),
            },
          };
        }
        return { ok: false, code: 'graph_not_found', message: 'not found' };
      case 'm365.org.skus.list':
        return { ok: true, kind: 'collection', truncated: false, items: w.licenses.map((s) => ({ skuId: s, skuPartNumber: 'SPE_E3' })) };
      case 'm365.group.list':
        return {
          ok: true, kind: 'collection', truncated: false,
          items: w.allGroups.map((g) => ({ id: g.id, displayName: g.name, mail: null, groupTypes: g.groupTypes })),
        };
      case 'm365.group.member.get':
        return {
          ok: true, kind: 'collection', truncated: false,
          items: w.memberOf.includes(action.groupId ?? '') ? [{ id: action.userId }] : [],
        };
      case 'm365.intune.device.list':
        return { ok: true, kind: 'collection', truncated: false, items: [] };
      default:
        return { ok: false, code: 'unsupported_in_test', message: `unscripted read ${action.type}` };
    }
  },
}));

vi.mock('../../services/aiToolsGoogle', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveContextByOrg: async (orgId: string) => (fake.googleConnId
    ? { conn: { id: fake.googleConnId, orgId, adminEmail: 'admin@customer.example' }, keyJson: '{}' }
    : { error: 'no_google_connection' }),
}));

vi.mock('../../services/googleClient', async (importOriginal) => {
  const notFound = () => Object.assign(new Error('Resource Not Found'), { code: 404 });
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    getDirectoryClient: () => ({
      users: {
        get: async ({ userKey }: { userKey: string }) => {
          const g = fake.world.google;
          if (userKey !== g.id && userKey !== g.email) throw notFound();
          return { data: { id: g.id, primaryEmail: g.email, suspended: g.suspended } };
        },
      },
      groups: {
        list: async () => ({ data: { groups: fake.world.google.groups.map((x) => ({ id: x.id, email: x.email, name: x.name })) } }),
      },
      members: {
        get: async ({ groupKey }: { groupKey: string }) =>
          ({ data: { role: fake.world.google.groups.find((x) => x.email === groupKey)?.role ?? 'MEMBER' } }),
        list: async () => ({ data: { members: [{ email: 'owner2@customer.example' }] } }),
      },
      mobiledevices: { list: async () => ({ data: { mobiledevices: [] } }) },
    }),
    getLicensingClient: () => ({
      licenseAssignments: {
        listForProduct: async ({ productId }: { productId: string }) => ({
          data: {
            items: fake.world.google.licenses.filter((l) => l.productId === productId)
              .map((l) => ({ userId: fake.world.google.email, productId: l.productId, skuId: l.skuId, skuName: l.name })),
          },
        }),
      },
    }),
  };
});

// The requester gates, wrapped so every call is observable and still REAL.
const gate = vi.hoisted(() => ({ forTargets: vi.fn(), device: vi.fn() }));
vi.mock('../../services/aiOperator/requesterAccessGate', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../services/aiOperator/requesterAccessGate')>();
  return {
    ...real,
    requesterAccessLostForTargets: (...args: Parameters<typeof real.requesterAccessLostForTargets>) => {
      gate.forTargets(...args);
      return real.requesterAccessLostForTargets(...args);
    },
    requesterAccessLost: (...args: Parameters<typeof real.requesterAccessLost>) => {
      gate.device(...args);
      return real.requesterAccessLost(...args);
    },
  };
});

import { M365_PERMISSION_PROFILES } from '@breeze/shared/m365';
import { taskCheckpointSchema } from '@breeze/shared';
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
  aiOperatorTaskTargetAccounts,
  aiOperatorTaskTargets,
  contactExternalLinks,
  contacts,
  googleWorkspaceConnections,
  m365Connections,
  organizationUsers,
  ticketChecklistItems,
  ticketComments,
} from '../../db/schema';
import { callerVerificationPolicies } from '../../db/schema/callerVerification';
import { PERMISSIONS } from '../../services/permissions';
import { admitTask } from '../../services/aiOperator/taskService';
import { handleTaskWake } from '../../services/aiOperator/taskCoordinator';
import { transitionIntent } from '../../services/actionIntents/intentService';
import { __resetEffectProbesForTest, registerEffectProbe } from '../../services/aiOperator/effectProbes';
import { planEffectOperationKey } from '../../services/aiOperator/planApproval';
import { loadPlanningFacts } from '../../services/aiOperator/planningSnapshot';
import {
  IDENTITY_OFFBOARDING_EFFECT_TOOLS,
  buildIdentityOffboardingManualWork,
  identityOffboardingRecipe,
} from '../../services/aiOperator/recipes/identityOffboarding';
import { patchChecklistItem } from '../../services/ticketChecklistService';
import { moveTicketOrg } from '../../services/ticketService';
import { executeOrgMerge } from '../../services/orgMerge';
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

const runDb = it.runIf(!!process.env.DATABASE_URL);
const skipDb = it.skip;

const CATALOG = [...IDENTITY_OFFBOARDING_EFFECT_TOOLS];
const STEP = 'effects';
const MAIL_ROUTING: Record<'google' | 'm365', string[]> = {
  google: ['google_set_vacation', 'google_set_forwarding', 'google_add_mail_delegate'],
  m365: ['m365_set_auto_reply'],
};
const DISABLE: Record<'google' | 'm365', string> = { google: 'google_suspend_user', m365: 'm365_disable_user' };

const system = <T>(fn: () => Promise<T>): Promise<T> => runOutsideDbContext(() => withSystemDbAccessContext(fn));

function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.cause?.code ?? e?.code;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

interface Tenant {
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
 * `m365_connections_observed_grants_check` constraint requires (by
 * resourceApplicationId, then appRoleId, byte order).
 */
function allActionGrants() {
  const key = (g: { resourceApplicationId: string; appRoleId: string }) => `${g.resourceApplicationId}/${g.appRoleId}`;
  return [...(M365_PERMISSION_PROFILES['customer-graph-actions'].applicationPermissionAssignments ?? [])]
    .sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
}

async function seedTenant(opts: {
  observedGrants?: ReturnType<typeof allActionGrants>;
  /**
   * The partner's caller-verification tier for `disable_user`. Default 0: this
   * MSP does not require a verified caller to disable an account, which is the
   * only configuration under which `m365_disable_user` can be minted from a
   * plan today (see the BUG case at the bottom). `null` = no policy row, i.e.
   * the product default (tier 2).
   */
  disableUserTier?: number | null;
} = {}): Promise<Tenant> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const requester = await userWithRole(partner.id, org.id, 'Rita Requester');
  const approver = await userWithRole(partner.id, org.id, 'Avery Approver');

  const seeded = await system(async () => {
    const [agent] = await db.insert(aiAgents).values({
      partnerId: partner.id, orgId: null, kind: 'helpdesk', name: 'Helpdesk Operator',
      enabled: true, mode: 'shadow', toolAllowlist: CATALOG,
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
      orgId: org.id, name: 'Dana Example', email: fake.world.google.email,
    }).returning({ id: contacts.id });
    await db.insert(contactExternalLinks).values([
      { orgId: org.id, contactId: contact!.id, system: 'm365', externalId: fake.world.m365.id },
      { orgId: org.id, contactId: contact!.id, system: 'google', externalId: fake.world.google.id },
    ]);
    const tier = opts.disableUserTier === undefined ? 0 : opts.disableUserTier;
    if (tier !== null) {
      await db.insert(callerVerificationPolicies).values({ partnerId: partner.id, orgId: null, requiredTierDisableUser: tier });
    }
    return { agentId: agent!.id, m365ConnId: m365!.id, googleConnId: google!.id, contactId: contact!.id };
  });
  fake.googleConnId = seeded.googleConnId;
  return {
    partnerId: partner.id, orgId: org.id, siteId: site.id,
    requesterId: requester.user.id, requesterName: 'Rita Requester', requesterOrgUserId: requester.orgUserId,
    approverId: approver.user.id, approverName: 'Avery Approver',
    ...seeded,
  };
}

function policySnapshot(agentId: string) {
  return {
    schemaVersion: 1, agentId, kind: 'helpdesk',
    effective: {
      enabled: true, mode: 'shadow', model: null, toolAllowlist: CATALOG,
      protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
      limits: {}, triggers: {}, recipients: { userIds: [], roleIds: [] }, instructions: null, cooldownSeconds: 0,
    },
    resolvedAt: new Date().toISOString(),
  };
}

/** The fake model: a completed run for `stepKey` whose outcome is its submitted task step. */
async function insertCompletedRun(t: Tenant, taskId: string, stepKey: 'intake' | 'review', nextStep: Record<string, unknown>) {
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
// The harness
// ---------------------------------------------------------------------------

interface Admitted { t: Tenant; taskId: string; cutoffAt: string }

async function admit(t: Tenant, over: Record<string, unknown> = {}): Promise<Admitted> {
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

const wake = (a: Admitted) => handleTaskWake({ orgId: a.t.orgId, taskId: a.taskId, sourceKind: 'test', sourceId: a.taskId });

async function readTask(a: Admitted) {
  const [row] = await system(() => db.select().from(aiOperatorTasks).where(eq(aiOperatorTasks.id, a.taskId)));
  return row!;
}

async function readSteps(a: Admitted, stepKey: string) {
  return system(() => db.select().from(aiOperatorTaskSteps)
    .where(and(eq(aiOperatorTaskSteps.taskId, a.taskId), eq(aiOperatorTaskSteps.stepKey, stepKey)))
    .orderBy(asc(aiOperatorTaskSteps.attemptOrdinal)));
}

const operations = (a: Admitted) =>
  system(() => db.select().from(aiOperatorOperations).where(eq(aiOperatorOperations.taskId, a.taskId)));
const childIntents = (a: Admitted) =>
  system(() => db.select().from(actionIntents).where(eq(actionIntents.taskId, a.taskId)));
const planIntents = (a: Admitted) =>
  system(() => db.select().from(actionIntents)
    .where(and(eq(actionIntents.orgId, a.t.orgId), eq(actionIntents.actionName, 'operator_plan'))));
const approvals = (a: Admitted) =>
  system(() => db.select().from(aiOperatorPlanApprovals).where(eq(aiOperatorPlanApprovals.taskId, a.taskId)));
const approvalEffects = (a: Admitted) =>
  system(() => db.select().from(aiOperatorPlanApprovalEffects)
    .where(eq(aiOperatorPlanApprovalEffects.taskId, a.taskId))
    .orderBy(asc(aiOperatorPlanApprovalEffects.ordinal)));

function tenantCtx(t: Tenant, userId: string): DbAccessContext {
  return {
    scope: 'organization', orgId: t.orgId, accessibleOrgIds: [t.orgId],
    accessiblePartnerIds: [t.partnerId], userId,
  } as DbAccessContext;
}

/** A real tick: the request-path patch that writes done_at and the outbox row. */
async function tickAs(t: Tenant, userId: string, itemId: string) {
  await withDbAccessContext(tenantCtx(t, userId), () => patchChecklistItem(itemId, { done: true }, { userId }));
}

async function taskTicketId(a: Admitted): Promise<string> {
  const [row] = await system(() => db.select({ ticketId: aiOperatorTaskTargets.ticketId }).from(aiOperatorTaskTargets)
    .where(and(eq(aiOperatorTaskTargets.taskId, a.taskId), eq(aiOperatorTaskTargets.targetKind, 'ticket'))));
  return row!.ticketId!;
}

/** The plan's operation keys, in plan order, from the SEALED approval rows. */
async function planKeys(a: Admitted): Promise<Array<{ key: string; toolName: string; ordinal: number; provider: string }>> {
  return (await approvalEffects(a)).map((e) => ({
    key: planEffectOperationKey({ stepKey: STEP, planRevision: e.planRevision, toolName: e.toolName, targetId: e.targetId, ordinal: e.ordinal }),
    toolName: e.toolName, ordinal: e.ordinal, provider: e.provider,
  }));
}

/** Simulate the release of the newest in-flight child effect. */
async function releaseInFlight(a: Admitted): Promise<number> {
  const pending = (await operations(a)).filter((o) => o.resultState === 'pending' && o.intentId);
  for (const op of pending) {
    await system(() => db.update(aiOperatorOperations)
      .set({ resultState: 'succeeded', resultAt: new Date(), dispatchedAt: new Date() })
      .where(eq(aiOperatorOperations.id, op.id)));
    await transitionIntent(op.intentId!, ['approved', 'executing'], 'completed', { executedAt: new Date() });
  }
  return pending.length;
}

async function openWindow(a: Admitted): Promise<void> {
  const past = new Date(Date.now() - 60_000).toISOString();
  await system(() => db.execute(sql`
    UPDATE ai_operator_tasks
       SET checkpoint = jsonb_set(checkpoint, '{dispatchNotBefore}', to_jsonb(${past}::text)),
           next_wake_at = now()
     WHERE id = ${a.taskId}`));
}

/** Admit and drive to the confirm_identity item; tick it; discover; review; propose. */
async function driveToProposed(t: Tenant, over: Record<string, unknown> = {}): Promise<Admitted> {
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

async function approve(a: Admitted): Promise<void> {
  const [plan] = await planIntents(a);
  await approveRealWay(
    { orgId: a.t.orgId, partnerId: a.t.partnerId, bId: a.t.approverId } as unknown as PlanTenant,
    plan!.id,
  );
}

/** Approved, and the first post-approval wake held the walk at the cutoff. */
async function driveToApprovedAndHeld(t: Tenant, over: Record<string, unknown> = {}): Promise<Admitted> {
  const a = await driveToProposed(t, over);
  await approve(a);
  await wake(a);
  const held = await readTask(a);
  expect(held.waitReason).toBe('maintenance_window');
  return a;
}

/**
 * Walk the effects step to its end, one wake at a time, asserting the ordering
 * contract after EVERY wake. Returns the number of effects wakes.
 */
async function walkEffects(a: Admitted, opts: { stopAfterOps?: number } = {}): Promise<number> {
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
    // ONE new dispatch per wake, unless this wake left the step.
    if (after.currentStepKey === STEP && after.state === 'waiting') {
      expect(ops.length, `wake ${wakes}: exactly one new operation`).toBe(opsBefore + 1);
    } else {
      expect(ops.length, `wake ${wakes}: the final wake dispatches nothing`).toBe(opsBefore);
    }
    // The set of operation rows is a PREFIX of the plan.
    const have = new Set(ops.map((o) => o.operationKey));
    expect([...have].sort(), `wake ${wakes}: operations are a prefix of the plan`)
      .toEqual(plan.slice(0, ops.length).map((p) => p.key).sort());
    // Disable/suspend never before that provider's mail routing.
    for (const provider of ['google', 'm365'] as const) {
      const routing = plan.filter((p) => p.provider === provider && MAIL_ROUTING[provider].includes(p.toolName));
      const disable = plan.find((p) => p.toolName === DISABLE[provider]);
      if (disable && routing.some((r) => !have.has(r.key))) {
        expect(have.has(disable.key), `${DISABLE[provider]} ran before ${provider} mail routing`).toBe(false);
      }
    }
    await releaseInFlight(a);
  }
  return wakes;
}

/** Tick every open manual item (in the order given) and wake once per tick batch. */
async function manualItems(a: Admitted) {
  const rows = await readSteps(a, 'manual_work');
  const ids = rows.map((r) => r.checklistItemId).filter((x): x is string => !!x);
  const items = ids.length === 0 ? [] : await system(() => db.select().from(ticketChecklistItems)
    .where(sql`${ticketChecklistItems.id} IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`));
  return { rows, items };
}

/** Merge the task's org into a fresh sibling with the real merge service. */
async function mergeTaskOrgAway(t: Tenant): Promise<{ survivorId: string }> {
  const survivor = await createOrganization({ partnerId: t.partnerId });
  const actor = await createUser({ partnerId: t.partnerId, orgId: null, email: `merge-${randomUUID().slice(0, 8)}@msp.example` });
  const priorDrain = process.env.ORG_MERGE_FENCE_DRAIN_MS;
  process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
  try {
    await executeOrgMerge({
      loserOrgId: t.orgId, survivorOrgId: survivor.id, partnerId: t.partnerId,
      performedBy: actor.id, performedByEmail: actor.email,
    });
  } finally {
    if (priorDrain === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
    else process.env.ORG_MERGE_FENCE_DRAIN_MS = priorDrain;
  }
  return { survivorId: survivor.id };
}

/** The whole path to a settled task, ticking every manual item as the approver. */
async function driveToSettled(t: Tenant): Promise<Admitted> {
  const a = await driveToApprovedAndHeld(t);
  await openWindow(a);
  await walkEffects(a);
  expect((await readTask(a)).currentStepKey).toBe('manual_work');
  await wake(a);
  const { rows } = await manualItems(a);
  for (const r of rows) await tickAs(t, t.approverId, r.checklistItemId!);
  await wake(a);
  await cleanWorld();
  await wake(a); // verify_outcome
  await wake(a); // document
  return a;
}

async function cleanWorld(): Promise<void> {
  fake.world.google.groups = [];
  fake.world.google.licenses = [];
  fake.world.google.suspended = true;
  fake.world.m365.memberOf = [];
  fake.world.m365.licenses = [];
  fake.world.m365.enabled = false;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('AI_OPERATOR_TASKS_ENABLED', 'true');
  vi.stubEnv('AI_OPERATOR_RECIPE_IDENTITY_OFFBOARDING_ENABLED', 'true');
  fake.world = freshWorld();
  fake.googleConnId = null;
  fake.probe = {};
  fake.m365Calls = 0;
  gate.forTargets.mockClear();
  gate.device.mockClear();
  __resetEffectProbesForTest();
  for (const tool of CATALOG) {
    if (tool === 'google_signout') {
      registerEffectProbe(tool, async () => ({ state: 'unknown', observedAt: new Date(), detail: 'no session state to read' }), { alwaysUnknown: true });
      continue;
    }
    registerEffectProbe(tool, async (_effect, ctx) => {
      const state = fake.probe[tool]?.[ctx.phase] ?? (ctx.phase === 'pre' ? 'unsatisfied' : 'satisfied');
      return { state, observedAt: new Date(), detail: `scripted ${ctx.phase} ${state}` };
    });
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetEffectProbesForTest();
});

// ---------------------------------------------------------------------------
// Step 1 — the happy path
// ---------------------------------------------------------------------------

describe('identity_offboarding end to end (R1a)', () => {
  runDb('happy path: admit → confirm → discover → review → four-eyes plan → cutoff → ordered walk → manual work → verify → document', async () => {
    const t = await seedTenant();
    const a = await admit(t);

    // ── admit ────────────────────────────────────────────────────────────
    const targets = await system(() => db.select().from(aiOperatorTaskTargets).where(eq(aiOperatorTaskTargets.taskId, a.taskId)));
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ targetKind: 'contact', targetOrdinal: 0, contactId: t.contactId, detachedAt: null });
    const accounts = await system(() => db.select().from(aiOperatorTaskTargetAccounts).where(eq(aiOperatorTaskTargetAccounts.taskId, a.taskId)));
    expect(accounts.map((x) => x.provider).sort()).toEqual(['google', 'm365']);
    expect(accounts.find((x) => x.provider === 'm365')).toMatchObject({ externalId: fake.world.m365.id, m365ConnectionId: t.m365ConnId });
    expect(accounts.find((x) => x.provider === 'google')).toMatchObject({ externalId: fake.world.google.id, googleConnectionId: t.googleConnId });
    expect(fake.m365Calls, 'admission resolved accounts from links, not a provider read').toBe(0);
    const forged = await system(() => db.insert(aiOperatorTaskTargetAccounts).values({
      orgId: t.orgId, taskId: a.taskId, targetId: targets[0]!.id, provider: 'm365',
      externalId: 'forged-second-m365', principalLabel: 'forged@customer.example',
    })).then(() => null, (err: unknown) => err);
    expect(pgCode(forged), 'UNIQUE (org, task, provider)').toBe('23505');
    let task = await readTask(a);
    expect(task).toMatchObject({ state: 'queued', currentStepKey: 'intake', workflowKey: 'identity_offboarding', requesterUserId: t.requesterId });

    // ── intake ───────────────────────────────────────────────────────────
    await wake(a);
    task = await readTask(a);
    expect(task.currentStepKey).toBe('confirm_identity');
    expect((await system(() => db.select().from(aiAgentRuns).where(eq(aiAgentRuns.taskId, a.taskId)))).length,
      'the pre-inserted run was read; no new run admitted').toBe(2);

    // ── confirm_identity ─────────────────────────────────────────────────
    await wake(a);
    task = await readTask(a);
    expect(task).toMatchObject({ state: 'waiting', currentStepKey: 'confirm_identity', waitDependencyKind: 'user_answer' });
    const [confirmStep] = await readSteps(a, 'confirm_identity');
    const [confirmItem] = await system(() => db.select().from(ticketChecklistItems).where(eq(ticketChecklistItems.id, confirmStep!.checklistItemId!)));
    expect(confirmItem).toMatchObject({ source: 'operator_task', orgId: t.orgId, doneAt: null });
    expect(confirmItem!.label).toContain('Dana Example');
    expect(task.waitDependencyId).toBe(confirmItem!.id);
    // Unticked: a wake cannot reach discover.
    await wake(a);
    task = await readTask(a);
    expect(task).toMatchObject({ state: 'waiting', currentStepKey: 'confirm_identity' });
    expect(await readSteps(a, 'discover')).toHaveLength(0);
    await tickAs(t, t.requesterId, confirmItem!.id);
    await wake(a);
    task = await readTask(a);
    expect(task.currentStepKey).toBe('discover');

    // ── discover ─────────────────────────────────────────────────────────
    await wake(a);
    task = await readTask(a);
    expect(task.currentStepKey).toBe('review');
    const [discoverStep] = await readSteps(a, 'discover');
    expect(discoverStep!.state).toBe('succeeded');
    const envelope = (discoverStep!.checkpoint as { planningSnapshot?: { version: number; facts: Record<string, unknown> } }).planningSnapshot;
    expect(envelope?.version).toBe(1);
    expect((envelope!.facts.google as { present: boolean }).present).toBe(true);
    expect((envelope!.facts.m365 as { present: boolean }).present).toBe(true);
    const cp = taskCheckpointSchema.parse(task.checkpoint);
    expect(cp.planningSnapshot).toEqual({ stepId: discoverStep!.id, digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const loaded = await loadPlanningFacts(task, identityOffboardingRecipe as never, cp);
    expect(loaded.ok).toBe(true);

    // ── review ───────────────────────────────────────────────────────────
    await wake(a);
    task = await readTask(a);
    expect(task.currentStepKey).toBe('effects');
    const reviewCp = taskCheckpointSchema.parse(task.checkpoint);
    expect(reviewCp.resumeStepKey).toBe('manual_work');
    expect(reviewCp.dispatchNotBefore).toBe(a.cutoffAt);

    // ── effects: propose ─────────────────────────────────────────────────
    await wake(a);
    task = await readTask(a);
    expect(task).toMatchObject({ state: 'waiting', waitReason: 'approval', waitDependencyKind: 'intent' });
    const [approval] = await approvals(a);
    expect(await approvals(a)).toHaveLength(1);
    expect(approval).toMatchObject({ state: 'pending', stepKey: 'effects', planRevision: task.revision });
    const effects = await approvalEffects(a);
    expect(effects.length).toBe(approval!.effectCount);
    expect(effects.map((e) => e.toolName)).toEqual([
      'google_set_vacation', 'google_set_forwarding', 'google_remove_from_group', 'google_remove_license',
      'google_signout', 'google_suspend_user',
      'm365_set_auto_reply', 'm365_remove_from_group', 'm365_remove_license', 'm365_revoke_sessions', 'm365_disable_user',
    ]);
    const plans = await planIntents(a);
    expect(plans).toHaveLength(1);
    expect(task.waitDependencyId).toBe(plans[0]!.id);
    expect(await childIntents(a)).toHaveLength(0);

    // Four eyes: the requester holds approvals:decide too, but the plan's
    // approval request is never addressed to them.
    await approve(a);
    const [approved] = await approvals(a);
    expect(approved).toMatchObject({ state: 'approved', approvedByUserId: t.approverId });
    expect(approved!.approvedByUserId).not.toBe(t.requesterId);

    // ── effects: the cutoff holds the walk ───────────────────────────────
    await wake(a);
    task = await readTask(a);
    expect(task).toMatchObject({ state: 'waiting', waitReason: 'maintenance_window', waitDependencyKind: null });
    expect(await childIntents(a)).toHaveLength(0);
    expect(await operations(a)).toHaveLength(0);
    await openWindow(a);

    // ── effects: the ordered walk ────────────────────────────────────────
    const effectsWakesBefore = gate.forTargets.mock.calls.length;
    const walkWakes = await walkEffects(a);
    task = await readTask(a);
    expect(task.currentStepKey).toBe('manual_work');
    const ops = await operations(a);
    expect(ops).toHaveLength(effects.length);
    expect(ops.every((o) => o.resultState === 'succeeded')).toBe(true);
    const signout = ops.find((o) => o.operationKey.includes('google_signout'));
    expect((signout!.result as { verified?: Record<string, unknown> }).verified)
      .toMatchObject({ ok: false, unobservable: true, subsumedBy: 'google_suspend_user' });
    expect(ops.filter((o) => o.operationKey !== signout!.operationKey)
      .every((o) => (o.result as { verified?: { ok?: boolean } }).verified?.ok === true)).toBe(true);
    expect((await childIntents(a)).map((i) => i.actionName).sort()).toEqual(effects.map((e) => e.toolName).sort());

    // Targets gate evidence: called on every effects wake (propose, the
    // post-approval hold, and each walk wake), the device-keyed gate never.
    const callsForTask = gate.forTargets.mock.calls.filter((c) => (c[0] as { id: string }).id === a.taskId);
    // 1 (propose) + 1 (held at the cutoff) + every walk wake.
    expect(callsForTask).toHaveLength(2 + walkWakes);
    expect(gate.forTargets.mock.calls.length - effectsWakesBefore).toBe(walkWakes);
    expect(gate.device).not.toHaveBeenCalled();

    // ── manual_work ──────────────────────────────────────────────────────
    await wake(a);
    task = await readTask(a);
    expect(task).toMatchObject({ state: 'waiting', currentStepKey: 'manual_work', waitDependencyKind: 'user_answer' });
    const facts = (await loadPlanningFacts(task, identityOffboardingRecipe as never, taskCheckpointSchema.parse(task.checkpoint)));
    if (!facts.ok) throw new Error('facts did not load');
    const expected = buildIdentityOffboardingManualWork(
      taskCheckpointSchema.parse(task.checkpoint).recipeInput as never, facts.facts,
      (facts.facts.capabilityReadiness ?? {}) as Record<string, boolean>, [],
    );
    const { rows: manualRows, items } = await manualItems(a);
    expect(manualRows).toHaveLength(expected.length);
    expect(items).toHaveLength(expected.length);
    expect(items.map((i) => i.label).sort()).toEqual(expected.map((e) => e.label).sort());
    expect(items.every((i) => i.source === 'operator_task' && i.orgId === t.orgId && i.doneAt === null)).toBe(true);
    // Out of order, by two different people; every item but the FIRST.
    const byIndex = [...manualRows].sort((x, y) => x.attemptOrdinal - y.attemptOrdinal).map((r) => r.checklistItemId!);
    const completer = new Map<string, string>();
    for (const [n, id] of [...byIndex.slice(1)].reverse().entries()) {
      const who = n % 2 === 0 ? t.approverId : t.requesterId;
      await tickAs(t, who, id);
      completer.set(id, who);
    }
    await wake(a);
    task = await readTask(a);
    expect(task).toMatchObject({ state: 'waiting', currentStepKey: 'manual_work', waitDependencyId: byIndex[0] });
    await tickAs(t, t.approverId, byIndex[0]!);
    completer.set(byIndex[0]!, t.approverId);
    await wake(a);
    task = await readTask(a);
    expect(task.currentStepKey).toBe('verify_outcome');

    // ── verify_outcome ───────────────────────────────────────────────────
    await cleanWorld();
    await wake(a);
    task = await readTask(a);
    expect(task.currentStepKey).toBe('document');
    const verdict = taskCheckpointSchema.parse(task.checkpoint).lastVerification;
    expect(verdict, JSON.stringify(verdict)).toMatchObject({ result: 'passed' });

    // ── document ─────────────────────────────────────────────────────────
    await wake(a);
    task = await readTask(a);
    expect(task).toMatchObject({ state: 'completed', outcome: 'verified_resolved' });
    const ticketId = await taskTicketId(a);
    const comments = await system(() => db.select().from(ticketComments).where(eq(ticketComments.ticketId, ticketId)));
    expect(comments).toHaveLength(1);
    const record = comments[0]!;
    expect(record).toMatchObject({ authorType: 'ai_agent', commentType: 'internal', isPublic: false, userId: null });
    for (const e of effects) {
      expect(record.content).toMatch(new RegExp(`#${e.ordinal} \\w+ ${e.toolName} — [^\\n]*approved by ${t.approverName}`));
    }
    // Every human-work item is ticked on the record with a named completer.
    // (That each line also carries its item's LABEL is asserted by the BUG
    // case "completion record names every human-work item…" below: one of the
    // recipe's own labels is redacted today.)
    const allItems = [confirmItem!, ...items];
    const doneLines = record.content.split('\n').filter((l) => /^- \[x\] .* — completed by (Rita Requester|Avery Approver) at /.test(l));
    expect(doneLines).toHaveLength(allItems.length);
    expect(record.content).toContain(`[x] ${confirmItem!.label} — completed by ${t.requesterName}`);
    expect(doneLines.filter((l) => l.includes(`completed by ${t.approverName}`)))
      .toHaveLength([...completer.values()].filter((u) => u === t.approverId).length);
    // A second wake posts nothing.
    await wake(a);
    const again = await system(() => db.select().from(ticketComments).where(eq(ticketComments.ticketId, ticketId)));
    expect(again).toHaveLength(1);
    expect((await readTask(a)).state).toBe('completed');
  }, 120_000);

  // -------------------------------------------------------------------------
  // Step 2 — the gate and adversarial cases
  // -------------------------------------------------------------------------

  runDb('requester loses org-wide governance after approval: hands off "requester access lost", nothing minted', async () => {
    const t = await seedTenant();
    const a = await driveToProposed(t);
    await approve(a);
    // Site-restricted, still a live org member (the RequesterAccessRecheck mechanism).
    await system(() => db.update(organizationUsers).set({ siteIds: [t.siteId] }).where(eq(organizationUsers.id, t.requesterOrgUserId)));
    await openWindow(a);
    await wake(a);
    const task = await readTask(a);
    expect(task).toMatchObject({ state: 'handed_off', outcome: 'unresolved' });
    expect(task.outcomeDetail).toMatch(/^requester access lost: .*site-restricted/);
    expect(await childIntents(a)).toHaveLength(0);
    expect(await operations(a)).toHaveLength(0);
    await wake(a);
    expect(await childIntents(a)).toHaveLength(0);
  }, 60_000);

  runDb('strict detach, ticket move: the moved ticket target stops the walk; nothing dispatches afterwards', async () => {
    const t = await seedTenant();
    const a = await driveToApprovedAndHeld(t);
    await openWindow(a);
    // One effect goes out first, so "afterwards" is not vacuous.
    await wake(a);
    expect(await childIntents(a)).toHaveLength(1);
    await releaseInFlight(a);

    const other = await createOrganization({ partnerId: t.partnerId });
    const ticketId = await taskTicketId(a);
    await system(() => moveTicketOrg(ticketId, other.id, { kind: 'user' as const, userId: t.requesterId }));
    const [contactTarget] = await system(() => db.select().from(aiOperatorTaskTargets)
      .where(and(eq(aiOperatorTaskTargets.taskId, a.taskId), eq(aiOperatorTaskTargets.targetKind, 'contact'))));
    expect(contactTarget!.detachedAt, 'the contact is still live').toBeNull();

    await wake(a);
    const task = await readTask(a);
    expect(task).toMatchObject({ state: 'handed_off', outcome: 'unresolved' });
    expect(task.outcomeDetail).toMatch(/^requester access lost: task target .* \(ticket\) was detached/);
    expect(await childIntents(a)).toHaveLength(1);
    await wake(a);
    expect(await childIntents(a)).toHaveLength(1);
    // Nothing was minted in the ticket's new tenant either.
    const foreign = await system(() => db.select().from(actionIntents).where(eq(actionIntents.orgId, other.id)));
    expect(foreign).toHaveLength(0);
  }, 60_000);

  runDb('strict detach, org merge: the contact target is detached org_merged and the task is fenced before anything dispatches', async () => {
    const t = await seedTenant();
    const a = await driveToApprovedAndHeld(t);
    const { survivorId } = await mergeTaskOrgAway(t);
    const [contactTarget] = await system(() => db.select().from(aiOperatorTaskTargets)
      .where(and(eq(aiOperatorTaskTargets.taskId, a.taskId), eq(aiOperatorTaskTargets.targetKind, 'contact'))));
    expect(contactTarget).toMatchObject({ detachedReason: 'org_merged', contactId: null, state: 'detached' });
    expect(contactTarget!.detachedAt).not.toBeNull();
    const task = await readTask(a);
    expect(task.state).toBe('stopping');
    expect(task.outcomeDetail).toMatch(/Fenced by an organization merge/);
    expect(await childIntents(a)).toHaveLength(0);
    expect(await operations(a)).toHaveLength(0);
    const survivorIntents = await system(() => db.select().from(actionIntents)
      .where(and(eq(actionIntents.orgId, survivorId), sql`${actionIntents.actionName} <> 'operator_plan'`)));
    expect(survivorIntents).toHaveLength(0);
  }, 60_000);

  // BUG: a merge-fenced (`stopping`) task can never settle. The org-merge
  // fence (orgMergeCustomExecutors.ts ~315) moves every live task to
  // `stopping`; the next wake claims it (taskCoordinator.ts:243, `stopping` &&
  // lease expired), runs `advanceTask`, the targets gate correctly reports
  // "task target … (contact) was detached", and `settle({event:'hand_off'})`
  // (taskCoordinator.ts:879 -> :411 `nextTaskState(state, event)`) THROWS
  //   TaskTransitionError: transition 'hand_off' is not allowed from task state 'stopping'
  // because TASK_TRANSITIONS.stopping only allows claim / settle_cancelled /
  // settle_expired / settle_handed_off (taskTransitions.ts:126-131), and no
  // code anywhere writes a settle_* event. Observed row after the wake: state
  // 'stopping', lease held by this coordinator for 60 s, no child intent. The
  // reconciler's set 3 (running/stopping past lease) re-wakes it and it throws
  // again, forever. Nothing dispatches (the gate runs first), but the task is
  // never terminal and never hands off.
  skipDb('strict detach, org merge: the next wake hands the fenced task off and nothing dispatches under the dead tenant', async () => {
    const t = await seedTenant();
    const a = await driveToApprovedAndHeld(t);
    const { survivorId } = await mergeTaskOrgAway(t);
    await openWindow(a);
    await wake(a);
    const task = await readTask(a);
    expect(task.state).toBe('handed_off');
    expect(task.outcomeDetail).toMatch(/requester access lost: .*detached/);
    expect(await childIntents(a)).toHaveLength(0);
    const survivorIntents = await system(() => db.select().from(actionIntents)
      .where(and(eq(actionIntents.orgId, survivorId), sql`${actionIntents.actionName} <> 'operator_plan'`)));
    expect(survivorIntents).toHaveLength(0);
  }, 60_000);

  // BUG (missing surface): there is no task-cancel path in this build. No
  // service, route or job writes the `stop` / `settle_cancelled` transitions
  // (taskTransitions.ts:101-131 declares them; `grep -rn "settle_cancelled'"`
  // finds only the table). routes/aiOperatorTasks.ts:8-9 says "Answers,
  // pause/resume/cancel and retry are still later waves (P3-5)". The only
  // writer of `stopping` is the org-merge fence (orgMergeCustomExecutors.ts
  // ~315). So "cancel through the real cancel path" cannot be exercised.
  //
  // And when a cancel IS built, the coordinator is not ready for it. A
  // one-off probe (not kept) wrote what a cancel's `stop` transition writes —
  // state 'stopping', lease cleared — onto a task held at the cutoff, opened
  // the window and woke it once. Observed: the wake MINTED the next child
  // (google_set_vacation, intent status 'approved', operation 'pending'), then
  // threw "TaskTransitionError: transition 'wait' is not allowed from task
  // state 'stopping'" from yieldToWait; the row stayed 'stopping' with the
  // lease held. advanceTask (taskCoordinator.ts:760-892) never consults
  // admissionFenced()/isTaskFenced() for the task's own state, so only the
  // release-time dispatch claim (dispatchClaim.ts, refuses 'stopping') would
  // stop that child from executing.
  skipDb('cancel during the not-before wait settles the task and nothing dispatches after the window', async () => {
    // Intentionally empty: see the BUG note above.
  });

  runDb('world drift after discovery: the seal holds, the new group is not removed, verify fails naming it, the task settles partial', async () => {
    const t = await seedTenant();
    const a = await driveToApprovedAndHeld(t);
    fake.world.google.groups.push({ id: 'gg-eng', email: 'eng@customer.example', name: 'Engineering', role: 'MEMBER' });
    await openWindow(a);
    await walkEffects(a);
    let task = await readTask(a);
    expect(task.currentStepKey, `${task.state}: ${task.outcomeDetail}`).toBe('manual_work');
    expect(task.state).not.toBe('handed_off');
    const intents = await childIntents(a);
    expect(intents.some((i) => JSON.stringify(i.arguments ?? {}).includes('eng@customer.example'))).toBe(false);
    expect(intents.filter((i) => i.actionName === 'google_remove_from_group')).toHaveLength(1);

    await wake(a); // manual items
    const { rows } = await manualItems(a);
    for (const r of rows) await tickAs(t, t.approverId, r.checklistItemId!);
    await wake(a);
    expect((await readTask(a)).currentStepKey).toBe('verify_outcome');
    await cleanWorld();
    fake.world.google.groups = [{ id: 'gg-eng', email: 'eng@customer.example', name: 'Engineering', role: 'MEMBER' }];
    await wake(a);
    task = await readTask(a);
    const verdict = taskCheckpointSchema.parse(task.checkpoint).lastVerification;
    expect(verdict?.result).toBe('failed');
    expect(verdict?.detail).toContain('still in Google group Engineering');
    await wake(a);
    task = await readTask(a);
    expect(task).toMatchObject({ state: 'partial', outcome: 'unresolved' });
  }, 120_000);

  runDb('forged snapshot after approval: the next effects wake hands off on the digest and dispatches nothing further', async () => {
    const t = await seedTenant();
    const a = await driveToApprovedAndHeld(t);
    await openWindow(a);
    await wake(a);
    await releaseInFlight(a);
    expect(await childIntents(a)).toHaveLength(1);
    const [discoverStep] = await readSteps(a, 'discover');
    await system(() => db.execute(sql`
      UPDATE ai_operator_task_steps
         SET checkpoint = jsonb_set(checkpoint, '{planningSnapshot,facts,google,groups}', '[]'::jsonb)
       WHERE id = ${discoverStep!.id}`));
    await wake(a);
    const task = await readTask(a);
    expect(task).toMatchObject({ state: 'handed_off', outcome: 'unresolved' });
    expect(task.outcomeDetail).toContain('snapshot_digest_mismatch');
    expect(await childIntents(a)).toHaveLength(1);
    expect(await operations(a)).toHaveLength(1);
  }, 60_000);

  runDb('readiness lost after approval (veto): revoking MailboxSettings.ReadWrite hands off naming m365_set_auto_reply; earlier effects stay settled', async () => {
    const t = await seedTenant();
    const a = await driveToApprovedAndHeld(t);
    await openWindow(a);
    await walkEffects(a, { stopAfterOps: 2 });
    await wake(a); // verifies #1, dispatches #2
    await releaseInFlight(a);
    const before = await operations(a);
    expect(before).toHaveLength(3);
    expect(before.every((o) => o.resultState === 'succeeded')).toBe(true);
    const plan = await planKeys(a);
    const autoReply = plan.find((p) => p.toolName === 'm365_set_auto_reply')!;
    expect(before.some((o) => o.operationKey === autoReply.key)).toBe(false);

    const kept = allActionGrants().filter((g) => g.value !== 'MailboxSettings.ReadWrite');
    expect(kept.length).toBe(allActionGrants().length - 1);
    await system(() => db.update(m365Connections).set({ observedGrants: kept } as never).where(eq(m365Connections.id, t.m365ConnId)));
    await wake(a);
    const task = await readTask(a);
    expect(task).toMatchObject({ state: 'handed_off', outcome: 'unresolved' });
    expect(task.outcomeDetail).toMatch(/^readiness lost after planning: .*m365_set_auto_reply/);
    const after = await operations(a);
    expect(after).toHaveLength(3);
    expect(after.every((o) => o.resultState === 'succeeded')).toBe(true);
    expect(await childIntents(a)).toHaveLength(3);
  }, 60_000);

  // BUG (missing surface): same as the cancel case above — no task-cancel
  // path exists (routes/aiOperatorTasks.ts:8-9; no writer of the `stop` /
  // `settle_cancelled` transitions anywhere outside taskTransitions.ts).
  skipDb('stop mid-plan: cancelled after the Google mail effects, before the suspend; nothing dispatches afterwards', async () => {
    // Intentionally empty: see the BUG note above.
  });

  runDb('provider not ready before discover: m365_set_auto_reply is left out, the M365 disable is HELD with it (never disabled with mail unrouted), every Google effect dispatches', async () => {
    const kept = allActionGrants().filter((g) => g.value !== 'MailboxSettings.ReadWrite');
    expect(kept.length).toBe(allActionGrants().length - 1);
    const t = await seedTenant({ observedGrants: kept });
    const a = await driveToApprovedAndHeld(t);
    const effects = await approvalEffects(a);
    expect(effects.map((e) => e.toolName)).not.toContain('m365_set_auto_reply');
    // The ordering contract applied to degradation: the auto-reply cannot run,
    // so the disable is held back too and becomes a manual item for AFTER it.
    expect(effects.map((e) => e.toolName)).not.toContain('m365_disable_user');
    // …and ONLY the disable: the provider's other effects still run.
    expect(effects.map((e) => e.toolName)).toContain('m365_revoke_sessions');
    await openWindow(a);
    await walkEffects(a);
    const task = await readTask(a);
    expect(task.currentStepKey, `${task.state}: ${task.outcomeDetail}`).toBe('manual_work');
    const dispatched = (await childIntents(a)).map((i) => i.actionName);
    for (const tool of effects.filter((e) => e.provider === 'google').map((e) => e.toolName)) {
      expect(dispatched).toContain(tool);
    }
    await wake(a);
    const { items } = await manualItems(a);
    const capability = items.filter((i) => i.label.startsWith('Do by hand in Microsoft 365:'));
    expect(capability).toHaveLength(1);
    expect(capability[0]!.label).toContain('auto-reply');
    expect(items.map((i) => i.label)).toContain("Disable Dana Example's Microsoft 365 account by hand, after the mail steps");
  }, 120_000);

  // Under the PRODUCT DEFAULT caller-verification policy (tier 2 for
  // disable_user, feature on) the Operator can never mint m365_disable_user:
  // createActionIntent requires a verified caller, and an offboarding has none.
  // Readiness therefore degrades it (recipeReadiness.loadCallerVerificationBlocked),
  // discover freezes it out of the plan, and it becomes a specific manual item —
  // instead of being approved and then refused on every wake.
  runDb('default caller-verification policy: m365_disable_user is never planned, it is a manual item, and the walk completes', async () => {
    const t = await seedTenant({ disableUserTier: null });
    const a = await driveToApprovedAndHeld(t);
    expect((await approvalEffects(a)).map((e) => e.toolName)).not.toContain('m365_disable_user');
    await openWindow(a);
    await walkEffects(a);
    let task = await readTask(a);
    expect(task.currentStepKey).toBe('manual_work');
    expect(task.state).not.toBe('handed_off');
    await wake(a);
    const { items } = await manualItems(a);
    expect(items.map((i) => i.label)).toContain("Disable Dana Example's Microsoft 365 account by hand");
    task = await readTask(a);
    expect(task.leaseOwner).toBeNull();
  }, 120_000);

  runDb('completion record names every human-work item, by its label, with its completer', async () => {
    const t = await seedTenant();
    const a = await driveToSettled(t);
    expect((await readTask(a)).state).toBe('completed');
    const ticketId = await taskTicketId(a);
    const [record] = await system(() => db.select().from(ticketComments).where(eq(ticketComments.ticketId, ticketId)));
    const [confirm] = await readSteps(a, 'confirm_identity');
    const { items } = await manualItems(a);
    const [confirmItem] = await system(() => db.select().from(ticketChecklistItems).where(eq(ticketChecklistItems.id, confirm!.checklistItemId!)));
    expect(record!.content).toContain(`[x] ${confirmItem!.label} — completed by ${t.requesterName}`);
    for (const item of items) expect(record!.content).toContain(`[x] ${item.label} — completed by ${t.approverName}`);
    expect(record!.content).not.toContain('[redacted]');
  }, 120_000);
});

// Keep the owner-connection helper referenced for parity with the sibling suites.
void getTestDb;
