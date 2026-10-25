/**
 * identity_onboarding — the deterministic release gate's real-Postgres half
 * (spec §9 clauses (a, real rows), (b) and (c); W07 plan Task 24 as amended
 * 2026-10-25 by B.9; wave #6172, PR R2c).
 *
 * (b) STAGING OVER DISPATCH STOPPING POINTS. R2a proved staging about the
 * PLANS (recipes/identityOnboarding.staging.test.ts) and about one happy-path
 * RUN (aiOperatorIdentityOnboardingE2E). This file proves it about every
 * independent stopping point of a real dispatch: for each k, a fresh tenant and
 * task are driven through the real coordinator until exactly k effects of a
 * stage have settled, and the rows must show no provisioning before the
 * create stage has finished and `resolve_accounts` has frozen the account,
 * and a plan-order prefix (Google before Microsoft 365) inside stage 2.
 *
 * (c) TWO-STAGE PLAN-APPROVAL MEMBERSHIP. The two approvals are the
 * `create_accounts` effect step's at revision r and the `provision_effects`
 * effect step's at r+1 (B1). Every case is driven from a real onboarding
 * task's rows and a coordinator-minted child. aiOperatorTwoStagePlanApproval
 * (R2a) already pins the cross-stage tool riding (an ordinary tool on the
 * creation approval, the create on the provisioning approval), the re-sealed
 * mixed set, and D-R2-6's reveal; this file adds the per-stage membership
 * clauses spec §9(c) names.
 *
 * CANCEL CASES (3, 4) are BLOCKED on #9979: there is no task-cancel path for
 * recipe tasks. They are written skipped, as R1c skipped its cancel case.
 * Case 4's unblocked twin (a forced `no_account_resolved` hand-off between
 * the stages) is not skipped.
 *
 * WHAT IS FAKED: exactly what the onboarding E2E fakes (the model's completed
 * runs, the providers' reads and the M365 executor's HTTP client, the effect
 * probes, a Google child's release), through `identityOnboardingHarness.ts`.
 * The coordinator, admission, readiness, the four-eyes decide + release, the
 * membership predicate, `revalidateApprovedIntentForRelease`,
 * `computeEffectDigestForRelease`, `bumpPlanRevision`, the M365 write ladder
 * and the seal are production code. Runs as `breeze_app` via ./setup.
 */
import './setup';
import { getTestDb } from './setup';

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
import { db, runOutsideDbContext } from '../../db';
import {
  actionIntents, aiAgentRuns, aiAgents, aiOperatorPlanApprovalEffects, aiOperatorPlanApprovals, aiSessions, aiToolExecutions,
} from '../../db/schema';
import { createActionIntent } from '../../services/actionIntents/intentService';
import { buildTaskActorAuthContext } from '../../services/actionIntents/actorContext';
import { revalidateApprovedIntentForRelease } from '../../services/actionIntents/revalidateRelease';
import { computeEffectDigestForRelease } from '../../services/actionIntents/effectDigest';
import { canonicalizeArguments, computeArgumentDigest } from '../../services/actionIntents/canonicalize';
import { isSecretBearingTool } from '../../services/actionIntents/secretBearingTools';
import { decideApprovalRequest } from '../../services/approvals/decideApprovalRequest';
import { releaseApprovedIntent } from '../../jobs/intentReleaseWorker';
import { checkPlanEffectMembershipSystem, planEffectOperationKey, rowsToDigestProjection } from '../../services/aiOperator/planApproval';
import { IDENTITY_ONBOARDING_PROVISION_TOOLS } from '../../services/aiOperator/recipes/identityOnboarding';
import { approvalRequestsFor, approveRealWay, asUser, userAuth } from './planApprovalFixtures';
import {
  CATALOG, CREATE_STEP, CREATED_M365_ID, FAKE_PASSWORD, PROVISION_STEP, SKU_E3, UPN,
  accessTokenFor, approvalFor, approvals, approve, asPlanTenant, bindFakeProviders, childIntents,
  completeManualCreateGoogle, driveToCreateProposed, driveToProvisionProposed, effectsFor, getTaskDetail, operations,
  planIntents, planKeys, plaintextLeaks, policySnapshot, readTask, releaseInFlight, resetFakes, revealSecret, seedTenant,
  system, targetAccounts, wake, walk, world,
  type Admitted, type PlanKey,
} from './identityOnboardingHarness';

bindFakeProviders(fake as never);

const runDb = it.runIf(!!process.env.DATABASE_URL);
const skipDb = it.skip;
const owner = () => getTestDb() as unknown as typeof db;
const REASON = 'Onboarding Priya Example (Breeze Operator task).';

/**
 * The plans the seeded tenant produces. A change to either is loud here
 * rather than a silently shorter loop.
 *  - stage 1: `m365_create_user` (Google has no create tool; D-R2-3);
 *  - stage 2 with Google in scope: the three Google effects, then the two M365 ones.
 */
