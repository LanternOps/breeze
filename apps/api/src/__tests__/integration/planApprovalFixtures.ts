/**
 * Shared seeding for the E4 plan-approval adversarial suites
 * (aiOperatorPlanApproval{Rls,Membership}, aiOperatorEffectDispatchReplay).
 * Not a test file (no `.test.ts` suffix), so no runner collects it.
 *
 * Every function seeds under system scope or the owner connection. The shared
 * integration setup TRUNCATEs tenant tables before each test, so callers seed
 * per test, never in beforeAll.
 */
import './setup';
import { getTestDb } from './setup';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { aiAgentRuns, aiAgents, aiOperatorTasks, devices, approvalRequests, actionIntents } from '../../db/schema';
import { dbAccessContextFromAuth, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { buildTaskActorAuthContext } from '../../services/actionIntents/actorContext';
import { decideApprovalRequest } from '../../services/approvals/decideApprovalRequest';
import { releaseApprovedIntent } from '../../jobs/intentReleaseWorker';
import {
  proposePlanApproval,
  type PlanEffectLabels,
  type ProposePlanApprovalResult,
} from '../../services/aiOperator/planApproval';
import type { PlannedEffect } from '../../services/aiOperator/recipes/types';
import type { AiOperatorEffectIdempotencyClass } from '../../db/schema/aiOperatorPlanApprovals';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';

export const STEP_KEY = 'offboard';
export const PLAN_REVISION = 2;
export const DEFAULT_ALLOWLIST = ['google_suspend_user', 'google_remove_from_group'];
export const TARGET_ID = '00000000-0000-4000-8000-0000000000c1';

export const system = <T>(fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn));

export const asUser = <T>(auth: AuthContext, fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withDbAccessContext(dbAccessContextFromAuth(auth), fn));

export interface PlanTenant {
  partnerId: string;
  orgId: string;
  siteId: string;
  /** Task requester (proposes the plan). */
  aId: string;
  /** Plan approver. */
  bId: string;
  agentId: string;
  partnerAgentId: string;
  deviceId: string;
  runId: string;
  taskId: string;
}

export interface SeedOpts {
  /** Frozen allowlist on the admitting run's policy snapshot. */
  snapshotAllowlist?: string[];
  /** Live effective allowlist (partner baseline and org row). */
  liveAllowlist?: string[];
  requester?: boolean;
  revision?: number;
}

async function userWithRole(partnerId: string, orgId: string, label: string) {
  const role = await createRole({ scope: 'organization', orgId });
  await grantRolePermissions(role.id, [PERMISSIONS.APPROVALS_DECIDE, PERMISSIONS.ORGS_WRITE, PERMISSIONS.ORGS_READ]);
  const user = await createUser({ partnerId, orgId, email: `${label}-${randomUUID()}@planapproval.test` });
  await assignUserToOrganization(user.id, orgId, role.id);
  return user;
}

function snapshot(allowlist: string[]) {
  return {
    schemaVersion: 1,
    effective: {
      enabled: true, mode: 'shadow' as const, model: null, toolAllowlist: allowlist,
      protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
      limits: {}, triggers: {}, recipients: { userIds: [], roleIds: [] }, instructions: null, cooldownSeconds: 900,
    },
    resolvedAt: new Date().toISOString(),
  };
}

export async function seedPlanTenant(opts: SeedOpts = {}): Promise<PlanTenant> {
  const snapshotAllowlist = opts.snapshotAllowlist ?? DEFAULT_ALLOWLIST;
  const liveAllowlist = opts.liveAllowlist ?? DEFAULT_ALLOWLIST;
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const a = await userWithRole(partner.id, org.id, 'requester');
  const b = await userWithRole(partner.id, org.id, 'approver');

  const [partnerAgent, agent] = await system(async () => {
    const pa = await db.insert(aiAgents).values({
      orgId: null, partnerId: partner.id, kind: 'triage', name: 'Partner Operator',
      createdBy: a.id, enabled: true, mode: 'shadow', toolAllowlist: liveAllowlist,
    }).returning();
    const oa = await db.insert(aiAgents).values({
      orgId: org.id, partnerId: null, kind: 'triage', name: 'Operator',
      createdBy: a.id, enabled: true, mode: 'shadow', toolAllowlist: liveAllowlist,
    }).returning();
    return [pa[0]!, oa[0]!] as const;
  });

  const unique = randomUUID().slice(0, 8);
  const [device] = await (getTestDb() as unknown as typeof db).insert(devices).values({
    orgId: org.id, siteId: site!.id, agentId: `plan-agent-${unique}`, hostname: `plan-host-${unique}`,
    osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
  }).returning();
  const deviceId = (device as { id: string }).id;

  const [task] = await system(() => db.insert(aiOperatorTasks).values({
    orgId: org.id, agentId: agent.id, agentKind: 'triage', agentName: 'Operator',
    workflowKey: 'service_recovery', workflowVersion: 1, originKind: 'manual' as const,
    requesterUserId: opts.requester === false ? null : a.id,
    objective: 'Offboard a departed employee',
    deviceId, state: 'running',
    revision: opts.revision ?? PLAN_REVISION, leaseEpoch: 0,
    deadlineAt: new Date(Date.now() + 3_600_000), targetDetachedAt: null,
  }).returning({ id: aiOperatorTasks.id }));

  const [run] = await system(() => db.insert(aiAgentRuns).values({
    agentId: agent.id, orgId: org.id, deviceId,
    triggerKind: 'alert' as const, dedupeKey: `plan-${randomUUID()}`, modeAtStart: 'shadow' as const,
    policySnapshot: snapshot(snapshotAllowlist) as never,
    taskId: task!.id, taskStepKey: STEP_KEY, taskAttemptOrdinal: 0,
  }).returning({ id: aiAgentRuns.id }));

  return {
    partnerId: partner.id, orgId: org.id, siteId: site!.id, aId: a.id, bId: b.id,
    agentId: agent.id, partnerAgentId: partnerAgent.id, deviceId,
    runId: run!.id, taskId: task!.id,
  };
}

