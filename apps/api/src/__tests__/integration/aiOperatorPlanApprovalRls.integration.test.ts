/**
 * Plan approval tables — RLS, constraints and immutability against real
 * Postgres (Recipe Library wave E4, #6169). Migration under test:
 * 2026-12-23-190000-ai-operator-plan-approvals.sql.
 *
 * Code under test runs as the unprivileged `breeze_app` role (via
 * withDbAccessContext on the production `db`), so forced RLS is genuinely
 * enforced; the owner connection (getTestDb) is used only to seed, to prove a
 * trigger holds "even as table owner", and to bypass one trigger where the
 * composite FK behind it is the thing under test.
 */
import './setup';
import { getTestDb } from './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { aiOperatorTasks } from '../../db/schema';
import {
  aiOperatorPlanApprovalEffects,
  aiOperatorPlanApprovals,
} from '../../db/schema/aiOperatorPlanApprovals';
import { PLAN_REVISION, propose, seedPlanTenant, system, type PlanTenant } from './planApprovalFixtures';

const owner = () => getTestDb() as unknown as typeof db;
const DIGEST = 'a'.repeat(64);

function ctxOf(t: PlanTenant): DbAccessContext {
  return {
    scope: 'organization', orgId: t.orgId, accessibleOrgIds: [t.orgId],
    accessiblePartnerIds: [t.partnerId], userId: null,
  };
}

interface PgFailure { code?: string; message: string; constraint?: string }

/** Run `fn`, expecting it to throw; return the underlying Postgres error. */
async function pgFail(fn: () => Promise<unknown>): Promise<PgFailure> {
  try {
    await fn();
  } catch (err) {
    const e = (err as { cause?: Record<string, unknown> }).cause ?? (err as unknown as Record<string, unknown>);
    return {
      code: e.code as string | undefined,
      message: String(e.message ?? err),
      constraint: (e.constraint_name ?? e.constraint) as string | undefined,
    };
  }
  throw new Error('expected the statement to fail, but it succeeded');
}

function approvalValues(t: PlanTenant, over: Partial<typeof aiOperatorPlanApprovals.$inferInsert> = {}) {
  return {
    orgId: t.orgId, taskId: t.taskId, stepKey: 'offboard', planRevision: 40,
    effectSetDigest: DIGEST, effectCount: 1, state: 'pending', ...over,
  } as typeof aiOperatorPlanApprovals.$inferInsert;
}

function effectValues(
  t: PlanTenant, approvalId: string, over: Partial<typeof aiOperatorPlanApprovalEffects.$inferInsert> = {},
) {
  return {
    orgId: t.orgId, approvalId, taskId: t.taskId, planRevision: 40, ordinal: 0,
    toolName: 'google_suspend_user', provider: 'google', targetId: null, accountExternalId: '101',
    argumentDigest: DIGEST, targetLabel: 'Dana', principalLabel: null, rendering: 'Suspend Dana',
    idempotencyClass: 'idempotent', ...over,
  } as typeof aiOperatorPlanApprovalEffects.$inferInsert;
}

async function insertApproval(t: PlanTenant, over: Partial<typeof aiOperatorPlanApprovals.$inferInsert> = {}) {
  const [row] = await system(() =>
    db.insert(aiOperatorPlanApprovals).values(approvalValues(t, over)).returning());
  return row!;
}

async function seedSecondTask(t: PlanTenant): Promise<string> {
  const [row] = await system(() => db.insert(aiOperatorTasks).values({
    orgId: t.orgId, agentId: t.agentId, agentKind: 'triage', agentName: 'Operator',
    workflowKey: 'service_recovery', workflowVersion: 1, originKind: 'manual' as const,
    requesterUserId: t.aId, objective: 'second task', deviceId: t.deviceId, state: 'running',
    revision: 1, leaseEpoch: 0, deadlineAt: new Date(Date.now() + 3_600_000),
  }).returning({ id: aiOperatorTasks.id }));
  return row!.id;
}