const CREATE_PLAN_LENGTH = 1;
const PROVISION_PLAN = ['google_move_ou', 'google_assign_license', 'google_add_to_group', 'm365_assign_license', 'm365_add_to_group'] as const;

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

async function revalidate(intentId: string) {
  return revalidateApprovedIntentForRelease(await readIntent(intentId), null);
}

function keyFor(stepKey: string, row: { planRevision: number; toolName: string; targetId: string | null; ordinal: number }, ordinal = row.ordinal) {
  return planEffectOperationKey({ stepKey, planRevision: row.planRevision, toolName: row.toolName, targetId: row.targetId, ordinal });
}

/** The creation approval approved and its one child minted by the real walk (not yet released). */
async function createChildMinted(opts: { google?: boolean } = {}) {
  const t = await seedTenant({ google: opts.google ?? false });
  const a = await driveToCreateProposed(t, { google: opts.google ?? false });
  await approve(a, CREATE_STEP);
  await wake(a); // mints m365_create_user as the approver
  const [child] = await childIntents(a);
  expect(child).toMatchObject({ actionName: 'm365_create_user', status: 'approved', decidedVia: 'plan_approval', taskStepKey: CREATE_STEP });
  const approval = (await approvalFor(a, CREATE_STEP))!;
  return { t, a, child: child!, approval };
}

/** The provisioning approval approved and its first child minted by the real walk (not yet released). */
async function provisionChildMinted() {
  const t = await seedTenant({ google: false });
  const a = await driveToProvisionProposed(t);
  await approve(a, PROVISION_STEP);
  await wake(a); // mints provisioning ordinal 0 as the approver
  const child = (await childIntents(a)).find((i) => i.taskStepKey === PROVISION_STEP)!;
  expect(child).toMatchObject({ actionName: 'm365_assign_license', status: 'approved', decidedVia: 'plan_approval' });
  const approval = (await approvalFor(a, PROVISION_STEP))!;
  return { t, a, child, approval };
}

const stageOps = async (a: Admitted, stepKey: string) => (await operations(a)).filter((o) => o.taskStepKey === stepKey);

// ---------------------------------------------------------------------------
// (a) on real rows: the create is issued once, ever
// ---------------------------------------------------------------------------

