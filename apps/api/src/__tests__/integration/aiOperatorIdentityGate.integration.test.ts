/**
 * identity_offboarding — the deterministic release gate's real-Postgres half
 * (spec §9 clauses (b) and (c); wave #6171, PR R1c, plan Task 25).
 *
 * (b) ORDERING OVER DISPATCH PREFIXES. R1a proved the property about every
 * prefix of the PLAN (recipes/identityOffboarding.ordering.test.ts) and about
 * one happy-path RUN (aiOperatorIdentityOffboardingE2E). This file proves it
 * about every independent STOPPING POINT of a real dispatch: for each k in
 * 0..plan.length, a fresh tenant and task are driven through the real
 * coordinator until exactly k effects have settled, and the settled
 * `ai_operator_operations` rows must leave no provider locked out with its
 * mail unrouted.
 *
 * (c) PLAN-APPROVAL MEMBERSHIP for THIS recipe's rows and tools, at
 * `stepKey = 'effects'` (Todd's D1: one effects step per revision), each case
 * driven from an identity task's REAL plan rows and its coordinator-minted
 * child — never from planApprovalFixtures' generic plan. E4's
 * aiOperatorPlanApprovalMembership suite proves the predicate generically.
 *
 * WHAT IS FAKED: exactly what R1a's E2E fakes (the model's completed runs,
 * the providers' reads, the effect probes, and a child's release), through the
 * shared harness `identityOffboardingHarness.ts`. Everything else — the
 * coordinator, admission, readiness, the four-eyes decide + release, the
 * membership predicate, `revalidateApprovedIntentForRelease`,
 * `computeEffectDigestForRelease`, `bumpPlanRevision` — is production code.
 */
import './setup';
import { getTestDb } from './setup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Provider fakes (hoisted; the harness reads the same object via bindFakeProviders)
// ---------------------------------------------------------------------------

const fake = vi.hoisted(() => ({
  world: null as unknown as import('./identityOffboardingHarness').FakeWorld,
  googleConnId: null as string | null,
  m365Calls: 0,
}));

