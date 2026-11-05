/**
 * The identity_onboarding real-Postgres harness (W07 R2a Task 15, Amendment
 * G13), shared by `aiOperatorIdentityOnboardingE2E` and
 * `aiOperatorTwoStagePlanApproval`. Not a test file (no `.test.ts` suffix), so
 * no runner collects it.
 *
 * Copied in shape from R1c's `identityOffboardingHarness.ts` (never edited),
 * adapted to onboarding's spine (Amendment B1): two `effect` steps at two plan
 * revisions, `resolve_accounts` between them, and no account until the create
 * has settled.
 *
 * THE PROVIDER FAKES. `vi.mock` factories are hoisted into each test file, so
 * every test file declares the same mock blocks over a `vi.hoisted` object
 * whose functions DELEGATE to `fake.h.*`. `bindFakeProviders(fake)` installs
 * the handlers below into that object, so the scripted provider tenant lives in
 * one place and the mock blocks stay a few lines each. What is faked:
 *  - the M365 READS (`executeM365ReadActionByOrg`) and the Google directory /
 *    licensing clients plus `resolveContextByOrg`, answering from `world`;
 *  - the M365 EXECUTOR HTTP client (`createGraphActionsExecutorClient`) and the
 *    env-driven runtime config, exactly as `secretBearingToolSeal` does. The
 *    whole write ladder — the connection load, the grant check, the write
 *    budget, `sealActionResultSecrets`, the operation-row write — is REAL, so
 *    `m365_create_user`'s temporary password is sealed by production code;
 *  - the effect probes (registry stubs; pre `unsatisfied`, post `satisfied`,
 *    overridable per tool and phase).
 * A Google child effect's "release" is simulated the way R1's harness does it
 * (operation stamped succeeded, intent completed): no Google write tool is
 * under test here, and none of them seals anything.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { M365_PERMISSION_PROFILES } from '@breeze/shared/m365';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  actionIntents,
  aiAgentRuns,
  aiAgents,
  aiOperatorOperations,
  aiOperatorPlanApprovalEffects,
  aiOperatorPlanApprovals,
  aiOperatorTaskEvents,
  aiOperatorTasks,
  aiOperatorTaskSteps,
  aiOperatorTaskTargetAccounts,
  aiOperatorTaskTargets,
  contactExternalLinks,
  googleWorkspaceConnections,
  m365Connections,
  organizationUsers,
  ticketChecklistItems,
  ticketComments,
} from '../../db/schema';
import { PERMISSIONS } from '../../services/permissions';
import { admitTask } from '../../services/aiOperator/taskService';
import { handleTaskWake } from '../../services/aiOperator/taskCoordinator';
import { transitionIntent } from '../../services/actionIntents/intentService';
import { releaseApprovedIntent } from '../../jobs/intentReleaseWorker';
import { planEffectOperationKey } from '../../services/aiOperator/planApproval';
import { __resetEffectProbesForTest, registerEffectProbe } from '../../services/aiOperator/effectProbes';
import { IDENTITY_ONBOARDING_EFFECT_TOOLS } from '../../services/aiOperator/recipes/identityOnboarding';
import { patchChecklistItem } from '../../services/ticketChecklistService';
import { executeOrgMerge } from '../../services/orgMerge';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { actionIntentsRoutes } from '../../routes/actionIntents';
import { aiOperatorTasksRoutes } from '../../routes/aiOperatorTasks';
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

export const CATALOG: readonly string[] = [...IDENTITY_ONBOARDING_EFFECT_TOOLS];
export const CREATE_STEP = 'create_accounts';
export const PROVISION_STEP = 'provision_effects';
export const PROMPT_VERSION = 'identity_onboarding/v1';

/** The temporary password the fake executor mints. Distinctive, so a row scan for it is meaningful. */
export const FAKE_PASSWORD = 'Tmp-Onboard-7Qz!900100-kX';
export const UPN = 'priya@customer.example';
export const GOOGLE_EMAIL = 'priya@customer.example';
/** The Entra object id the fake executor assigns to the created user. */
export const CREATED_M365_ID = '00000000-0000-4000-8000-0000000a0001';
/** Someone who already holds the UPN (the collision case). */
export const HOLDER_M365_ID = '00000000-0000-4000-8000-0000000a0099';
export const CREATED_GOOGLE_ID = '900100111';
export const SKU_E3 = '00000000-0000-4000-8000-000000900100';
export const SKU_PART = 'SPE_E3';
export const GROUP_STAFF = '00000000-0000-4000-8000-0000000b0001';
export const GOOGLE_GROUP = 'staff@customer.example';

