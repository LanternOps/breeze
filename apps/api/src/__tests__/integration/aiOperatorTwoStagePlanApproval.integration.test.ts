/**
 * identity_onboarding's TWO-STAGE plan approval against real Postgres (W07
 * R2a Task 15 Step 4; Amendment B1, B5, B7; D-R2-1, D-R2-2, D-R2-6).
 *
 * Every case is driven from a REAL onboarding task's rows — the creation
 * approval at revision r and the provisioning approval at r+1, proposed by
 * the coordinator, decided and released the real way — except the propose
 * refusal, which uses the shared E4 fixtures. The membership predicate, the
 * mint path (`createActionIntent`), release revalidation, the decide path and
 * the reveal route (`POST /action-intents/:id/reveal-secret`, over real HTTP
 * with a real access token) are all production code. Providers and probes
 * are faked exactly as the E2E suite fakes them (`identityOnboardingHarness`).
 */
import './setup';
import { getTestDb } from './setup';

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

const fake = vi.hoisted(() => ({
  world: null as unknown as import('./identityOnboardingHarness').FakeWorld,
  googleConnId: null as string | null,
  probe: {} as import('./identityOnboardingHarness').FakeProviders['probe'],
  h: {} as Record<string, (...args: any[]) => any>,
}));

vi.mock('../../services/m365ControlPlane/readActionService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  executeM365ReadActionByOrg: (...a: unknown[]) => fake.h.m365Read!(...a),
}));
vi.mock('../../services/aiToolsGoogle', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveContextByOrg: (...a: unknown[]) => fake.h.googleContext!(...a),
}));
vi.mock('../../services/googleClient', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getDirectoryClient: (...a: unknown[]) => fake.h.directory!(...a),
  getLicensingClient: (...a: unknown[]) => fake.h.licensing!(...a),
}));
vi.mock('../../services/m365ControlPlane/graphActionsExecutorClient', () => ({
  createGraphActionsExecutorClient: () => ({ executeWriteAction: (...a: unknown[]) => fake.h.executeWriteAction!(...a) }),
  GraphActionsExecutorClientError: class GraphActionsExecutorClientError extends Error {},
}));
vi.mock('../../services/m365ControlPlane/writeActionRuntimeConfig', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadM365CustomerGraphActionsRuntimeConfig: () => ({
    clientId: 'test-client-id',
    vaultRef: 'akv://test-vault.example/m365-customer-graph-actions/00000000000000000000000000000000',
    credentialVersion: '00000000000000000000000000000000',
    executorUrl: 'https://executor.internal.example.test',
    executorAudience: 'm365-graph-actions-executor',
    executorSigningPrivateJwk: {},
    executorSigningKid: 'test-kid',
  }),
  isM365GraphActionsEnabledForOrg: () => true,
  m365GraphActionsAvailability: () => 'enabled',
}));

import { computeEffectSetDigest } from '@breeze/shared/canonicalize/effectSet';
import { db } from '../../db';
import { actionIntents, aiOperatorOperations, aiOperatorPlanApprovalEffects, aiOperatorPlanApprovals } from '../../db/schema';
import { createActionIntent } from '../../services/actionIntents/intentService';
import { buildTaskActorAuthContext } from '../../services/actionIntents/actorContext';
import { revalidateApprovedIntentForRelease } from '../../services/actionIntents/revalidateRelease';
import { canonicalizeArguments, computeArgumentDigest } from '../../services/actionIntents/canonicalize';
import { decideApprovalRequest } from '../../services/approvals/decideApprovalRequest';
import {
  checkPlanEffectMembershipSystem, planEffectOperationKey, proposePlanApproval, rowsToDigestProjection,
} from '../../services/aiOperator/planApproval';
import { isSecretBearingTool } from '../../services/actionIntents/secretBearingTools';
import {
  approvalRequestsFor, asUser, classesFor, effect as fixtureEffect, labelsFor, seedPlanTenant, userAuth,
  PLAN_REVISION, STEP_KEY,
} from './planApprovalFixtures';
import {
  CREATE_STEP, CREATED_M365_ID, FAKE_PASSWORD, PROVISION_STEP, SKU_E3,
  accessTokenFor, approvalFor, approvals, approve, asPlanTenant, bindFakeProviders, childIntents,
  driveToCreateProposed, driveToProvisionProposed, effectsFor, getTaskDetail, operations, pgCode, planIntents,
  readTask, releaseInFlight, resetFakes, revealSecret, seedTenant, system, wake, walk,
  type Admitted,
} from './identityOnboardingHarness';