vi.mock('../../services/m365ControlPlane/readActionService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
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

import { taskCheckpointSchema } from '@breeze/shared';
import { db } from '../../db';
import { actionIntents, aiAgentRuns, aiAgents, aiOperatorPlanApprovalEffects } from '../../db/schema';
import { createActionIntent } from '../../services/actionIntents/intentService';
import { revalidateApprovedIntentForRelease } from '../../services/actionIntents/revalidateRelease';
import { computeEffectDigestForRelease } from '../../services/actionIntents/effectDigest';
import { canonicalizeArguments, computeArgumentDigest } from '../../services/actionIntents/canonicalize';
import { decideApprovalRequest } from '../../services/approvals/decideApprovalRequest';
import { __resetEffectProbesForTest, registerEffectProbe } from '../../services/aiOperator/effectProbes';
import {
  bumpPlanRevision,
  checkPlanEffectMembershipSystem,
  planEffectOperationKey,
} from '../../services/aiOperator/planApproval';
import { loadPlanningFacts } from '../../services/aiOperator/planningSnapshot';
import {
  LOCKOUT_TOOL,
  MAIL_ROUTING_TOOLS,
  buildIdentityOffboardingManualWork,
  identityOffboardingRecipe,
} from '../../services/aiOperator/recipes/identityOffboarding';
import { approvalRequestsFor, approveRealWay, asUser, readIntent, userAuth } from './planApprovalFixtures';
import {
  CATALOG,
  STEP,
  approvalEffects,
  approvals,
  asPlanTenant,
  bindFakeProviders,
  childIntents,
  driveToApprovedAndHeld,
  driveToProposed,
  freshWorld,
  openWindow,
  operations,
  planIntents,
  planKeys,
  policySnapshot,
  readTask,
  releaseInFlight,
  seedTenant,
  system,
  wake,
  walkEffects,
  type Admitted,
  type PlanKey,
} from './identityOffboardingHarness';

bindFakeProviders(fake);

const runDb = it.runIf(!!process.env.DATABASE_URL);
const skipDb = it.skip;
const owner = () => getTestDb() as unknown as typeof db;
const PROVIDERS = ['google', 'm365'] as const;

/**
 * The plan the seeded tenant produces under tier 0 and the default toggles:
 * six Google effects and five M365 effects. A change to it is loud here
 * rather than a silently shorter loop.
 */
const PLAN_LENGTH = 11;

async function withTriggerDisabled(table: string, trigger: string, fn: () => Promise<void>) {
  const o = owner();
  await o.execute(sql.raw(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`));
  try { await fn(); } finally { await o.execute(sql.raw(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)); }
}

/** A lockout absent from the plan would make the ordering invariant vacuously true. */
function assertBothLockoutsPlanned(plan: PlanKey[]) {
  for (const p of PROVIDERS) {
    expect(plan.some((e) => e.toolName === LOCKOUT_TOOL[p]), `${p}: lockout not planned — invariant would be vacuous`).toBe(true);
    expect(plan.some((e) => e.provider === p && MAIL_ROUTING_TOOLS[p].includes(e.toolName)),
      `${p}: no mail-routing effect planned — invariant would be vacuous`).toBe(true);
  }
}

/** The task's approval at its current revision, and its first child minted by the real walk. */
async function approvedWithFirstChild() {
  const t = await seedTenant();
  const a = await driveToApprovedAndHeld(t);
  await openWindow(a);
  await wake(a); // the walk mints ordinal 0 as the approver
  const children = await childIntents(a);
  expect(children).toHaveLength(1);
  const [approval] = await approvals(a);
  const plan = await planKeys(a);
  return { t, a, child: children[0]!, approvalId: approval!.id, plan };
}

async function revalidate(intentId: string) {
  return revalidateApprovedIntentForRelease(await readIntent(intentId), null);
}

async function mintAsApprover(a: Admitted, args: {
  toolName: string; input: Record<string, unknown>; ordinal: number; approvalId: string; operationKey?: string;
}) {
  const auth = await userAuth(asPlanTenant(a.t), a.t.approverId);
  const task = await readTask(a);
  return createActionIntent(auth, {
    toolName: args.toolName,
    input: args.input,
    source: 'mcp_api',
    orgId: a.t.orgId,
    requestingClientLabel: 'AI Operator',
    task: {
      taskId: a.taskId, taskStepKey: STEP, attemptOrdinal: 0,
      operationKey: args.operationKey ?? planEffectOperationKey({
        stepKey: STEP, planRevision: task.revision, toolName: args.toolName,
        targetId: (await approvalEffects(a))[0]!.targetId, ordinal: args.ordinal,
      }),
    },
    planApproval: { approvalId: args.approvalId, ordinal: args.ordinal },
  });
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
      const state = ctx.phase === 'pre' ? 'unsatisfied' : 'satisfied';
      return { state, observedAt: new Date(), detail: `scripted ${ctx.phase} ${state}` };
    });
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetEffectProbesForTest();
});

// ---------------------------------------------------------------------------
// (b) Ordering over every dispatch stopping point
// ---------------------------------------------------------------------------

describe('(b) ordering: stopping after any dispatch leaves no locked-out account with unrouted mail', () => {
  for (let k = 0; k <= PLAN_LENGTH; k += 1) {
    runDb(`stop after ${k} settled effect(s): every settled lockout has its provider's mail routing settled`, async () => {
      const t = await seedTenant();
      const a = await driveToApprovedAndHeld(t);
      const plan = await planKeys(a);
      expect(plan, 'the approved plan').toHaveLength(PLAN_LENGTH);
      assertBothLockoutsPlanned(plan);

      await openWindow(a);
      await walkEffects(a, { stopAfterOps: k });

      const ops = await operations(a);
      const settled = new Set(ops.filter((o) => o.resultState === 'succeeded').map((o) => o.operationKey));
      expect(ops, `exactly ${k} operations at the stopping point`).toHaveLength(k);
      expect(settled.size, `all ${k} operations settled`).toBe(k);
      // The settled set is a prefix of the plan.
      expect([...settled].sort()).toEqual(plan.slice(0, k).map((p) => p.key).sort());

      for (const p of PROVIDERS) {
        const lockout = plan.find((e) => e.toolName === LOCKOUT_TOOL[p])!;
        const mail = plan.filter((e) => e.provider === p && MAIL_ROUTING_TOOLS[p].includes(e.toolName));
        if (k > lockout.ordinal) {
          // The antecedent really fires at this stopping point.
          expect(settled.has(lockout.key), `${LOCKOUT_TOOL[p]} settled at k=${k}`).toBe(true);
        }
        if (settled.has(lockout.key)) {
          for (const m of mail) {
            expect(settled.has(m.key), `${LOCKOUT_TOOL[p]} settled while ${m.toolName} (ordinal ${m.ordinal}) had not`).toBe(true);
          }
        }
      }
    }, 120_000);
  }

  // BUG (#9979, missing surface): there is no task-cancel path for recipe
  // tasks. taskTransitions.ts declares `stop` / `settle_cancelled`, but no
  // service, route or job writes them, and a one-off probe in R1a showed a
  // task in `stopping` still mints its next child (advanceTask never checks
  // the task's own fencing). "A task cancelled at each k records the
  // remaining ordinals in its handoff summary, and no operation settles after
  // the cancel" therefore cannot be exercised until #9979 is fixed.
  skipDb('cancelled at each k: the handoff names the remaining ordinals and no operation settles after the cancel', async () => {
    // Intentionally empty: see the BUG note above.
  });

  runDb('product-default caller verification: m365_disable_user is never planned and is a manual item instead', async () => {
    const t = await seedTenant({ disableUserTier: null });
    const a = await driveToApprovedAndHeld(t);
    const tools = (await approvalEffects(a)).map((e) => e.toolName);
    expect(tools).not.toContain('m365_disable_user');
    expect(tools).toContain(LOCKOUT_TOOL.google);
    const task = await readTask(a);
    const cp = taskCheckpointSchema.parse(task.checkpoint);
    const facts = await loadPlanningFacts(task, identityOffboardingRecipe as never, cp);
    if (!facts.ok) throw new Error('planning facts did not load');
    const manual = buildIdentityOffboardingManualWork(
      cp.recipeInput as never, facts.facts, (facts.facts.capabilityReadiness ?? {}) as Record<string, boolean>, [],
    );
    expect(manual.map((m) => m.label)).toContain("Disable Dana Example's Microsoft 365 account by hand");
  }, 120_000);
});