export const system = <T>(fn: () => Promise<T>): Promise<T> => runOutsideDbContext(() => withSystemDbAccessContext(fn));

export function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.cause?.code ?? e?.code;
}

// ---------------------------------------------------------------------------
// The scripted provider tenant
// ---------------------------------------------------------------------------

export interface M365User { id: string; upn: string; enabled: boolean; licenses: string[] }
export interface M365Sku { skuId: string; skuPartNumber: string; consumedUnits: number; prepaidEnabled: number }
export interface M365Group { id: string; displayName: string; groupTypes: string[]; members: string[] }
export interface GoogleUser { id: string; primaryEmail: string; suspended: boolean }
export interface GoogleGroup { id: string; email: string; name: string }

export interface FakeWorld {
  m365: {
    users: M365User[];
    skus: M365Sku[];
    groups: M365Group[];
    /** Number of `m365.user.create` calls the executor received. */
    createCalls: number;
    /** Per write-action type: `throw` (an outcome nobody can know) or a typed executor failure code. */
    writeOutcome: Record<string, 'throw' | string>;
  };
  google: { users: GoogleUser[]; groups: GoogleGroup[] };
}

type Handler = (...args: any[]) => any;
/** The shape of each test file's `vi.hoisted` object. */
export interface FakeProviders {
  world: FakeWorld;
  googleConnId: string | null;
  /** Per-tool probe overrides, by phase (default: pre unsatisfied, post satisfied). */
  probe: Record<string, { pre?: 'satisfied' | 'unsatisfied' | 'unknown'; post?: 'satisfied' | 'unsatisfied' | 'unknown' }>;
  /** Installed by `bindFakeProviders`; the mock factories call through these. */
  h: Record<string, Handler>;
}

let fake: FakeProviders | null = null;

function providers(): FakeProviders {
  if (!fake) throw new Error('identityOnboardingHarness: bindFakeProviders() was not called');
  return fake;
}

export function freshWorld(): FakeWorld {
  return {
    m365: {
      users: [],
      skus: [{ skuId: SKU_E3, skuPartNumber: SKU_PART, consumedUnits: 5, prepaidEnabled: 10 }],
      groups: [{ id: GROUP_STAFF, displayName: 'All Staff', groupTypes: ['Unified'], members: [] }],
      createCalls: 0,
      writeOutcome: {},
    },
    google: { users: [], groups: [{ id: 'gg-staff-900100', email: GOOGLE_GROUP, name: 'Staff' }] },
  };
}

const notFound = () => Object.assign(new Error('Resource Not Found'), { code: 404 });

function m365UserResource(u: M365User) {
  return {
    id: u.id, userPrincipalName: u.upn, mail: u.upn, accountEnabled: u.enabled,
    assignedLicenses: u.licenses.map((skuId) => ({ skuId })),
  };
}

function findM365User(key: string | undefined): M365User | undefined {
  const k = (key ?? '').toLowerCase();
  return providers().world.m365.users.find((u) => u.id.toLowerCase() === k || u.upn.toLowerCase() === k);
}