beforeEach(() => { vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true'); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('plan approval tables: tenancy (breeze_app)', () => {
  it('runs as a non-BYPASSRLS role (guards against a vacuous suite)', async () => {
    const t = await seedPlanTenant();
    const rows = await withDbAccessContext(ctxOf(t), () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls FROM pg_roles WHERE rolname = current_user`));
    const row = (rows as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0];
    expect(row?.who).toBe('breeze_app');
    expect(row?.rolbypassrls).toBe(false);
  });

  it('refuses a cross-org INSERT into ai_operator_plan_approvals with an RLS violation', async () => {
    const a = await seedPlanTenant();
    const b = await seedPlanTenant();
    const failure = await pgFail(() =>
      withDbAccessContext(ctxOf(a), () =>
        db.insert(aiOperatorPlanApprovals).values(approvalValues(b))));
    // Pasted into the PR description.
    console.log(`[RLS forge] code=${failure.code} message="${failure.message}"`);
    expect(failure.code).toBe('42501');
    expect(failure.message).toMatch(/row-level security/i);
    // And nothing landed.
    const rows = await system(() => db.select().from(aiOperatorPlanApprovals).where(eq(aiOperatorPlanApprovals.orgId, b.orgId)));
    expect(rows).toHaveLength(0);
  });

  it('refuses a cross-org INSERT into ai_operator_plan_approval_effects (trigger first, RLS WITH CHECK behind it)', async () => {
    const a = await seedPlanTenant();
    const b = await seedPlanTenant();
    const bApproval = await insertApproval(b);
    const forge = () =>
      withDbAccessContext(ctxOf(a), () =>
        db.insert(aiOperatorPlanApprovalEffects).values(effectValues(b, bApproval.id)));

    // The BEFORE closed-set trigger runs under the caller's RLS, cannot see the
    // foreign parent, and refuses before the WITH CHECK is evaluated.
    const viaTrigger = await pgFail(forge);
    console.log(`[RLS forge, effects, trigger armed] code=${viaTrigger.code} message="${viaTrigger.message}"`);
    expect(['42501', 'P0001']).toContain(viaTrigger.code);

    // With the trigger out of the way (owner only, restored in finally) the
    // WITH CHECK policy must independently refuse the same row.
    const o = owner();
    await o.execute(sql`ALTER TABLE ai_operator_plan_approval_effects DISABLE TRIGGER ai_operator_plan_approval_effects_closed_set`);
    try {
      const viaPolicy = await pgFail(forge);
      console.log(`[RLS forge, effects, trigger disabled] code=${viaPolicy.code} message="${viaPolicy.message}"`);
      expect(viaPolicy.code).toBe('42501');
      expect(viaPolicy.message).toMatch(/row-level security/i);
    } finally {
      await o.execute(sql`ALTER TABLE ai_operator_plan_approval_effects ENABLE TRIGGER ai_operator_plan_approval_effects_closed_set`);
    }
    const rows = await system(() => db.select().from(aiOperatorPlanApprovalEffects).where(eq(aiOperatorPlanApprovalEffects.orgId, b.orgId)));
    expect(rows).toHaveLength(0);
  });

  it('hides another org\'s approvals and effects from SELECT (system probe confirms they exist)', async () => {
    const a = await seedPlanTenant();
    const b = await seedPlanTenant();
    const planB = await propose(b);

    const sysApprovals = await system(() => db.select().from(aiOperatorPlanApprovals).where(eq(aiOperatorPlanApprovals.id, planB.approvalId)));
    expect(sysApprovals).toHaveLength(1);

    const seenByA = await withDbAccessContext(ctxOf(a), () => db.select().from(aiOperatorPlanApprovals));
    expect(seenByA).toHaveLength(0);
    const effectsSeenByA = await withDbAccessContext(ctxOf(a), () => db.select().from(aiOperatorPlanApprovalEffects));
    expect(effectsSeenByA).toHaveLength(0);

    // Positive control: the owning org does see them.
    const seenByB = await withDbAccessContext(ctxOf(b), () => db.select().from(aiOperatorPlanApprovals));
    expect(seenByB).toHaveLength(1);
    const effectsSeenByB = await withDbAccessContext(ctxOf(b), () => db.select().from(aiOperatorPlanApprovalEffects));
    expect(effectsSeenByB).toHaveLength(planB.effects.length);
  });
});

describe('plan approval tables: constraints', () => {
  it('an effect naming an approval of a DIFFERENT TASK (same org) is refused', async () => {
    const t = await seedPlanTenant();
    const otherTask = await seedSecondTask(t);
    const approval = await insertApproval(t);

    // Through the app role the closed-set BEFORE trigger (which looks the
    // parent up by id+task+org) refuses first.
    const viaApp = await pgFail(() =>
      withDbAccessContext(ctxOf(t), () =>
        db.insert(aiOperatorPlanApprovalEffects).values(effectValues(t, approval.id, { taskId: otherTask }))));
    console.log(`[cross-task effect via breeze_app] code=${viaApp.code} message="${viaApp.message}"`);
    expect(['23503', 'P0001']).toContain(viaApp.code);

    // The composite FK itself, with the trigger out of the way (owner only,
    // restored in finally): the FK must independently refuse it.
    const o = owner();
    await o.execute(sql`ALTER TABLE ai_operator_plan_approval_effects DISABLE TRIGGER ai_operator_plan_approval_effects_closed_set`);
    try {
      const viaFk = await pgFail(() =>
        o.insert(aiOperatorPlanApprovalEffects).values(effectValues(t, approval.id, { taskId: otherTask })));
      expect(viaFk.code).toBe('23503');
      expect(viaFk.constraint).toBe('ai_operator_plan_approval_effects_approval_task_org_fk');
    } finally {
      await o.execute(sql`ALTER TABLE ai_operator_plan_approval_effects ENABLE TRIGGER ai_operator_plan_approval_effects_closed_set`);
    }
  });

  it('two plans at the same (org, task, revision) collide (23505)', async () => {
    const t = await seedPlanTenant();
    await withDbAccessContext(ctxOf(t), () => db.insert(aiOperatorPlanApprovals).values(approvalValues(t)));
    const failure = await pgFail(() =>
      withDbAccessContext(ctxOf(t), () => db.insert(aiOperatorPlanApprovals).values(approvalValues(t))));
    expect(failure.code).toBe('23505');
    expect(failure.constraint).toBe('ai_operator_plan_approvals_task_revision_uq');
  });

  it('approved without approved_at is refused (23514 approved_chk)', async () => {
    const t = await seedPlanTenant();
    // A real intent id so intent_link_chk is satisfied and approved_chk is the
    // constraint that fires.
    const plan = await propose(t);
    const failure = await pgFail(() =>
      withDbAccessContext(ctxOf(t), () =>
        db.insert(aiOperatorPlanApprovals).values(approvalValues(t, {
          state: 'approved', intentId: plan.intentId, approvedByUserId: t.bId, approvedAt: null,
        }))));
    expect(failure.code).toBe('23514');
    expect(failure.constraint).toBe('ai_operator_plan_approvals_approved_chk');
  });

  it('approved with approved_at but a NULL approver is accepted by the schema (approver FK is ON DELETE SET NULL)', async () => {
    const t = await seedPlanTenant();
    const plan = await propose(t);
    // propose() already linked the plan intent (intent_uq), so the approved
    // shape is reached by the lifecycle UPDATE the approval CAS performs.
    const [row] = await withDbAccessContext(ctxOf(t), () =>
      db.update(aiOperatorPlanApprovals)
        .set({ state: 'approved', approvedByUserId: null, approvedAt: new Date() })
        .where(eq(aiOperatorPlanApprovals.id, plan.approvalId))
        .returning());
    expect(row!.state).toBe('approved');
    expect(row!.approvedByUserId).toBeNull();
  });

  it.each(['approved', 'rejected'] as const)('%s without an intent link is refused (23514 intent_link_chk)', async (state) => {
    const t = await seedPlanTenant();
    const failure = await pgFail(() =>
      withDbAccessContext(ctxOf(t), () =>
        db.insert(aiOperatorPlanApprovals).values(approvalValues(t, {
          state, approvedByUserId: t.bId, approvedAt: new Date(), intentId: null,
        }))));
    expect(failure.code).toBe('23514');
    expect(failure.constraint).toBe('ai_operator_plan_approvals_intent_link_chk');
  });

  it('superseded without superseded_by_revision is refused (23514)', async () => {
    const t = await seedPlanTenant();
    const failure = await pgFail(() =>
      withDbAccessContext(ctxOf(t), () =>
        db.insert(aiOperatorPlanApprovals).values(approvalValues(t, { state: 'superseded' }))));
    expect(failure.code).toBe('23514');
    expect(failure.constraint).toBe('ai_operator_plan_approvals_superseded_chk');
  });

  it('a breeze-provider effect carrying account_external_id is refused (23514)', async () => {
    const t = await seedPlanTenant();
    const approval = await insertApproval(t);
    const failure = await pgFail(() =>
      withDbAccessContext(ctxOf(t), () =>
        db.insert(aiOperatorPlanApprovalEffects).values(
          effectValues(t, approval.id, { provider: 'breeze', accountExternalId: 'should-not-be-here' }))));
    expect(failure.code).toBe('23514');
    expect(failure.constraint).toBe('ai_operator_plan_approval_effects_account_chk');
    // Control: the same row without the account id is accepted.
    await withDbAccessContext(ctxOf(t), () =>
      db.insert(aiOperatorPlanApprovalEffects).values(
        effectValues(t, approval.id, { provider: 'breeze', accountExternalId: null })));
  });
});

describe('plan approval tables: immutability', () => {
  async function proposed() {
    const t = await seedPlanTenant();
    const plan = await propose(t);
    return { t, plan };
  }

  it('an effect row UPDATE raises even as table owner (trigger), and breeze_app has no UPDATE privilege', async () => {
    const { t, plan } = await proposed();
    const ownerFailure = await pgFail(() =>
      owner().update(aiOperatorPlanApprovalEffects)
        .set({ toolName: 'google_signout' })
        .where(eq(aiOperatorPlanApprovalEffects.approvalId, plan.approvalId)));
    expect(ownerFailure.message).toMatch(/immutable/i);

    const appFailure = await pgFail(() =>
      withDbAccessContext(ctxOf(t), () =>
        db.update(aiOperatorPlanApprovalEffects)
          .set({ toolName: 'google_signout' })
          .where(eq(aiOperatorPlanApprovalEffects.approvalId, plan.approvalId))));
    expect(appFailure.code).toBe('42501');
    expect(appFailure.message).toMatch(/permission denied/i);

    const rows = await owner().execute(sql`SELECT has_table_privilege('breeze_app', 'ai_operator_plan_approval_effects', 'UPDATE') AS can_update`);
    expect((rows as unknown as Array<{ can_update: boolean }>)[0]?.can_update).toBe(false);

    // Nothing moved.
    const effects = await system(() => db.select().from(aiOperatorPlanApprovalEffects).where(eq(aiOperatorPlanApprovalEffects.approvalId, plan.approvalId)));
    expect(effects.map((e) => e.toolName).sort()).toEqual(plan.effects.map((e) => e.toolName).sort());
  });

  it.each([
    ['effect_set_digest', { effectSetDigest: 'b'.repeat(64) }],
    ['plan_revision', { planRevision: 41 }],
    ['step_key', { stepKey: 'something-else' }],
    ['effect_count', { effectCount: 1 }],
  ] as const)('approval content UPDATE of %s raises', async (_name, patch) => {
    const { t, plan } = await proposed();
    const failure = await pgFail(() =>
      withDbAccessContext(ctxOf(t), () =>
        db.update(aiOperatorPlanApprovals).set(patch).where(eq(aiOperatorPlanApprovals.id, plan.approvalId))));
    expect(failure.message).toMatch(/content is immutable/i);
    const [row] = await system(() => db.select().from(aiOperatorPlanApprovals).where(eq(aiOperatorPlanApprovals.id, plan.approvalId)));
    expect(row!.effectSetDigest).toBe(plan.effectSetDigest);
    expect(row!.planRevision).toBe(PLAN_REVISION);
  });

  it('re-pointing an already-set intent_id raises', async () => {
    const { t, plan } = await proposed();
    const [before] = await system(() => db.select().from(aiOperatorPlanApprovals).where(eq(aiOperatorPlanApprovals.id, plan.approvalId)));
    expect(before!.intentId).toBe(plan.intentId);
    const failure = await pgFail(() =>
      withDbAccessContext(ctxOf(t), () =>
        db.update(aiOperatorPlanApprovals).set({ intentId: randomUUID() }).where(eq(aiOperatorPlanApprovals.id, plan.approvalId))));
    expect(failure.message).toMatch(/content is immutable/i);
  });

  it('a lifecycle UPDATE (pending -> expired) succeeds', async () => {
    const { t, plan } = await proposed();
    const updated = await withDbAccessContext(ctxOf(t), () =>
      db.update(aiOperatorPlanApprovals).set({ state: 'expired', updatedAt: new Date() })
        .where(and(eq(aiOperatorPlanApprovals.id, plan.approvalId), eq(aiOperatorPlanApprovals.state, 'pending')))
        .returning({ id: aiOperatorPlanApprovals.id }));
    expect(updated).toHaveLength(1);
    const [row] = await system(() => db.select().from(aiOperatorPlanApprovals).where(eq(aiOperatorPlanApprovals.id, plan.approvalId)));
    expect(row!.state).toBe('expired');
  });

  it('inserting an effect once the approval has its intent link raises (closed set)', async () => {
    const { t, plan } = await proposed();
    const failure = await pgFail(() =>
      withDbAccessContext(ctxOf(t), () =>
        db.insert(aiOperatorPlanApprovalEffects).values(effectValues(t, plan.approvalId, {
          planRevision: PLAN_REVISION, ordinal: 9, toolName: 'google_signout',
        }))));
    expect(failure.message).toMatch(/closed/i);
    const rows = await system(() => db.select().from(aiOperatorPlanApprovalEffects).where(eq(aiOperatorPlanApprovalEffects.approvalId, plan.approvalId)));
    expect(rows).toHaveLength(plan.effects.length);
  });

  it('deleting the task cascades both plan tables away', async () => {
    const { t, plan } = await proposed();
    // The task has unrelated dependents (the admitting run); this test is about
    // the plan tables, so clear that one first.
    const o = owner();
    await o.execute(sql`DELETE FROM ai_agent_runs WHERE task_id = ${t.taskId}`);
    await o.delete(aiOperatorTasks).where(eq(aiOperatorTasks.id, t.taskId));
    const approvals = await system(() => db.select().from(aiOperatorPlanApprovals).where(eq(aiOperatorPlanApprovals.id, plan.approvalId)));
    const effects = await system(() => db.select().from(aiOperatorPlanApprovalEffects).where(eq(aiOperatorPlanApprovalEffects.approvalId, plan.approvalId)));
    expect(approvals).toHaveLength(0);
    expect(effects).toHaveLength(0);
  });
});