// ---------------------------------------------------------------------------
// (c) Plan-approval membership, for this recipe's rows at stepKey 'effects'
// ---------------------------------------------------------------------------

describe('(c) plan-approval membership for identity_offboarding effects', () => {
  runDb('(3) an in-set effect, minted by the coordinator at the effects step, releases', async () => {
    const { child, plan, t } = await approvedWithFirstChild();
    expect(child).toMatchObject({
      taskStepKey: STEP, decidedVia: 'plan_approval', status: 'approved',
      requestedByUserId: t.approverId, decidedByUserId: t.approverId,
      actionName: plan[0]!.toolName, operationKey: plan[0]!.key,
    });
    const released = await revalidate(child.id);
    expect(released.ok, JSON.stringify(released)).toBe(true);
  }, 120_000);

  runDb('(4) the intent\'s argument row mutated after mint is refused AT RELEASE: argument_digest_mismatch', async () => {
    const { child } = await approvedWithFirstChild();
    expect((await revalidate(child.id)).ok, 'control: releases before the tamper').toBe(true);
    const tampered = { ...(child.arguments as Record<string, unknown>), userEmail: 'someone-else@customer.example' };
    await withTriggerDisabled('action_intents', 'action_intents_immutable_trg', async () => {
      await owner().update(actionIntents).set({
        arguments: tampered, argumentDigest: computeArgumentDigest(canonicalizeArguments(tampered)),
      }).where(eq(actionIntents.id, child.id));
    });
    const res = await revalidate(child.id);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errorCode).toBe('plan_approval_revoked');
      expect(res.details?.refusal).toBe('argument_digest_mismatch');
    }
  }, 120_000);

  runDb('(5) an ordinal outside the approved set is refused at mint and at release: effect_not_in_set', async () => {
    const { a, child, approvalId, plan } = await approvedWithFirstChild();
    const ghostOrdinal = plan.length + 7;
    await expect(mintAsApprover(a, {
      toolName: child.actionName, input: child.arguments as Record<string, unknown>, ordinal: ghostOrdinal, approvalId,
    })).rejects.toMatchObject({ code: 'plan_approval_invalid', message: expect.stringMatching(/effect_not_in_set/) });

    const task = await readTask(a);
    const ghostKey = planEffectOperationKey({
      stepKey: STEP, planRevision: task.revision, toolName: child.actionName,
      targetId: (await approvalEffects(a))[0]!.targetId, ordinal: ghostOrdinal,
    });
    await withTriggerDisabled('action_intents', 'action_intents_immutable_trg', async () => {
      await owner().update(actionIntents).set({ operationKey: ghostKey }).where(eq(actionIntents.id, child.id));
    });
    const res = await revalidate(child.id);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errorCode).toBe('plan_approval_revoked');
      expect(res.details?.refusal).toBe('effect_not_in_set');
    }
  }, 120_000);

  runDb('(6) a catalog tool that is NOT in this plan is refused at mint and at release: tool_not_in_set', async () => {
    const { a, child, approvalId, plan } = await approvedWithFirstChild();
    // google_add_mail_delegate is in the recipe catalog (and the frozen
    // allowlist) but the default toggles never plan it.
    const outsider = 'google_add_mail_delegate';
    expect(CATALOG).toContain(outsider);
    expect(plan.map((p) => p.toolName)).not.toContain(outsider);

    await expect(mintAsApprover(a, {
      toolName: outsider, ordinal: 0, approvalId,
      input: { userEmail: 'dana@customer.example', delegateEmail: 'manager@customer.example', reason: 'Offboarding Dana Example (Breeze Operator task).' },
    })).rejects.toMatchObject({ code: 'plan_approval_invalid', message: expect.stringMatching(/tool_not_in_set/) });

    await withTriggerDisabled('action_intents', 'action_intents_immutable_trg', async () => {
      await owner().update(actionIntents).set({ actionName: outsider }).where(eq(actionIntents.id, child.id));
    });
    const res = await revalidate(child.id);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errorCode).toBe('plan_approval_revoked');
      expect(res.details?.refusal).toBe('tool_not_in_set');
    }
  }, 120_000);

  runDb('(7a) bumpPlanRevision on a PENDING plan cancels its operator_plan intent and supersedes the approval', async () => {
    const t = await seedTenant();
    const a = await driveToProposed(t);
    const before = await readTask(a);
    const [plan] = await planIntents(a);
    expect(plan!.status).toBe('pending_approval');

    const bumped = await bumpPlanRevision({
      orgId: t.orgId, taskId: a.taskId, fromRevision: before.revision, leaseEpoch: before.leaseEpoch, detail: 'R1c gate: supersede a pending plan',
    });
    expect(bumped.bumped).toBe(true);
    expect(bumped.newRevision).toBe(before.revision + 1);
    // The CAS moved the task: callers must re-read the revision (A.7 item 3).
    expect((await readTask(a)).revision).toBe(before.revision + 1);
    expect(bumped.cancelledIntentIds).toContain(plan!.id);
    const after = await readIntent(plan!.id);
    expect(after).toMatchObject({ status: 'cancelled', errorCode: 'plan_superseded' });
    const [approval] = await approvals(a);
    expect(approval).toMatchObject({ state: 'superseded', supersededByRevision: before.revision + 1, stepKey: STEP });
  }, 120_000);

  runDb('(7b) bumpPlanRevision on an APPROVED plan: a child minted under the old revision is refused (plan_superseded named, plan_approval_missing unnamed)', async () => {
    const { a, child, approvalId, plan } = await approvedWithFirstChild();
    const minted = await readIntent(child.id);
    const before = await readTask(a);

    const bumped = await bumpPlanRevision({
      orgId: a.t.orgId, taskId: a.taskId, fromRevision: before.revision, leaseEpoch: before.leaseEpoch, detail: 'R1c gate: supersede an approved plan',
    });
    expect(bumped).toMatchObject({ bumped: true, newRevision: before.revision + 1, supersededApprovalId: approvalId });
    expect((await readTask(a)).revision).toBe(before.revision + 1);
    // The undispatched child is cancelled with its operation.
    expect(bumped.cancelledIntentIds).toContain(child.id);
    expect(await readIntent(child.id)).toMatchObject({ status: 'cancelled', errorCode: 'plan_superseded' });

    const membership = {
      orgId: a.t.orgId, taskId: a.taskId, ordinal: 0, toolName: plan[0]!.toolName,
      argumentDigest: minted.argumentDigest, taskStepKey: STEP, operationKey: plan[0]!.key,
    };
    // Named (the mint path): the approval is found and reported superseded.
    await expect(checkPlanEffectMembershipSystem({ ...membership, approvalId }))
      .resolves.toMatchObject({ ok: false, refusal: 'plan_superseded' });
    // Unnamed (the release path): looked up at the LIVE revision, where no approval exists.
    await expect(checkPlanEffectMembershipSystem(membership))
      .resolves.toMatchObject({ ok: false, refusal: 'plan_approval_missing' });
    await expect(mintAsApprover(a, {
      toolName: plan[0]!.toolName, input: minted.arguments as Record<string, unknown>, ordinal: 0, approvalId, operationKey: plan[0]!.key,
    })).rejects.toMatchObject({ code: 'plan_approval_invalid', message: expect.stringMatching(/plan_superseded/) });
    // The child exactly as it was minted still cannot be released.
    const res = await revalidateApprovedIntentForRelease(minted, null);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errorCode).toBe('plan_approval_revoked');
      expect(res.details?.refusal).toBe('plan_approval_missing');
    }
  }, 120_000);

  runDb('(8a) effect ROWS mutated under a pending plan: the release recomputes the effect digest and fails before markPlanApproved runs', async () => {
    const t = await seedTenant();
    const a = await driveToProposed(t);
    const [planIntent] = await planIntents(a);
    const pinned = planIntent!.effectDigest;
    const digestNow = async () => (await system(() =>
      computeEffectDigestForRelease('operator_plan', planIntent!.arguments as Record<string, unknown>, db))).digest;
    expect(await digestNow(), 'control: the pin matches the rows before the tamper').toBe(pinned);

    const [approval] = await approvals(a);
    await withTriggerDisabled('ai_operator_plan_approval_effects', 'ai_operator_plan_approval_effects_no_update', async () => {
      await owner().update(aiOperatorPlanApprovalEffects)
        .set({ argumentDigest: 'c'.repeat(64) })
        .where(and(eq(aiOperatorPlanApprovalEffects.approvalId, approval!.id), eq(aiOperatorPlanApprovalEffects.ordinal, 2)));
    });
    expect(await digestNow()).not.toBe(pinned);

    await approveRealWay(asPlanTenant(t), planIntent!.id);
    // The worker's pinned-digest recompute refused it: the operator_plan
    // handler (markPlanApproved, and so membership) never ran.
    expect(await readIntent(planIntent!.id)).toMatchObject({ status: 'failed', errorCode: 'content_changed' });
    const [still] = await approvals(a);
    expect(still).toMatchObject({ state: 'pending', approvedByUserId: null });
    expect(await childIntents(a)).toHaveLength(0);
  }, 120_000);

  runDb('(8b) effect ROWS mutated under an APPROVED plan: a child is refused at release by the re-sealed set (effect_set_digest_mismatch)', async () => {
    const { child, approvalId } = await approvedWithFirstChild();
    expect((await revalidate(child.id)).ok, 'control').toBe(true);
    await withTriggerDisabled('ai_operator_plan_approval_effects', 'ai_operator_plan_approval_effects_no_update', async () => {
      await owner().update(aiOperatorPlanApprovalEffects)
        .set({ argumentDigest: 'c'.repeat(64) })
        .where(and(eq(aiOperatorPlanApprovalEffects.approvalId, approvalId), eq(aiOperatorPlanApprovalEffects.ordinal, 2)));
    });
    const res = await revalidate(child.id);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errorCode).toBe('plan_approval_revoked');
      expect(res.details?.refusal).toBe('effect_set_digest_mismatch');
    }
  }, 120_000);

  runDb('(9) a catalog tool absent from the agent\'s allowlist is refused at mint (frozen snapshot) and at release (live policy)', async () => {
    const { a, child, plan } = await approvedWithFirstChild();
    // RELEASE: narrowing the live policy revokes the already-minted child.
    expect((await revalidate(child.id)).ok, 'control').toBe(true);
    const withoutFirst = CATALOG.filter((x) => x !== plan[0]!.toolName);
    await system(() => db.update(aiAgents).set({ toolAllowlist: withoutFirst }).where(eq(aiAgents.id, a.t.agentId)));
    const atRelease = await revalidate(child.id);
    expect(atRelease.ok).toBe(false);
    if (!atRelease.ok) expect(atRelease.errorCode).toBe('tool_not_in_agent_allowlist');
    await system(() => db.update(aiAgents).set({ toolAllowlist: [...CATALOG] }).where(eq(aiAgents.id, a.t.agentId)));
    expect((await revalidate(child.id)).ok, 'restoring the live policy restores the release').toBe(true);

    // MINT: the frozen ceiling is the EARLIEST task-linked run's snapshot. An
    // earlier run without the next tool stands in for "the admitting policy
    // never allowed it"; the coordinator's next mint must be refused.
    const next = plan[1]!;
    await system(() => db.insert(aiAgentRuns).values({
      agentId: a.t.agentId, orgId: a.t.orgId, deviceId: null, triggerKind: 'manual' as const,
      dedupeKey: `operator-task:${a.taskId}:intake:frozen-ceiling`, modeAtStart: 'shadow' as const,
      queuedAt: new Date('2020-01-01T00:00:00Z'),
      policySnapshot: policySnapshot(a.t.agentId, CATALOG.filter((x) => x !== next.toolName)) as never,
      status: 'completed' as const, startedAt: new Date('2020-01-01T00:00:00Z'), finishedAt: new Date('2020-01-01T00:00:00Z'),
      taskId: a.taskId, taskStepKey: 'intake', taskAttemptOrdinal: 1,
    } as never));
    await releaseInFlight(a);
    await wake(a); // verifies ordinal 0, then tries to mint ordinal 1
    const children = await childIntents(a);
    expect(children.map((c) => c.actionName)).toEqual([plan[0]!.toolName]);
    const task = await readTask(a);
    expect(task.state).toBe('handed_off');
    expect(task.outcomeDetail ?? '').toMatch(/tool_not_in_agent_allowlist/);
  }, 120_000);

  runDb('(10) four eyes: the requester cannot approve the operator_plan intent', async () => {
    const t = await seedTenant();
    const a = await driveToProposed(t);
    const [planIntent] = await planIntents(a);
    expect(planIntent!.requestedByUserId).toBe(t.requesterId);
    const rows = await approvalRequestsFor(planIntent!.id);
    expect(rows.some((r) => r.userId === t.approverId)).toBe(true);
    expect(rows.some((r) => r.userId === t.requesterId), 'no approval request is addressed to the requester').toBe(false);

    // Through the shared real-approval path, as the requester.
    await expect(approveRealWay(asPlanTenant(t, t.requesterId), planIntent!.id)).rejects.toThrow(/no approval request for approver/);
    // And deciding the approver's own request row while authenticated as the requester.
    const requesterAuth = await userAuth(asPlanTenant(t), t.requesterId);
    const theirs = rows.find((r) => r.userId === t.approverId)!;
    const res = await asUser(requesterAuth, () => decideApprovalRequest({ auth: requesterAuth, id: theirs.id, status: 'approved' }));
    expect(res.httpStatus).not.toBe(200);

    expect(await readIntent(planIntent!.id)).toMatchObject({ status: 'pending_approval' });
    const [approval] = await approvals(a);
    expect(approval).toMatchObject({ state: 'pending', approvedByUserId: null });
    expect(await childIntents(a)).toHaveLength(0);
  }, 120_000);
});