bindFakeProviders(fake as never);

const runDb = it.runIf(!!process.env.DATABASE_URL);
const owner = () => getTestDb() as unknown as typeof db;
const REASON = 'Onboarding Priya Example (Breeze Operator task).';

beforeEach(() => {
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('AI_OPERATOR_TASKS_ENABLED', 'true');
  vi.stubEnv('AI_OPERATOR_RECIPE_IDENTITY_ONBOARDING_ENABLED', 'true');
  resetFakes();
});
afterEach(() => { vi.unstubAllEnvs(); });

async function readIntent(id: string) {
  const [row] = await system(() => db.select().from(actionIntents).where(eq(actionIntents.id, id)));
  return row!;
}

async function withTriggersDisabled(table: string, triggers: string[], fn: () => Promise<void>) {
  for (const trg of triggers) await owner().execute(sql.raw(`ALTER TABLE ${table} DISABLE TRIGGER ${trg}`));
  try { await fn(); } finally {
    for (const trg of triggers) await owner().execute(sql.raw(`ALTER TABLE ${table} ENABLE TRIGGER ${trg}`));
  }
}

async function mintAsApprover(a: Admitted, args: {
  toolName: string; input: Record<string, unknown>; ordinal: number; approvalId: string; stepKey: string; operationKey: string;
}) {
  const auth = await buildTaskActorAuthContext({ orgId: a.t.orgId, partnerId: a.t.partnerId, userId: a.t.approverId });
  return createActionIntent(auth!, {
    toolName: args.toolName, input: args.input, source: 'mcp_api', orgId: a.t.orgId, requestingClientLabel: 'AI Operator',
    task: { taskId: a.taskId, taskStepKey: args.stepKey, operationKey: args.operationKey, attemptOrdinal: 0 },
    planApproval: { approvalId: args.approvalId, ordinal: args.ordinal },
  });
}

/** A forged child: a clone of a REAL minted child with another tool name (owner connection, so no app-layer gate). */
async function forgedClone(childId: string, actionName: string, args: Record<string, unknown>) {
  const real = await readIntent(childId);
  const [forged] = await owner().insert(actionIntents).values({
    ...real, id: randomUUID(), idempotencyKey: `forged-${randomUUID()}`, actionName,
    arguments: args, argumentDigest: computeArgumentDigest(canonicalizeArguments(args)),
  }).returning();
  return forged!;
}

/** The membership input for one sealed row of `stepKey`, as the child for it would carry. */
async function membershipFor(a: Admitted, stepKey: string, ordinal = 0) {
  const row = (await effectsFor(a, stepKey)).find((e) => e.ordinal === ordinal)!;
  return {
    orgId: a.t.orgId, taskId: a.taskId, ordinal, toolName: row.toolName, argumentDigest: row.argumentDigest,
    taskStepKey: stepKey, approvalId: row.approvalId,
    operationKey: planEffectOperationKey({ stepKey, planRevision: row.planRevision, toolName: row.toolName, targetId: row.targetId, ordinal }),
  };
}