describe('(a) on real rows: m365_create_user is issued at most once', () => {
  runDb('re-waking and RE-RELEASING the create child never reaches the executor a second time: one operation row, one child, one executor call', async () => {
    const { a } = await createChildMinted();
    await releaseInFlight(a);
    expect(world().m365.createCalls).toBe(1);
    const [op] = await stageOps(a, CREATE_STEP);
    expect(op).toMatchObject({ resultState: 'succeeded' });
    const [child] = await childIntents(a);
    expect(child!.status).toBe('completed');

    // The durable release replayed for the same intent (a redelivered job).
    await runOutsideDbContext(() => releaseApprovedIntent(child!.id));
    // Forced re-wakes of the task.
    for (let i = 0; i < 3; i += 1) {
      await system(() => db.execute(sql`UPDATE ai_operator_tasks SET next_wake_at = now() WHERE id = ${a.taskId}`));
      await wake(a);
    }
    expect(world().m365.createCalls, 'the executor saw exactly one create').toBe(1);
    expect((await childIntents(a)).filter((i) => i.actionName === 'm365_create_user')).toHaveLength(1);
    expect(await stageOps(a, CREATE_STEP), 'one create operation row, ever').toHaveLength(1);
    expect(world().m365.users.filter((u) => u.upn === UPN)).toHaveLength(1);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// (b) staging over every dispatch stopping point
// ---------------------------------------------------------------------------

describe('(b) staging: no provisioning before the account exists and is frozen', () => {
  for (let k = 0; k <= CREATE_PLAN_LENGTH; k += 1) {
    runDb(`stage 1, stop after ${k} settled create effect(s): no provisioning approval, no provisioning effect, no frozen account`, async () => {
      const t = await seedTenant({ google: false });
      const a = await driveToCreateProposed(t);
      const plan = await planKeys(a, CREATE_STEP);
      expect(plan.map((p) => p.toolName), 'the creation plan').toEqual(['m365_create_user']);
      expect(plan).toHaveLength(CREATE_PLAN_LENGTH);
      await approve(a, CREATE_STEP);
      await walk(a, CREATE_STEP, { stopAfterOps: k });

      const ops = await stageOps(a, CREATE_STEP);
      expect(ops, `exactly ${k} create operation(s)`).toHaveLength(k);
      expect(ops.every((o) => o.resultState === 'succeeded')).toBe(true);
      expect(world().m365.createCalls).toBe(k);
      const assertNothingProvisioned = async (when: string) => {
        expect(await approvalFor(a, PROVISION_STEP), `${when}: no provisioning approval`).toBeNull();
        expect(await stageOps(a, PROVISION_STEP), `${when}: no provisioning operation`).toHaveLength(0);
        expect((await childIntents(a)).some((i) => i.taskStepKey === PROVISION_STEP), `${when}: no provisioning child`).toBe(false);
        expect(await targetAccounts(a), `${when}: nothing frozen`).toHaveLength(0);
      };
      await assertNothingProvisioned(`k=${k}`);
      if (k < CREATE_PLAN_LENGTH) return;

      // The full create stage settled. Drive on wake by wake: the account is
      // frozen only by resolve_accounts, and the provisioning plan is proposed
      // only after that, at r+1.
      const r = (await readTask(a)).revision;
      await wake(a); // verifies the create and leaves the step
      expect((await readTask(a)).currentStepKey).toBe('resolve_accounts');
      await assertNothingProvisioned('at resolve_accounts');
      await wake(a); // resolve_accounts: freeze, bump r -> r+1
      const moved = await readTask(a);
      expect(moved).toMatchObject({ currentStepKey: PROVISION_STEP, revision: r + 1 });
      expect((await targetAccounts(a)).map((x) => `${x.provider}:${x.externalId}`)).toEqual([`m365:${CREATED_M365_ID}`]);
      expect(await approvalFor(a, PROVISION_STEP), 'frozen, but not yet proposed').toBeNull();
      await wake(a); // provision_effects proposes
      expect(await approvalFor(a, PROVISION_STEP)).toMatchObject({ state: 'pending', planRevision: r + 1 });
      expect(await stageOps(a, PROVISION_STEP)).toHaveLength(0);
    }, 180_000);
  }

  runDb('stage 1 with Google in scope: after the create settles, nothing is provisioned until the hand-made Google account is ticked', async () => {
    const t = await seedTenant();
    const a = await driveToCreateProposed(t, { google: true });
    await approve(a, CREATE_STEP);
    await walk(a, CREATE_STEP);
    expect((await readTask(a)).currentStepKey).toBe('manual_create_google');
    for (let i = 0; i < 3; i += 1) await wake(a); // opens the item, then waits on it
    expect((await readTask(a)).currentStepKey).toBe('manual_create_google');
    expect(await approvalFor(a, PROVISION_STEP)).toBeNull();
    expect(await targetAccounts(a)).toHaveLength(0);
    // Tick, then resolve: both accounts frozen together.
    await wake(a);
    await completeManualCreateGoogle(a);
    await wake(a);
    expect((await targetAccounts(a)).map((x) => x.provider).sort()).toEqual(['google', 'm365']);
  }, 180_000);

  for (let k = 0; k <= PROVISION_PLAN.length; k += 1) {
    runDb(`stage 2, stop after ${k} settled provisioning effect(s): a plan-order prefix, Google before Microsoft 365, accounts and the create unchanged`, async () => {
      const t = await seedTenant();
      const a = await driveToProvisionProposed(t, { google: true });
      const plan = await planKeys(a, PROVISION_STEP);
      expect(plan.map((p) => p.toolName), 'the provisioning plan').toEqual([...PROVISION_PLAN]);
      const accountsBefore = (await targetAccounts(a)).map((x) => `${x.provider}:${x.externalId}:${x.principalLabel}`).sort();
      expect(accountsBefore).toHaveLength(2);
      await approve(a, PROVISION_STEP);
      await walk(a, PROVISION_STEP, { stopAfterOps: k });

      const ops = await stageOps(a, PROVISION_STEP);
      const settled = new Set(ops.filter((o) => o.resultState === 'succeeded').map((o) => o.operationKey));
      expect(ops, `exactly ${k} provisioning operation(s)`).toHaveLength(k);
      expect(settled.size, `all ${k} settled`).toBe(k);
      expect([...settled].sort(), 'a prefix of the approved plan').toEqual(plan.slice(0, k).map((p) => p.key).sort());
      const googleKeys = plan.filter((p: PlanKey) => p.provider === 'google').map((p) => p.key);
      if (plan.some((p) => p.provider === 'm365' && settled.has(p.key))) {
        for (const g of googleKeys) expect(settled.has(g), 'an M365 effect settled before every Google effect had').toBe(true);
      }
      // The stage-1 world is untouched by stage 2.
      expect((await targetAccounts(a)).map((x) => `${x.provider}:${x.externalId}:${x.principalLabel}`).sort()).toEqual(accountsBefore);
      expect(await stageOps(a, CREATE_STEP)).toHaveLength(1);
      expect(world().m365.createCalls).toBe(1);
    }, 180_000);
  }

  // BUG (#9979, missing surface): there is no task-cancel path for recipe
  // tasks. taskTransitions.ts declares `stop` / `settle_cancelled`, but no
  // service, route or job writes them, and a task in `stopping` still mints
  // its next child. Cases 3 and 4 therefore cannot be exercised until #9979
  // is fixed. Case 4's unblocked twin follows.
  skipDb('3. cancelled at each k (both stages): the hand-off names the remaining ordinals, no operation settles after the cancel, and no create is re-minted [BLOCKED #9979]', async () => {
    // Intentionally empty: see the BUG note above.
  });
  skipDb('4. cancelled between the stages (after create_accounts settles, before resolve_accounts): a usable account and a hand-off naming what remains [BLOCKED #9979]', async () => {
    // Intentionally empty: see the BUG note above.
  });

  runDb('4-twin. a forced no_account_resolved hand-off BETWEEN the stages leaves a usable account: no bump, nothing provisioned, the hand-off names the account and what remains, and the approver can still reveal its credential', async () => {
    const t = await seedTenant({ google: false });
    const a = await driveToCreateProposed(t);
    await approve(a, CREATE_STEP);
    await walk(a, CREATE_STEP);
    expect((await readTask(a)).currentStepKey).toBe('resolve_accounts');
    const r = (await readTask(a)).revision;
    // The account exists at the provider; from here its read-back is refused.
    expect(world().m365.users.map((u) => u.id)).toEqual([CREATED_M365_ID]);
    const realRead = fake.h.m365Read!;
    fake.h.m365Read = async (orgId: string, action: { type: string }) => (action.type === 'm365.user.get'
      ? { ok: false, code: 'graph_forbidden', message: 'insufficient privileges' }
      : realRead(orgId, action));
    try {
      await wake(a); // resolve_accounts
    } finally {
      fake.h.m365Read = realRead;
    }
    const task = await readTask(a);
    expect(task).toMatchObject({ state: 'handed_off', currentStepKey: 'resolve_accounts', revision: r });
    expect(task.outcomeDetail).toMatch(/resolve_accounts: no_account_resolved/);
    // The hand-off says which account was created and what was NOT done.
    expect(task.handoffSummary).toContain('did not go on to licences and groups');
    expect(task.handoffSummary).toContain('Reading the created Microsoft 365 user failed');
    expect(task.handoffSummary).toContain('Microsoft 365: account_read_failed');
    // Nothing after the create: no bump, no freeze, no provisioning.
    expect((await approvalFor(a, CREATE_STEP))!.state, 'the creation approval is not superseded').toBe('approved');
    expect(await approvalFor(a, PROVISION_STEP)).toBeNull();
    expect(await stageOps(a, PROVISION_STEP)).toHaveLength(0);
    expect(await targetAccounts(a)).toHaveLength(0);
    // Further wakes change nothing and create nothing.
    await wake(a);
    expect(world().m365.createCalls).toBe(1);
    expect(await childIntents(a)).toHaveLength(1);
    // USABLE: the credential is sealed on the create child, on the ledger
    // (#10150) and revealable once by the creation's approver.
    const [createChild] = await childIntents(a);
    const ledger = await system(() => db.select({ execution: aiToolExecutions, session: aiSessions }).from(aiToolExecutions)
      .innerJoin(aiSessions, eq(aiSessions.id, aiToolExecutions.sessionId))
      .where(eq(aiToolExecutions.intentId, createChild!.id)));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.session).toMatchObject({ type: 'ai_operator', userId: t.approverId });
    // AS BUILT (reported for Todd): the task page's accounts panel lists FROZEN
    // accounts only, so it is empty here; the reveal path is the AI activity feed.
    const detail = await getTaskDetail(a.taskId, await accessTokenFor(t, t.requesterId));
    expect(detail.status).toBe(200);
    expect(detail.body.data.accounts).toEqual([]);
    const revealed = await revealSecret(createChild!.id, await accessTokenFor(t, t.approverId));
    expect(revealed.status, JSON.stringify(revealed.body)).toBe(200);
    expect(revealed.body.data).toMatchObject({ temporaryPassword: FAKE_PASSWORD, userId: CREATED_M365_ID });
    expect(await plaintextLeaks(a, FAKE_PASSWORD)).toEqual([]);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// (c) two-stage plan-approval membership
// ---------------------------------------------------------------------------

describe('(c) plan-approval membership for identity_onboarding, both stages', () => {
  runDb('5. an in-set effect minted by the coordinator releases — at create_accounts (r) and at provision_effects (r+1)', async () => {
    const created = await createChildMinted();
    expect(created.child).toMatchObject({
      requestedByUserId: created.t.approverId, decidedByUserId: created.t.approverId,
      operationKey: (await planKeys(created.a, CREATE_STEP))[0]!.key,
    });
    expect((await revalidate(created.child.id)).ok, 'the create child releases').toBe(true);

    const provisioned = await provisionChildMinted();
    expect(provisioned.child.operationKey).toBe((await planKeys(provisioned.a, PROVISION_STEP))[0]!.key);
    const res = await revalidate(provisioned.child.id);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(provisioned.approval.planRevision).toBe(created.approval.planRevision + 1);
  }, 240_000);

  runDb('6. the intent\'s argument row mutated after mint is refused AT RELEASE (argument_digest_mismatch) — both stages, and the create never reaches the executor', async () => {
    const cases = [
      { built: await createChildMinted(), tamper: { userPrincipalName: 'someone-else@customer.example' } },
      { built: await provisionChildMinted(), tamper: { userIdentifier: '00000000-0000-4000-8000-0000000a0777' } },
    ];
    for (const { built, tamper } of cases) {
      const { child } = built;
      expect((await revalidate(child.id)).ok, `${child.actionName}: control`).toBe(true);
      const tampered = { ...(child.arguments as Record<string, unknown>), ...tamper };
      await withTriggersDisabled('action_intents', ['action_intents_immutable_trg'], async () => {
        await owner().update(actionIntents).set({
          arguments: tampered, argumentDigest: computeArgumentDigest(canonicalizeArguments(tampered)),
        }).where(eq(actionIntents.id, child.id));
      });
      const res = await revalidate(child.id);
      expect(res.ok, child.actionName).toBe(false);
      if (!res.ok) {
        expect(res.errorCode).toBe('plan_approval_revoked');
        expect(res.details?.refusal).toBe('argument_digest_mismatch');
      }
    }
    // The real release path on the tampered create: nothing is sent. (The
    // fake tenant is shared by both seeded orgs in this case, and the second
    // org's stage 1 already created its own account, so count the delta.)
    const createdA = cases[0]!.built.a;
    const callsBefore = world().m365.createCalls;
    await releaseInFlight(createdA);
    expect(world().m365.createCalls, 'the tampered create never reached the executor').toBe(callsBefore);
    expect(await readIntent(cases[0]!.built.child.id)).toMatchObject({ status: 'failed', errorCode: 'plan_approval_revoked' });
  }, 240_000);

  runDb('7. an ordinal outside the approved set is refused at mint and at release (effect_not_in_set) — both stages', async () => {
    for (const built of [await createChildMinted(), await provisionChildMinted()]) {
      const { a, child, approval } = built;
      const stepKey = approval.stepKey;
      const [row] = await effectsFor(a, stepKey);
      const ghost = (await effectsFor(a, stepKey)).length + 7;
      const ghostKey = keyFor(stepKey, row!, ghost);
      await expect(mintAsApprover(a, {
        toolName: child.actionName, input: child.arguments as Record<string, unknown>, ordinal: ghost,
        approvalId: approval.id, stepKey, operationKey: ghostKey,
      })).rejects.toMatchObject({ code: 'plan_approval_invalid', message: expect.stringMatching(/effect_not_in_set/) });
      await withTriggersDisabled('action_intents', ['action_intents_immutable_trg'], async () => {
        await owner().update(actionIntents).set({ operationKey: ghostKey }).where(eq(actionIntents.id, child.id));
      });
      const res = await revalidate(child.id);
      expect(res.ok, stepKey).toBe(false);
      if (!res.ok) {
        expect(res.errorCode).toBe('plan_approval_revoked');
        expect(res.details?.refusal).toBe('effect_not_in_set');
      }
    }
  }, 240_000);

  runDb('8. a catalog tool that is NOT in this plan is refused at mint and at release (tool_not_in_set)', async () => {
    const { a, child, approval } = await provisionChildMinted();
    // google_move_ou is in the catalog (and the frozen allowlist) but an M365-only onboarding never plans it.
    const outsider = 'google_move_ou';
    expect(CATALOG).toContain(outsider);
    expect((await planKeys(a, PROVISION_STEP)).map((p) => p.toolName)).not.toContain(outsider);
    const [row] = await effectsFor(a, PROVISION_STEP);
    await expect(mintAsApprover(a, {
      toolName: outsider, ordinal: 0, approvalId: approval.id, stepKey: PROVISION_STEP, operationKey: keyFor(PROVISION_STEP, row!),
      input: { userEmail: UPN, orgUnitPath: '/Staff', reason: REASON },
    })).rejects.toMatchObject({ code: 'plan_approval_invalid', message: expect.stringMatching(/tool_not_in_set/) });
    await withTriggersDisabled('action_intents', ['action_intents_immutable_trg'], async () => {
      await owner().update(actionIntents).set({ actionName: outsider }).where(eq(actionIntents.id, child.id));
    });
    const res = await revalidate(child.id);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errorCode).toBe('plan_approval_revoked');
      expect(res.details?.refusal).toBe('tool_not_in_set');
    }
  }, 180_000);

  runDb('9. after the stage bump r → r+1, a child under r is refused, the r approval is superseded with its approver intact, and NOTHING is cancelled (B7)', async () => {
    const t = await seedTenant({ google: false });
    const a = await driveToCreateProposed(t);
    await approve(a, CREATE_STEP);
    await walk(a, CREATE_STEP);
    const r = (await readTask(a)).revision;
    const intentsBefore = [...await childIntents(a), ...await planIntents(a)].map((i) => `${i.id}:${i.status}`).sort();
    await wake(a); // resolve_accounts: the bump
    expect((await readTask(a)).revision).toBe(r + 1);

    const createApproval = (await approvals(a)).find((x) => x.planRevision === r)!;
    expect(createApproval).toMatchObject({ state: 'superseded', supersededByRevision: r + 1, approvedByUserId: t.approverId });
    expect(createApproval.approvedAt).not.toBeNull();
    // No cancellation, anywhere: the dispatched create child and the creation
    // plan intent keep their (completed) status; the bump touched only the approval row.
    const intentsAfter = [...await childIntents(a), ...await planIntents(a)].map((i) => `${i.id}:${i.status}`).sort();
    expect(intentsAfter).toEqual(intentsBefore);
    expect(intentsAfter.some((s) => s.endsWith(':cancelled'))).toBe(false);
    const [createChild] = await childIntents(a);
    expect(createChild!.status).toBe('completed');

    // A child minted under r: refused. AS BUILT, the bump supersedes the r
    // approval first, so the named check reports `plan_superseded` (not
    // `revision_moved`, which needs a still-approved approval at an old
    // revision); unnamed, release looks at the LIVE revision.
    const [row] = await effectsFor(a, CREATE_STEP);
    const m = {
      orgId: t.orgId, taskId: a.taskId, ordinal: 0, toolName: row!.toolName, argumentDigest: row!.argumentDigest,
      taskStepKey: CREATE_STEP, operationKey: keyFor(CREATE_STEP, row!),
    };
    await expect(checkPlanEffectMembershipSystem({ ...m, approvalId: createApproval.id }))
      .resolves.toMatchObject({ ok: false, refusal: 'plan_superseded' });
    await expect(mintAsApprover(a, {
      toolName: 'm365_create_user', input: createChild!.arguments as Record<string, unknown>, ordinal: 0,
      approvalId: createApproval.id, stepKey: CREATE_STEP, operationKey: m.operationKey,
    })).rejects.toMatchObject({ code: 'plan_approval_invalid', message: expect.stringMatching(/plan_superseded/) });
    const res = await revalidateApprovedIntentForRelease({ ...createChild!, status: 'approved' } as never, null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe('plan_approval_revoked');
    expect(world().m365.createCalls).toBe(1);
  }, 180_000);

  runDb('10a. creation effect ROWS mutated under a PENDING plan: the release recomputes the effect digest and fails before markPlanApproved (content_changed)', async () => {
    const t = await seedTenant({ google: false });
    const a = await driveToCreateProposed(t);
    const [planIntent] = await planIntents(a);
    const pinned = planIntent!.effectDigest;
    const digestNow = async () => (await system(() =>
      computeEffectDigestForRelease('operator_plan', planIntent!.arguments as Record<string, unknown>, db))).digest;
    expect(await digestNow(), 'control: the pin matches the rows').toBe(pinned);
    const approval = (await approvalFor(a, CREATE_STEP))!;
    await withTriggersDisabled('ai_operator_plan_approval_effects', ['ai_operator_plan_approval_effects_no_update'], async () => {
      await owner().update(aiOperatorPlanApprovalEffects).set({ argumentDigest: 'c'.repeat(64) })
        .where(and(eq(aiOperatorPlanApprovalEffects.approvalId, approval.id), eq(aiOperatorPlanApprovalEffects.ordinal, 0)));
    });
    expect(await digestNow()).not.toBe(pinned);
    await approveRealWay(asPlanTenant(t), planIntent!.id);
    expect(await readIntent(planIntent!.id)).toMatchObject({ status: 'failed', errorCode: 'content_changed' });
    expect(await approvalFor(a, CREATE_STEP)).toMatchObject({ state: 'pending', approvedByUserId: null });
    await wake(a);
    expect(await childIntents(a)).toHaveLength(0);
    expect(world().m365.createCalls).toBe(0);
  }, 180_000);

  runDb('10b. provisioning effect ROWS mutated under an APPROVED plan: a child is refused at release by the re-sealed set (effect_set_digest_mismatch)', async () => {
    const { child, approval } = await provisionChildMinted();
    expect((await revalidate(child.id)).ok, 'control').toBe(true);
    await withTriggersDisabled('ai_operator_plan_approval_effects', ['ai_operator_plan_approval_effects_no_update'], async () => {
      await owner().update(aiOperatorPlanApprovalEffects).set({ argumentDigest: 'c'.repeat(64) })
        .where(and(eq(aiOperatorPlanApprovalEffects.approvalId, approval.id), eq(aiOperatorPlanApprovalEffects.ordinal, 1)));
    });
    const res = await revalidate(child.id);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errorCode).toBe('plan_approval_revoked');
      expect(res.details?.refusal).toBe('effect_set_digest_mismatch');
    }
  }, 180_000);

  runDb('11. m365_create_user absent from the agent\'s allowlist is refused at release (live policy) and at mint (frozen snapshot): no account is created', async () => {
    // RELEASE: narrowing the live policy revokes the minted create child.
    const { a, child } = await createChildMinted();
    expect((await revalidate(child.id)).ok, 'control').toBe(true);
    const withoutCreate = CATALOG.filter((x) => x !== 'm365_create_user');
    await system(() => db.update(aiAgents).set({ toolAllowlist: withoutCreate }).where(eq(aiAgents.id, a.t.agentId)));
    const atRelease = await revalidate(child.id);
    expect(atRelease.ok).toBe(false);
    if (!atRelease.ok) expect(atRelease.errorCode).toBe('tool_not_in_agent_allowlist');
    await releaseInFlight(a);
    expect(world().m365.createCalls, 'the narrowed policy stopped the create at release').toBe(0);

    // MINT: the frozen ceiling is the EARLIEST task-linked run's snapshot. An
    // earlier run without the create stands in for "the admitting policy never
    // allowed it". Inserted AFTER the creation approval lands, so the refusal
    // is the coordinator's mint (`createActionIntent`), not the plan's release.
    const frozenWithoutCreate = (t: { agentId: string; orgId: string }, taskId: string) => system(() => db.insert(aiAgentRuns).values({
      agentId: t.agentId, orgId: t.orgId, deviceId: null, triggerKind: 'manual' as const,
      dedupeKey: `operator-task:${taskId}:intake:frozen-ceiling`, modeAtStart: 'shadow' as const,
      queuedAt: new Date('2020-01-01T00:00:00Z'),
      policySnapshot: policySnapshot(t.agentId, withoutCreate) as never,
      status: 'completed' as const, startedAt: new Date('2020-01-01T00:00:00Z'), finishedAt: new Date('2020-01-01T00:00:00Z'),
      taskId, taskStepKey: 'intake', taskAttemptOrdinal: 1,
    } as never));
    const t2 = await seedTenant({ google: false });
    const b = await driveToCreateProposed(t2);
    await approve(b, CREATE_STEP);
    expect(await approvalFor(b, CREATE_STEP)).toMatchObject({ state: 'approved' });
    await frozenWithoutCreate(t2, b.taskId);
    await wake(b); // the coordinator tries to mint the create
    expect(await childIntents(b), 'the mint was refused').toHaveLength(0);
    const minted = await readTask(b);
    expect(minted.state).toBe('handed_off');
    expect(minted.outcomeDetail ?? '').toMatch(/tool_not_in_agent_allowlist/);
    expect(world().m365.createCalls).toBe(0);

    // AND at the plan's own release: with the narrower snapshot present
    // BEFORE the decision, the creation approval never becomes approved
    // (markPlanApproved re-runs the ceiling over every row), so nothing is minted.
    const t3 = await seedTenant({ google: false });
    const c = await driveToCreateProposed(t3);
    await frozenWithoutCreate(t3, c.taskId);
    const [planIntent] = await planIntents(c);
    await approve(c, CREATE_STEP);
    expect(await readIntent(planIntent!.id)).toMatchObject({ status: 'failed' });
    expect((await approvalFor(c, CREATE_STEP))!.state).not.toBe('approved');
    await wake(c);
    expect(await childIntents(c)).toHaveLength(0);
    const released = await readTask(c);
    expect(released.state).toBe('handed_off');
    expect(released.outcomeDetail ?? '').toMatch(/plan approval ended as failed/);
    expect(world().m365.createCalls).toBe(0);
  }, 240_000);

  runDb('12. four eyes: the requester cannot approve EITHER stage\'s operator_plan intent', async () => {
    const t = await seedTenant({ google: false });
    const a = await driveToProvisionProposed(t);
    const provisionApproval = (await approvalFor(a, PROVISION_STEP))!;
    const createApproval = (await approvals(a)).find((x) => x.stepKey === CREATE_STEP)!;
    // Stage 1 was approved by the approver, never the requester.
    expect(createApproval.approvedByUserId).toBe(t.approverId);
    expect(createApproval.approvedByUserId).not.toBe(t.requesterId);

    // Stage 2, pending: the requester has no request row and cannot decide the approver's.
    const planIntent = await readIntent(provisionApproval.intentId!);
    expect(planIntent.requestedByUserId).toBe(t.requesterId);
    const rows = await approvalRequestsFor(planIntent.id);
    expect(rows.some((r) => r.userId === t.approverId)).toBe(true);
    expect(rows.some((r) => r.userId === t.requesterId), 'no approval request is addressed to the requester').toBe(false);
    await expect(approve({ ...a, t: { ...t, approverId: t.requesterId } }, PROVISION_STEP)).rejects.toThrow(/no approval request for approver/);
    const requesterAuth = await userAuth(asPlanTenant(t), t.requesterId);
    const theirs = rows.find((r) => r.userId === t.approverId)!;
    const res = await asUser(requesterAuth, () => decideApprovalRequest({ auth: requesterAuth, id: theirs.id, status: 'approved' }));
    expect(res).toMatchObject({ httpStatus: 404 });
    expect(await approvalFor(a, PROVISION_STEP)).toMatchObject({ state: 'pending', approvedByUserId: null });
    await wake(a);
    expect(await stageOps(a, PROVISION_STEP)).toHaveLength(0);

    // Stage 1 on a fresh task, pending: the same refusal. The second org is a
    // different provider tenant: the one shared fake must not show it the
    // first org's created account (that would read as a UPN collision).
    world().m365.users = [];
    world().m365.createCalls = 0;
    const t2 = await seedTenant({ google: false });
    const b = await driveToCreateProposed(t2);
    await expect(approve({ ...b, t: { ...t2, approverId: t2.requesterId } }, CREATE_STEP)).rejects.toThrow(/no approval request for approver/);
    expect(await approvalFor(b, CREATE_STEP)).toMatchObject({ state: 'pending', approvedByUserId: null });
    await wake(b);
    expect(await childIntents(b)).toHaveLength(0);
    expect(world().m365.createCalls).toBe(0);
  }, 240_000);

  runDb('13a. a forged MIXED creation set (re-sealed, so the digest passes) is refused at mint and at release by the secrecy check alone', async () => {
    const { a, child, approval } = await createChildMinted();
    const [row] = await effectsFor(a, CREATE_STEP);
    const ordinaryArgs = { userIdentifier: CREATED_M365_ID, skuIds: [SKU_E3], reason: REASON };
    const added = {
      ...row!, id: crypto.randomUUID(), ordinal: 1, toolName: 'm365_assign_license', accountExternalId: CREATED_M365_ID,
      argumentDigest: computeArgumentDigest(canonicalizeArguments(ordinaryArgs)), rendering: 'Assign Microsoft 365 license',
    };
    const digest = computeEffectSetDigest({ taskId: a.taskId, planRevision: approval.planRevision, effects: rowsToDigestProjection([row!, added]) });
    await withTriggersDisabled('ai_operator_plan_approval_effects', ['ai_operator_plan_approval_effects_closed_set'], async () => {
      await owner().insert(aiOperatorPlanApprovalEffects).values(added as never);
    });
    await withTriggersDisabled('ai_operator_plan_approvals', ['ai_operator_plan_approvals_immutable_trg'], async () => {
      await owner().update(aiOperatorPlanApprovals).set({ effectCount: 2, effectSetDigest: digest } as never).where(eq(aiOperatorPlanApprovals.id, approval.id));
    });
    expect(isSecretBearingTool('m365_create_user') && !isSecretBearingTool('m365_assign_license'), 'the forged set really is mixed').toBe(true);
    await expect(mintAsApprover(a, {
      toolName: 'm365_assign_license', input: ordinaryArgs, ordinal: 1, approvalId: approval.id, stepKey: CREATE_STEP,
      operationKey: keyFor(CREATE_STEP, { ...row!, toolName: 'm365_assign_license' }, 1),
    })).rejects.toMatchObject({ code: 'plan_approval_invalid', message: expect.stringMatching(/mixed_secret_bearing/) });
    const res = await revalidate(child.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.details?.refusal).toBe('mixed_secret_bearing');
    await releaseInFlight(a);
    expect(world().m365.createCalls).toBe(0);
  }, 180_000);

  runDb('13b. a forged ALL-secret-bearing creation set holding a tool the recipe never plans passes the secrecy check and is refused by the digest seal alone', async () => {
    const { a, child, approval } = await createChildMinted();
    const [row] = await effectsFor(a, CREATE_STEP);
    // m365_reset_password: secret-bearing, so the set stays single-kind; never planned by this recipe.
    const forgedTool = 'm365_reset_password';
    expect(isSecretBearingTool(forgedTool)).toBe(true);
    expect((IDENTITY_ONBOARDING_PROVISION_TOOLS as readonly string[]).includes(forgedTool) || CATALOG.includes(forgedTool)).toBe(false);
    const forgedArgs = { userIdentifier: '00000000-0000-4000-8000-0000000a0888', reason: REASON };
    const added = {
      ...row!, id: crypto.randomUUID(), ordinal: 1, toolName: forgedTool, accountExternalId: '00000000-0000-4000-8000-0000000a0888',
      argumentDigest: computeArgumentDigest(canonicalizeArguments(forgedArgs)), rendering: 'Reset Microsoft 365 password',
    };
    await withTriggersDisabled('ai_operator_plan_approval_effects', ['ai_operator_plan_approval_effects_closed_set'], async () => {
      await owner().insert(aiOperatorPlanApprovalEffects).values(added as never);
    });
    // The count is forged to match; the seal is NOT recomputed.
    await withTriggersDisabled('ai_operator_plan_approvals', ['ai_operator_plan_approvals_immutable_trg'], async () => {
      await owner().update(aiOperatorPlanApprovals).set({ effectCount: 2 } as never).where(eq(aiOperatorPlanApprovals.id, approval.id));
    });
    const m = { orgId: a.t.orgId, taskId: a.taskId, ordinal: 1, toolName: forgedTool, argumentDigest: added.argumentDigest,
      taskStepKey: CREATE_STEP, approvalId: approval.id, operationKey: keyFor(CREATE_STEP, { ...row!, toolName: forgedTool }, 1) };
    await expect(checkPlanEffectMembershipSystem(m)).resolves.toMatchObject({ ok: false, refusal: 'effect_set_digest_mismatch' });
    const res = await revalidate(child.id);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errorCode).toBe('plan_approval_revoked');
      expect(res.details?.refusal).toBe('effect_set_digest_mismatch');
    }
    await releaseInFlight(a);
    expect(world().m365.createCalls).toBe(0);
    // And no reset child exists anywhere on the task.
    expect((await childIntents(a)).map((i) => i.actionName)).toEqual(['m365_create_user']);
  }, 180_000);
});