export function effect(
  ordinal: number, toolName: string, args: Record<string, unknown>,
  over: Partial<PlannedEffect> = {},
): PlannedEffect {
  return {
    ordinal, toolName, provider: 'google', targetId: TARGET_ID, accountExternalId: '101',
    canonicalArguments: args, ...over,
  };
}

export function defaultEffects(): PlannedEffect[] {
  return [
    effect(0, 'google_suspend_user', { reason: 'offboarding', userEmail: 'dana@customer.example' }),
    effect(1, 'google_remove_from_group', { groupEmail: 'sales@customer.example', reason: 'offboarding', userEmail: 'dana@customer.example' }),
    effect(2, 'google_remove_from_group', { groupEmail: 'eng@customer.example', reason: 'offboarding', userEmail: 'dana@customer.example' }),
  ];
}

export function labelsFor(effects: readonly PlannedEffect[]): Map<number, PlanEffectLabels> {
  return new Map(effects.map((e) => [e.ordinal, {
    targetLabel: 'Dana Example', principalLabel: 'dana@customer.example',
    rendering: `${e.toolName} #${e.ordinal}`,
  }]));
}

export function classesFor(
  effects: readonly PlannedEffect[], cls: AiOperatorEffectIdempotencyClass = 'idempotent',
): Map<number, AiOperatorEffectIdempotencyClass> {
  return new Map(effects.map((e) => [e.ordinal, cls]));
}

export async function propose(
  t: PlanTenant, effects: PlannedEffect[] = defaultEffects(),
  over: { planRevision?: number; cls?: AiOperatorEffectIdempotencyClass } = {},
): Promise<Extract<ProposePlanApprovalResult, { ok: true }> & { effects: PlannedEffect[] }> {
  const res = await proposePlanApproval({
    orgId: t.orgId, taskId: t.taskId, stepKey: STEP_KEY,
    planRevision: over.planRevision ?? PLAN_REVISION, requesterUserId: t.aId,
    effects, labels: labelsFor(effects), idempotencyClasses: classesFor(effects, over.cls),
  });
  if (!res.ok) throw new Error(`proposePlanApproval refused: ${res.reason} (${res.detail})`);
  return { ...res, effects };
}

export async function userAuth(t: PlanTenant, userId: string): Promise<AuthContext> {
  const auth = await buildTaskActorAuthContext({ orgId: t.orgId, partnerId: t.partnerId, userId });
  if (!auth) throw new Error('could not build user auth');
  return auth;
}

export async function approvalRequestsFor(intentId: string) {
  return system(() => db.select().from(approvalRequests).where(eq(approvalRequests.intentId, intentId)));
}

/**
 * The REAL approval path: B decides the plan intent's approval_requests row via
 * decideApprovalRequest, then the durable release worker claims the intent and
 * runs the `operator_plan` handler (markPlanApproved).
 */
export async function approveRealWay(t: PlanTenant, intentId: string): Promise<void> {
  const rows = await approvalRequestsFor(intentId);
  const mine = rows.find((r) => r.userId === t.bId);
  if (!mine) throw new Error(`no approval request for approver; rows=${rows.length}`);
  const auth = await userAuth(t, t.bId);
  const res = await asUser(auth, () => decideApprovalRequest({ auth, id: mine.id, status: 'approved' }));
  if (res.httpStatus !== 200) throw new Error(`decide failed: ${res.httpStatus} ${JSON.stringify(res.body)}`);
  await releaseApprovedIntent(intentId);
}

export async function readIntent(id: string) {
  const [row] = await system(() => db.select().from(actionIntents).where(eq(actionIntents.id, id)));
  return row!;
}