const handlers: Record<string, Handler> = {
  async m365Read(_orgId: string, action: { type: string; userIdOrUpn?: string; groupId?: string; userId?: string }) {
    const w = providers().world.m365;
    switch (action.type) {
      case 'm365.user.get': {
        const u = findM365User(action.userIdOrUpn);
        return u ? { ok: true, kind: 'resource', resource: m365UserResource(u) } : { ok: false, code: 'graph_not_found', message: 'not found' };
      }
      case 'm365.org.skus.list':
        return {
          ok: true, kind: 'collection', truncated: false,
          items: w.skus.map((s) => ({
            skuId: s.skuId, skuPartNumber: s.skuPartNumber, consumedUnits: s.consumedUnits,
            prepaidUnits: { enabled: s.prepaidEnabled }, capabilityStatus: 'Enabled',
          })),
        };
      case 'm365.group.list':
        return {
          ok: true, kind: 'collection', truncated: false,
          items: w.groups.map((g) => ({ id: g.id, displayName: g.displayName, mail: null, groupTypes: g.groupTypes })),
        };
      case 'm365.group.get': {
        const g = w.groups.find((x) => x.id === action.groupId);
        return g ? { ok: true, kind: 'resource', resource: { id: g.id, displayName: g.displayName, groupTypes: g.groupTypes } }
          : { ok: false, code: 'graph_not_found', message: 'not found' };
      }
      case 'm365.group.member.get': {
        const g = w.groups.find((x) => x.id === action.groupId);
        return { ok: true, kind: 'collection', truncated: false, items: g?.members.includes(action.userId ?? '') ? [{ id: action.userId }] : [] };
      }
      default:
        return { ok: false, code: 'unsupported_in_test', message: `unscripted read ${action.type}` };
    }
  },

  async googleContext(orgId: string) {
    const f = providers();
    return f.googleConnId
      ? { conn: { id: f.googleConnId, orgId, adminEmail: 'admin@customer.example' }, keyJson: '{}' }
      : { error: 'no_google_connection' };
  },

  directory() {
    const g = () => providers().world.google;
    return {
      users: {
        get: async ({ userKey }: { userKey: string }) => {
          const k = userKey.toLowerCase();
          const u = g().users.find((x) => x.id === userKey || x.primaryEmail.toLowerCase() === k);
          if (!u) throw notFound();
          return { data: { id: u.id, primaryEmail: u.primaryEmail, suspended: u.suspended } };
        },
      },
      groups: {
        get: async ({ groupKey }: { groupKey: string }) => {
          const grp = g().groups.find((x) => x.email.toLowerCase() === groupKey.toLowerCase());
          if (!grp) throw notFound();
          return { data: { id: grp.id, email: grp.email, name: grp.name } };
        },
        list: async () => ({ data: { groups: [] } }),
      },
      members: { get: async () => { throw notFound(); } },
    };
  },

  licensing() {
    return { licenseAssignments: { listForProduct: async () => ({ data: { items: [] } }) } };
  },

  /** The M365 executor HTTP client's one call. Receives the TYPED action the real ladder built. */
  async executeWriteAction(req: { action: Record<string, unknown> }) {
    const w = providers().world.m365;
    const action = req.action as { type: string; userPrincipalName?: string; userIdentifier?: string; skuIds?: string[]; groupId?: string };
    const outcome = w.writeOutcome[action.type];
    if (action.type === 'm365.user.create') w.createCalls += 1;
    // A plain Error is NOT a GraphActionsExecutorClientError, so the ladder
    // rethrows it and the release records an executed-but-unknown outcome.
    if (outcome === 'throw') throw new Error('executor socket timeout after the request was sent');
    if (outcome) return { success: false, errorCode: outcome };
    switch (action.type) {
      case 'm365.user.create': {
        w.users.push({ id: CREATED_M365_ID, upn: action.userPrincipalName!, enabled: true, licenses: [] });
        return {
          success: true, action: 'm365.user.create', userId: CREATED_M365_ID,
          userPrincipalName: action.userPrincipalName, temporaryPassword: FAKE_PASSWORD, forceChangeNextSignIn: true,
        };
      }
      case 'm365.user.license.assign': {
        const u = findM365User(action.userIdentifier);
        if (!u) return { success: false, errorCode: 'user_not_found' };
        for (const s of action.skuIds ?? []) if (!u.licenses.includes(s)) u.licenses.push(s);
        return { success: true, action: action.type, userId: u.id, assignedSkuIds: action.skuIds ?? [], noop: false };
      }
      case 'm365.group.membership.add': {
        const u = findM365User(action.userIdentifier);
        const grp = w.groups.find((x) => x.id === action.groupId);
        if (!u || !grp) return { success: false, errorCode: 'user_not_found' };
        if (!grp.members.includes(u.id)) grp.members.push(u.id);
        return { success: true, action: action.type, userId: u.id, groupId: grp.id, noop: false };
      }
      default:
        throw new Error(`unscripted executor action ${action.type}`);
    }
  },
};