describe('two-stage plan approval (identity_onboarding)', () => {
  runDb('1. two approvals at two revisions; the (task, revision) unique index rejects a third at either; disjoint, single-kind sets', async () => {
    const t = await seedTenant({ google: false });
    const a = await driveToCreateProposed(t);
    await approve(a, CREATE_STEP);
    // At revision r, before the bump: the create set is ALL secret-bearing.
    await expect(checkPlanEffectMembershipSystem(await membershipFor(a, CREATE_STEP)))
      .resolves.toMatchObject({ ok: true, setSecrecy: 'all_secret_bearing' });
    await walk(a, CREATE_STEP);
    await wake(a); // resolve_accounts: r -> r+1
    await wake(a); // provision_effects proposes
    await approve(a, PROVISION_STEP);
    await expect(checkPlanEffectMembershipSystem(await membershipFor(a, PROVISION_STEP)))
      .resolves.toMatchObject({ ok: true, setSecrecy: 'none_secret_bearing' });

    const rows = await approvals(a);
    expect(rows.map((x) => `${x.stepKey}@${x.planRevision}:${x.state}`))
      .toEqual([`${CREATE_STEP}@${rows[0]!.planRevision}:superseded`, `${PROVISION_STEP}@${rows[0]!.planRevision + 1}:approved`]);
    for (const existing of rows) {
      const err = await owner().insert(aiOperatorPlanApprovals).values({
        ...existing, id: randomUUID(), intentId: null, state: 'pending', approvedByUserId: null, approvedAt: null,
        supersededByRevision: null, approvedAssuranceLevel: null,
      } as never).then(() => null, (e: unknown) => e);
      expect(pgCode(err), `a third approval at revision ${existing.planRevision}`).toBe('23505');
      const constraint = (err as { cause?: { constraint_name?: string }; constraint_name?: string });
      expect(constraint.cause?.constraint_name ?? constraint.constraint_name).toBe('ai_operator_plan_approvals_task_revision_uq');
    }
    const createTools = (await effectsFor(a, CREATE_STEP)).map((e) => e.toolName);
    const provisionTools = (await effectsFor(a, PROVISION_STEP)).map((e) => e.toolName);
    expect(createTools).toEqual(['m365_create_user']);
    expect(provisionTools).toEqual(['m365_assign_license', 'm365_add_to_group']);
    expect(createTools.filter((x) => provisionTools.includes(x))).toEqual([]);
    expect(createTools.every(isSecretBearingTool)).toBe(true);
    expect(provisionTools.some(isSecretBearingTool)).toBe(false);
  }, 180_000);

  runDb('2. a MIXED set is refused at propose (mixed_secret_bearing, nothing written); an all-secret and an all-ordinary set both propose', async () => {
    const tools = ['m365_create_user', 'm365_assign_license'];
    const t = await seedPlanTenant({ snapshotAllowlist: tools, liveAllowlist: tools });
    const create = fixtureEffect(0, 'm365_create_user', { userPrincipalName: 'priya@customer.example', displayName: 'Priya Example', mailNickname: 'priya', usageLocation: 'US', reason: REASON }, { provider: 'm365', accountExternalId: null });
    const assign = fixtureEffect(1, 'm365_assign_license', { userIdentifier: CREATED_M365_ID, skuIds: [SKU_E3], reason: REASON }, { provider: 'm365', accountExternalId: CREATED_M365_ID });
    const propose = (effects: ReturnType<typeof fixtureEffect>[], planRevision: number) => proposePlanApproval({
      orgId: t.orgId, taskId: t.taskId, stepKey: STEP_KEY, planRevision, requesterUserId: t.aId,
      effects, labels: labelsFor(effects), idempotencyClasses: classesFor(effects, 'non_idempotent'),
    });
    expect(await propose([create, assign], PLAN_REVISION)).toMatchObject({ ok: false, reason: 'mixed_secret_bearing' });
    expect(await system(() => db.select().from(aiOperatorPlanApprovals).where(eq(aiOperatorPlanApprovals.taskId, t.taskId)))).toHaveLength(0);
    expect(await propose([create], PLAN_REVISION)).toMatchObject({ ok: true });
  }, 120_000);

  runDb('3. an ORDINARY tool cannot ride the creation approval: refused at mint and at release', async () => {
    const t = await seedTenant({ google: false });
    const a = await driveToCreateProposed(t);
    await approve(a, CREATE_STEP);
    await wake(a); // the coordinator mints the create child
    const [child] = await childIntents(a);
    expect(child).toMatchObject({ actionName: 'm365_create_user', status: 'approved', decidedVia: 'plan_approval' });
    const m = await membershipFor(a, CREATE_STEP);
    expect((await revalidateApprovedIntentForRelease(child!, null)).ok, 'control: the real child releases').toBe(true);

    const ordinary = { userIdentifier: CREATED_M365_ID, skuIds: [SKU_E3], reason: REASON };
    const opsBefore = (await operations(a)).length;
    await expect(mintAsApprover(a, {
      toolName: 'm365_assign_license', input: ordinary, ordinal: 0, approvalId: m.approvalId, stepKey: CREATE_STEP, operationKey: m.operationKey,
    })).rejects.toMatchObject({ code: 'plan_approval_invalid', message: expect.stringMatching(/tool_not_in_set/) });
    expect(await operations(a)).toHaveLength(opsBefore);

    const forged = await forgedClone(child!.id, 'm365_assign_license', ordinary);
    const res = await revalidateApprovedIntentForRelease(forged, null);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errorCode).toBe('plan_approval_revoked');
      expect(res.details?.refusal).toBe('tool_not_in_set');
    }
  }, 180_000);

  runDb('4. the CREATE tool cannot ride the provisioning approval: refused at mint and at release', async () => {
    const t = await seedTenant({ google: false });
    const a = await driveToProvisionProposed(t);
    await approve(a, PROVISION_STEP);
    await wake(a); // mints provisioning ordinal 0
    const child = (await childIntents(a)).find((i) => i.taskStepKey === PROVISION_STEP)!;
    expect(child).toMatchObject({ actionName: 'm365_assign_license', status: 'approved' });
    expect((await revalidateApprovedIntentForRelease(child, null)).ok, 'control: the real child releases').toBe(true);

    const m = await membershipFor(a, PROVISION_STEP);
    const createArgs = { userPrincipalName: 'second@customer.example', displayName: 'Priya Example', mailNickname: 'second', usageLocation: 'US', reason: REASON };
    await expect(mintAsApprover(a, {
      toolName: 'm365_create_user', input: createArgs, ordinal: 0, approvalId: m.approvalId, stepKey: PROVISION_STEP, operationKey: m.operationKey,
    })).rejects.toMatchObject({ code: 'plan_approval_invalid', message: expect.stringMatching(/tool_not_in_set/) });
    expect((await childIntents(a)).filter((i) => i.actionName === 'm365_create_user')).toHaveLength(1);

    const forged = await forgedClone(child.id, 'm365_create_user', createArgs);
    const res = await revalidateApprovedIntentForRelease(forged, null);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errorCode).toBe('plan_approval_revoked');
      expect(res.details?.refusal).toBe('tool_not_in_set');
    }
  }, 180_000);

  runDb('5. a forged, RE-SEALED mixed creation set is refused for both kinds at mint and at release: mixed_secret_bearing', async () => {
    const t = await seedTenant({ google: false });
    const a = await driveToCreateProposed(t);
    await approve(a, CREATE_STEP);
    await wake(a); // mints the create child
    const [child] = await childIntents(a);
    const approval = (await approvalFor(a, CREATE_STEP))!;
    const [row] = await effectsFor(a, CREATE_STEP);
    const ordinaryArgs = { userIdentifier: CREATED_M365_ID, skuIds: [SKU_E3], reason: REASON };
    const added = {
      ...row!, id: randomUUID(), ordinal: 1, toolName: 'm365_assign_license', accountExternalId: CREATED_M365_ID,
      argumentDigest: computeArgumentDigest(canonicalizeArguments(ordinaryArgs)), rendering: 'Assign Microsoft 365 license',
    };
    const all = [row!, added];
    const digest = computeEffectSetDigest({ taskId: a.taskId, planRevision: approval.planRevision, effects: rowsToDigestProjection(all) });
    await withTriggersDisabled('ai_operator_plan_approval_effects', ['ai_operator_plan_approval_effects_closed_set'], async () => {
      await owner().insert(aiOperatorPlanApprovalEffects).values(added as never);
    });
    await withTriggersDisabled('ai_operator_plan_approvals', ['ai_operator_plan_approvals_immutable_trg'], async () => {
      await owner().update(aiOperatorPlanApprovals).set({ effectCount: 2, effectSetDigest: digest } as never)
        .where(eq(aiOperatorPlanApprovals.id, approval.id));
    });

    const m = await membershipFor(a, CREATE_STEP, 0);
    await expect(checkPlanEffectMembershipSystem(m)).resolves.toMatchObject({ ok: false, refusal: 'mixed_secret_bearing' });
    await expect(checkPlanEffectMembershipSystem(await membershipFor(a, CREATE_STEP, 1)))
      .resolves.toMatchObject({ ok: false, refusal: 'mixed_secret_bearing' });
    const ordinaryKey = planEffectOperationKey({ stepKey: CREATE_STEP, planRevision: approval.planRevision, toolName: 'm365_assign_license', targetId: row!.targetId, ordinal: 1 });
    await expect(mintAsApprover(a, {
      toolName: 'm365_assign_license', input: ordinaryArgs, ordinal: 1, approvalId: approval.id, stepKey: CREATE_STEP, operationKey: ordinaryKey,
    })).rejects.toMatchObject({ code: 'plan_approval_invalid', message: expect.stringMatching(/mixed_secret_bearing/) });
    const res = await revalidateApprovedIntentForRelease(child!, null);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errorCode).toBe('plan_approval_revoked');
      expect(res.details?.refusal).toBe('mixed_secret_bearing');
    }
    // And the real release path refuses it: nothing is sent to the executor.
    await releaseInFlight(a);
    expect(fake.world.m365.createCalls).toBe(0);
    expect(await readIntent(child!.id)).toMatchObject({ status: 'failed', errorCode: 'plan_approval_revoked' });
  }, 180_000);

  runDb('6. four eyes: the requester cannot approve the creation of the account they asked for', async () => {
    const t = await seedTenant({ google: false });
    const a = await driveToCreateProposed(t);
    const [planIntent] = await planIntents(a);
    expect(planIntent!.requestedByUserId).toBe(t.requesterId);
    const rows = await approvalRequestsFor(planIntent!.id);
    expect(rows.some((r) => r.userId === t.approverId)).toBe(true);
    expect(rows.some((r) => r.userId === t.requesterId), 'no approval request is addressed to the requester').toBe(false);
    await expect(approve({ ...a, t: { ...t, approverId: t.requesterId } }, CREATE_STEP)).rejects.toThrow(/no approval request for approver/);
    const requesterAuth = await userAuth(asPlanTenant(t), t.requesterId);
    const theirs = rows.find((r) => r.userId === t.approverId)!;
    const res = await asUser(requesterAuth, () => decideApprovalRequest({ auth: requesterAuth, id: theirs.id, status: 'approved' }));
    expect(res).toMatchObject({ httpStatus: 404 });
    expect(await approvalFor(a, CREATE_STEP)).toMatchObject({ state: 'pending', approvedByUserId: null });
    await wake(a);
    expect(await childIntents(a)).toHaveLength(0);
  }, 120_000);

  runDb('7. the stale creation child cannot be released after r → r+1: refused from the rows', async () => {
    const t = await seedTenant({ google: false });
    const a = await driveToProvisionProposed(t);
    const createChild = (await childIntents(a)).find((i) => i.actionName === 'm365_create_user')!;
    const createApproval = (await approvals(a)).find((x) => x.stepKey === CREATE_STEP)!;
    expect(createApproval.state).toBe('superseded');
    // Named (the mint path): the creation approval reports itself superseded.
    await expect(checkPlanEffectMembershipSystem({ ...(await membershipFor(a, CREATE_STEP)), approvalId: createApproval.id }))
      .resolves.toMatchObject({ ok: false, refusal: 'plan_superseded' });
    // The release path, on a re-armed copy of that very child: refused.
    const replay = { ...createChild, status: 'approved' as const };
    const res = await revalidateApprovedIntentForRelease(replay as never, null);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errorCode).toBe('plan_approval_revoked');
      // Unnamed, release looks at the LIVE revision r+1, whose approval is still pending.
      expect(res.details?.refusal).toBe('plan_not_approved');
    }
    // Once r+1 IS approved, the stale create child still finds nothing to ride on.
    await approve(a, PROVISION_STEP);
    const later = await revalidateApprovedIntentForRelease(replay as never, null);
    expect(later.ok).toBe(false);
    if (!later.ok) {
      expect(later.errorCode).toBe('plan_approval_revoked');
      expect(later.details?.refusal).toBe('tool_not_in_set');
    }
  }, 180_000);

  // ── D-R2-6, pinned both ways through the REAL HTTP route ────────────────
  runDb('8. D-R2-6: the create child is requested BY THE APPROVER; the technician gets 403, the approver reveals exactly once; GET /tasks/:id accounts available → revealed', async () => {
    const t = await seedTenant({ google: false });
    const a = await driveToProvisionProposed(t);
    const createChild = (await childIntents(a)).find((i) => i.actionName === 'm365_create_user')!;
    expect(createChild).toMatchObject({ status: 'completed', requestedByUserId: t.approverId, decidedByUserId: t.approverId });
    expect(createChild.requestedByUserId).not.toBe((await readTask(a)).requesterUserId);

    const requesterToken = await accessTokenFor(t, t.requesterId);
    const approverToken = await accessTokenFor(t, t.approverId);

    const before = await getTaskDetail(a.taskId, requesterToken);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body.data.accounts).toEqual([expect.objectContaining({
      provider: 'm365', externalId: CREATED_M365_ID, credentialState: 'available', intentId: createChild.id,
      revealableByUserId: t.approverId, revealableByName: t.approverName,
    })]);
    expect(JSON.stringify(before.body)).not.toContain(FAKE_PASSWORD);

    const technician = await revealSecret(createChild.id, requesterToken);
    expect(technician.status).toBe(403);
    expect(JSON.stringify(technician.body)).not.toContain(FAKE_PASSWORD);

    const first = await revealSecret(createChild.id, approverToken);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data).toMatchObject({ temporaryPassword: FAKE_PASSWORD, userId: CREATED_M365_ID, forceChangeNextSignIn: true });
    const second = await revealSecret(createChild.id, approverToken);
    expect(second.status).not.toBe(200);
    expect(JSON.stringify(second.body)).not.toContain(FAKE_PASSWORD);

    const after = await getTaskDetail(a.taskId, requesterToken);
    expect(after.body.data.accounts).toEqual([expect.objectContaining({
      provider: 'm365', credentialState: 'revealed', revealableByUserId: null,
    })]);
    expect(JSON.stringify((await readIntent(createChild.id)).result)).not.toContain(FAKE_PASSWORD);
    // And the operation row never held the plaintext either.
    const [createOp] = await system(() => db.select().from(aiOperatorOperations)
      .where(and(eq(aiOperatorOperations.taskId, a.taskId), eq(aiOperatorOperations.intentId, createChild.id))));
    expect(JSON.stringify(createOp!.result)).not.toContain(FAKE_PASSWORD);
  }, 180_000);
});