/** Hand the test file's hoisted provider state to the harness. Call once, at module scope. */
export function bindFakeProviders(f: FakeProviders): void {
  fake = f;
  Object.assign(f.h, handlers);
}

/** Reset the world and (re)register the probe stubs. Call from `beforeEach`. */
export function resetFakes(): void {
  const f = providers();
  f.world = freshWorld();
  f.googleConnId = null;
  f.probe = {};
  __resetEffectProbesForTest();
  for (const tool of CATALOG) {
    registerEffectProbe(tool, async (_effect, ctx) => {
      const state = f.probe[tool]?.[ctx.phase] ?? (ctx.phase === 'pre' ? 'unsatisfied' : 'satisfied');
      return { state, observedAt: new Date(), detail: `scripted ${ctx.phase} ${state}` };
    });
  }
}

export function world(): FakeWorld {
  return providers().world;
}

/** What a technician does by hand for `manual_create_google`: the account now exists. */
export function createGoogleUserByHand(email: string = GOOGLE_EMAIL): void {
  world().google.users.push({ id: CREATED_GOOGLE_ID, primaryEmail: email, suspended: false });
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
  requesterRoleId: string;
  requesterOrgUserId: string;
  approverId: string;
  approverName: string;
  approverRoleId: string;
  agentId: string;
  m365ConnId: string;
  googleConnId: string | null;
}

async function userWithRole(partnerId: string, orgId: string, name: string) {
  const role = await createRole({ scope: 'organization', orgId });
  await grantRolePermissions(role.id, [
    PERMISSIONS.APPROVALS_DECIDE, PERMISSIONS.ORGS_WRITE, PERMISSIONS.ORGS_READ, PERMISSIONS.AI_AGENTS_READ,
  ]);
  const user = await createUser({
    partnerId, orgId, name, email: `${name.split(' ')[0]!.toLowerCase()}-${randomUUID().slice(0, 8)}@msp.example`,
  });
  const membership = await assignUserToOrganization(user.id, orgId, role.id);
  return { user, roleId: role.id, orgUserId: (membership as { id: string }).id };
}

/** Every app role the actions profile declares, in the canonical order the grants CHECK requires. */
export function allActionGrants() {
  const key = (g: { resourceApplicationId: string; appRoleId: string }) => `${g.resourceApplicationId}/${g.appRoleId}`;
  return [...(M365_PERMISSION_PROFILES['customer-graph-actions'].applicationPermissionAssignments ?? [])]
    .sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
}

export async function seedTenant(opts: { google?: boolean } = {}): Promise<Tenant> {
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
      observedGrants: allActionGrants(), grantsVerifiedAt: new Date(),
    } as never).returning({ id: m365Connections.id });
    let googleConnId: string | null = null;
    if (opts.google !== false) {
      const [google] = await db.insert(googleWorkspaceConnections).values({
        orgId: org.id, customerDomain: 'customer.example', adminEmail: 'admin@customer.example',
        serviceAccountEmail: 'svc@customer.example', serviceAccountKey: 'unused-the-client-is-faked', status: 'active',
      } as never).returning({ id: googleWorkspaceConnections.id });
      googleConnId = google!.id;
    }
    return { agentId: agent!.id, m365ConnId: m365!.id, googleConnId };
  });
  f.googleConnId = seeded.googleConnId;
  return {
    partnerId: partner.id, orgId: org.id, siteId: site.id,
    requesterId: requester.user.id, requesterName: 'Rita Requester', requesterRoleId: requester.roleId,
    requesterOrgUserId: requester.orgUserId,
    approverId: approver.user.id, approverName: 'Avery Approver', approverRoleId: approver.roleId,
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
    taskId, taskStepKey: stepKey, taskAttemptOrdinal: 0, promptVersion: PROMPT_VERSION,
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

export interface Admitted { t: Tenant; taskId: string; input: Record<string, unknown> }

export interface InputOpts {
  /** Include the Google block (default false: an M365-only onboarding). */
  google?: boolean;
  /** Shallow overrides of the m365 block. */
  m365?: Record<string, unknown> | null;
  /** Top-level overrides. */
  over?: Record<string, unknown>;
}

export function onboardingInput(t: Tenant, opts: InputOpts = {}): Record<string, unknown> {
  return {
    displayName: 'Priya Example', jobTitle: 'Staff Accountant', siteId: t.siteId,
    managerContactId: null, modelAfterContactId: null, startAt: null,
    m365: opts.m365 === null ? null : {
      userPrincipalName: UPN, mailNickname: 'priya', usageLocation: 'US',
      skuIds: [SKU_E3], groupIds: [GROUP_STAFF], ...(opts.m365 ?? {}),
    },
    google: opts.google ? {
      primaryEmail: GOOGLE_EMAIL, givenName: 'Priya', familyName: 'Example', orgUnitPath: '/Staff',
      licenses: [{ productId: 'Google-Apps', skuId: '1010020027' }], groupEmails: [GOOGLE_GROUP],
    } : null,
    ...(opts.over ?? {}),
  };
}

export async function admit(t: Tenant, opts: InputOpts = {}): Promise<Admitted> {
  const input = onboardingInput(t, opts);
  const res = await admitTask({
    orgId: t.orgId, agentId: t.agentId, objective: 'Onboard Priya Example',
    originKind: 'manual', requesterUserId: t.requesterId,
    workflowKey: 'identity_onboarding', workflowVersion: 1, recipeInput: input,
  });
  if (!res.ok) throw new Error(`admitTask refused: ${res.refusal} (${res.detail})`);
  await insertCompletedRun(t, res.taskId, 'intake', {
    kind: 'step', key: 'confirm_details',
    inputs: { managerCandidateContactIds: [], modelAfterCandidateContactIds: [], ambiguous: false, rationale: 'A new hire with no existing contact.' },
  });
  await insertCompletedRun(t, res.taskId, 'review', {
    kind: 'step', key: 'create_accounts',
    inputs: { flags: [], exceptions: [], summary: 'The create plan matches the request; nothing unusual was found.' },
  });
  return { t, taskId: res.taskId, input };
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
export const allSteps = (a: Admitted) =>
  system(() => db.select().from(aiOperatorTaskSteps).where(eq(aiOperatorTaskSteps.taskId, a.taskId)));
export const events = (a: Admitted) =>
  system(() => db.select().from(aiOperatorTaskEvents).where(eq(aiOperatorTaskEvents.taskId, a.taskId)));
export const operations = (a: Admitted) =>
  system(() => db.select().from(aiOperatorOperations).where(eq(aiOperatorOperations.taskId, a.taskId)));
export const childIntents = (a: Admitted) =>
  system(() => db.select().from(actionIntents).where(eq(actionIntents.taskId, a.taskId)));
export const planIntents = (a: Admitted) =>
  system(() => db.select().from(actionIntents)
    .where(and(eq(actionIntents.orgId, a.t.orgId), eq(actionIntents.actionName, 'operator_plan'))));
export const approvals = (a: Admitted) =>
  system(() => db.select().from(aiOperatorPlanApprovals).where(eq(aiOperatorPlanApprovals.taskId, a.taskId))
    .orderBy(asc(aiOperatorPlanApprovals.planRevision)));
export const approvalEffects = (a: Admitted) =>
  system(() => db.select().from(aiOperatorPlanApprovalEffects)
    .where(eq(aiOperatorPlanApprovalEffects.taskId, a.taskId))
    .orderBy(asc(aiOperatorPlanApprovalEffects.planRevision), asc(aiOperatorPlanApprovalEffects.ordinal)));
export const targetAccounts = (a: Admitted) =>
  system(() => db.select().from(aiOperatorTaskTargetAccounts).where(eq(aiOperatorTaskTargetAccounts.taskId, a.taskId)));
export const contactTargets = (a: Admitted) =>
  system(() => db.select().from(aiOperatorTaskTargets)
    .where(and(eq(aiOperatorTaskTargets.taskId, a.taskId), eq(aiOperatorTaskTargets.targetKind, 'contact'))));
export const contactLinks = (contactId: string) =>
  system(() => db.select().from(contactExternalLinks).where(eq(contactExternalLinks.contactId, contactId)));

/** The approval row of `stepKey` at the task's newest revision for that step. */
export async function approvalFor(a: Admitted, stepKey: string) {
  const rows = (await approvals(a)).filter((r) => r.stepKey === stepKey);
  return rows.at(-1) ?? null;
}

export async function effectsFor(a: Admitted, stepKey: string) {
  const approval = await approvalFor(a, stepKey);
  if (!approval) return [];
  return (await approvalEffects(a)).filter((e) => e.approvalId === approval.id);
}

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

/** A step's operation keys, in plan order, from its SEALED approval rows. */
export async function planKeys(a: Admitted, stepKey: string): Promise<PlanKey[]> {
  return (await effectsFor(a, stepKey)).map((e) => ({
    key: planEffectOperationKey({ stepKey, planRevision: e.planRevision, toolName: e.toolName, targetId: e.targetId, ordinal: e.ordinal }),
    toolName: e.toolName, ordinal: e.ordinal, provider: e.provider,
  }));
}

/**
 * Release every in-flight child. An M365 child goes through the REAL durable
 * release (`releaseApprovedIntent`: claim, revalidation, the write ladder with
 * the faked executor, the seal, the operation-row write). A Google child is
 * simulated (see the file header).
 */
export async function releaseInFlight(a: Admitted): Promise<number> {
  const pending = (await operations(a)).filter((o) => o.resultState === 'pending' && o.intentId);
  for (const op of pending) {
    const [intent] = await system(() => db.select({ actionName: actionIntents.actionName }).from(actionIntents)
      .where(eq(actionIntents.id, op.intentId!)));
    if (intent!.actionName.startsWith('m365_')) {
      await runOutsideDbContext(() => releaseApprovedIntent(op.intentId!));
      continue;
    }
    await system(() => db.update(aiOperatorOperations)
      .set({ resultState: 'succeeded', resultAt: new Date(), dispatchedAt: new Date() })
      .where(eq(aiOperatorOperations.id, op.id)));
    await transitionIntent(op.intentId!, ['approved', 'executing'], 'completed', { executedAt: new Date() });
  }
  return pending.length;
}

export function asPlanTenant(t: Tenant, approverId: string = t.approverId): PlanTenant {
  return { orgId: t.orgId, partnerId: t.partnerId, aId: t.requesterId, bId: approverId } as unknown as PlanTenant;
}

/** Approve `stepKey`'s pending plan the real way (decide + release), as the approver. */
export async function approve(a: Admitted, stepKey: string): Promise<void> {
  const approval = await approvalFor(a, stepKey);
  if (!approval?.intentId) throw new Error(`no proposed plan at '${stepKey}'`);
  await approveRealWay(asPlanTenant(a.t), approval.intentId);
}

/**
 * Walk an effect step one wake at a time, releasing each child as it is
 * minted. After EVERY wake: exactly one new operation while the step waits,
 * none on the wake that leaves it, and the operation set is a prefix of the
 * plan. Returns the number of wakes.
 */
export async function walk(a: Admitted, stepKey: string, opts: { stopAfterOps?: number } = {}): Promise<number> {
  const plan = await planKeys(a, stepKey);
  const mine = async () => (await operations(a)).filter((o) => o.taskStepKey === stepKey);
  let wakes = 0;
  for (let guard = 0; guard < 30; guard += 1) {
    const before = await readTask(a);
    if (before.currentStepKey !== stepKey || !['waiting', 'running', 'queued'].includes(before.state)) break;
    const opsBefore = (await mine()).length;
    if (opts.stopAfterOps !== undefined && opsBefore >= opts.stopAfterOps) break;
    await wake(a);
    wakes += 1;
    const ops = await mine();
    const after = await readTask(a);
    if (after.currentStepKey === stepKey && after.state === 'waiting') {
      expect(ops.length, `${stepKey} wake ${wakes}: exactly one new operation (${after.outcomeDetail ?? ''})`).toBe(opsBefore + 1);
    } else {
      expect(ops.length, `${stepKey} wake ${wakes}: the final wake dispatches nothing`).toBe(opsBefore);
    }
    expect(ops.map((o) => o.operationKey).sort(), `${stepKey} wake ${wakes}: operations are a prefix of the plan`)
      .toEqual(plan.slice(0, ops.length).map((p) => p.key).sort());
    await releaseInFlight(a);
  }
  return wakes;
}

/** Admit → intake → confirm (ticked by the requester) → discover → review → create_accounts proposes. */
export async function driveToCreateProposed(t: Tenant, opts: InputOpts = {}): Promise<Admitted> {
  const a = await admit(t, opts);
  await wake(a); // intake -> confirm_details
  await wake(a); // confirm_details opens its item
  const [confirm] = await readSteps(a, 'confirm_details');
  await tickAs(t, t.requesterId, confirm!.checklistItemId!);
  await wake(a); // confirm_details done -> discover
  await wake(a); // discover -> review
  await wake(a); // review -> create_accounts
  await wake(a); // create_accounts proposes
  const task = await readTask(a);
  expect(task.waitReason, `create plan should await approval (${task.state}: ${task.outcomeDetail})`).toBe('approval');
  return a;
}

/** Through stage 1 and `resolve_accounts`, to the provisioning plan awaiting approval. */
export async function driveToProvisionProposed(t: Tenant, opts: InputOpts = {}): Promise<Admitted> {
  const a = await driveToCreateProposed(t, opts);
  await approve(a, CREATE_STEP);
  await walk(a, CREATE_STEP);
  if ((await readTask(a)).currentStepKey === 'manual_create_google') await completeManualCreateGoogle(a);
  expect((await readTask(a)).currentStepKey).toBe('resolve_accounts');
  await wake(a); // resolve_accounts -> provision_effects at r+1
  await wake(a); // provision_effects proposes
  const task = await readTask(a);
  expect(task.currentStepKey, `${task.state}: ${task.outcomeDetail}`).toBe(PROVISION_STEP);
  expect(task.waitReason, `provisioning plan should await approval (${task.state}: ${task.outcomeDetail})`).toBe('approval');
  return a;
}

/** Open the manual Google item, create the account "by hand", tick it, and move on. */
export async function completeManualCreateGoogle(a: Admitted): Promise<void> {
  await wake(a); // opens the item
  const [step] = await readSteps(a, 'manual_create_google');
  expect(step?.checklistItemId, 'manual_create_google opened its item').toBeTruthy();
  createGoogleUserByHand();
  await tickAs(a.t, a.t.requesterId, step!.checklistItemId!);
  await wake(a); // -> resolve_accounts
}

/** The final manual_work rows and their checklist items. */
export async function manualItems(a: Admitted) {
  const rows = await readSteps(a, 'manual_work');
  const ids = rows.map((r) => r.checklistItemId).filter((x): x is string => !!x);
  const items = ids.length === 0 ? [] : await system(() => db.select().from(ticketChecklistItems)
    .where(inArray(ticketChecklistItems.id, ids)));
  return { rows, items };
}

/** From an approved provisioning plan: walk it, do the manual work, verify, document. */
export async function finishFromProvisionApproved(a: Admitted): Promise<void> {
  await walk(a, PROVISION_STEP);
  const at = await readTask(a);
  expect(at.currentStepKey, `${at.state}: ${at.outcomeDetail}`).toBe('manual_work');
  await wake(a); // items onto the ticket
  const { rows } = await manualItems(a);
  for (const r of rows) await tickAs(a.t, a.t.approverId, r.checklistItemId!);
  await wake(a); // -> verify_outcome
  await wake(a); // -> document
  await wake(a); // completion record + settle
}

export async function taskTicketId(a: Admitted): Promise<string> {
  const [row] = await system(() => db.select({ ticketId: aiOperatorTaskTargets.ticketId }).from(aiOperatorTaskTargets)
    .where(and(eq(aiOperatorTaskTargets.taskId, a.taskId), eq(aiOperatorTaskTargets.targetKind, 'ticket'))));
  return row!.ticketId!;
}

export async function ticketCommentsFor(a: Admitted) {
  const ticketId = await taskTicketId(a);
  return system(() => db.select().from(ticketComments).where(eq(ticketComments.ticketId, ticketId)));
}

/**
 * Every row-level place a credential must never reach for this task, as JSON
 * text: events, the task row's checkpoint, every step row, the ticket's
 * comments and checklist items. Returns the places `needle` was found.
 */
export async function plaintextLeaks(a: Admitted, needle: string): Promise<string[]> {
  const found: string[] = [];
  const check = (where: string, value: unknown) => { if (JSON.stringify(value ?? null).includes(needle)) found.push(where); };
  for (const e of await events(a)) check(`event ${e.eventType}`, e);
  check('task checkpoint', (await readTask(a)).checkpoint);
  check('task row', await readTask(a));
  for (const s of await allSteps(a)) check(`step ${s.stepKey}`, s);
  const ticketId = await taskTicketId(a).catch(() => null);
  if (ticketId) {
    for (const c of await system(() => db.select().from(ticketComments).where(eq(ticketComments.ticketId, ticketId)))) check('ticket comment', c);
    for (const i of await system(() => db.select().from(ticketChecklistItems).where(eq(ticketChecklistItems.ticketId, ticketId)))) check('checklist item', i);
  }
  return found;
}

/** Merge the task's org into a fresh sibling with the real merge service. */
export async function mergeTaskOrgAway(t: Tenant): Promise<{ survivorId: string }> {
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

// ---------------------------------------------------------------------------
// The real HTTP routes
// ---------------------------------------------------------------------------

/** A real access token for a tenant user (verified by the real authMiddleware). */
export async function accessTokenFor(t: Tenant, userId: string): Promise<string> {
  const [row] = await system(() => db.select({ roleId: organizationUsers.roleId }).from(organizationUsers)
    .where(and(eq(organizationUsers.orgId, t.orgId), eq(organizationUsers.userId, userId))));
  const [u] = await system(() => db.execute(sql`SELECT email FROM users WHERE id = ${userId}`)) as unknown as Array<{ email: string }>;
  const payload: Omit<TokenPayload, 'type'> = {
    sub: userId, email: u!.email, roleId: row!.roleId, orgId: t.orgId, partnerId: t.partnerId,
    scope: 'organization', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  };
  return createAccessToken(payload);
}

export async function revealSecret(intentId: string, token: string): Promise<{ status: number; body: any }> {
  const app = new Hono();
  app.route('/action-intents', actionIntentsRoutes);
  const res = await app.request(`/action-intents/${intentId}/reveal-secret`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body };
}

export async function getTaskDetail(taskId: string, token: string): Promise<{ status: number; body: any }> {
  const app = new Hono();
  app.route('/api/v1/ai/operator', aiOperatorTasksRoutes);
  const res = await app.request(`/api/v1/ai/operator/tasks/${taskId}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body };
}
