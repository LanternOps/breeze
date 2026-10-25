/**
 * Tool catalog W04 (#5219), plan Task A8 — the run lease, the fenced
 * checkpoint and run admission against REAL Postgres: the token predicate,
 * the terminal guard (flow_runs_immutable_trg), `now()` on the DB clock and
 * the per-owner advisory lock. The branch logic is unit-tested
 * (runLease.test.ts, runAdmission.test.ts, jobs/flowRunner.test.ts) against a
 * mocked store; this file proves the store's SQL means what those tests
 * assume.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { flowRuns, flowRunSteps } from '../../db/schema';
import { acquireRunLease, checkpoint, releaseRunLease } from '../../services/flows/runLease';
import { assertActiveCapacity, claimRunSlot } from '../../services/flows/runAdmission';
import { createOrganization, createPartner, createUser } from './db-utils';
import { readFlowRunState, seedEnabledFlowRun, type SeededFlowRun } from './helpers/flowSeed';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const PIN = { stepId: 'cleanup', tool: 'list_devices', source: 'core', tier: 1, approvalScope: null } as const;

async function seed(): Promise<{ seed: SeededFlowRun; orgId: string; partnerId: string }> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const delegator = await createUser({ partnerId: partner.id, orgId: org.id, email: `delegator-${randomUUID()}@flowlease.test` });
  const s = await seedEnabledFlowRun({
    orgId: org.id,
    partnerId: partner.id,
    delegatorUserId: delegator.id,
    tool: PIN.tool,
    pin: PIN,
  });
  return { seed: s, orgId: org.id, partnerId: partner.id };
}

function system<T>(fn: () => Promise<T>): Promise<T> {
  return withSystemDbAccessContext(fn);
}

async function expireLease(runId: string): Promise<void> {
  await system(() => db.update(flowRuns)
    .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
    .where(eq(flowRuns.id, runId)));
}

async function insertSiblingRun(s: SeededFlowRun, orgId: string, status: 'queued' | 'running' = 'queued'): Promise<string> {
  const [row] = await system(() => db.insert(flowRuns).values({
    orgId,
    flowId: s.flowId,
    flowVersionId: s.publicationId,
    definitionVersion: 1,
    triggerKind: 'schedule',
    triggeredVia: 'scheduler',
    triggerPayload: {},
    inputs: {},
    status,
    preApprovalsHonored: false,
    dedupeKey: `schedule:${randomUUID()}`,
    ...(status === 'running' ? { startedAt: new Date() } : {}),
  }).returning({ id: flowRuns.id }));
  return row!.id;
}

describe('flow run lease + fenced checkpoint (real Postgres)', () => {
  runDb('acquireRunLease twice ⇒ the second is null; an expired lease is taken over', async () => {
    const { seed: s } = await seed();
    const first = await acquireRunLease(s.runId, ['running']);
    expect(first?.token).toMatch(/^[0-9a-f-]{36}$/);
    await expect(acquireRunLease(s.runId, ['running'])).resolves.toBeNull();
    // A status outside `expect` is never leased.
    await expireLease(s.runId);
    await expect(acquireRunLease(s.runId, ['queued'])).resolves.toBeNull();

    const takeover = await acquireRunLease(s.runId, ['running']);
    expect(takeover?.token).toBeDefined();
    expect(takeover!.token).not.toBe(first!.token);
    const { run } = await readFlowRunState(s);
    expect(run.leaseToken).toBe(takeover!.token);
    // lease_expires_at ≈ now() + 6 min on the DB clock
    expect(run.leaseExpiresAt!.getTime() - Date.now()).toBeGreaterThan(5 * 60_000);
  });

  runDb('a superseded-token checkpoint returns false and leaves the run and step rows unchanged', async () => {
    const { seed: s } = await seed();
    const stale = await acquireRunLease(s.runId, ['running']);
    await expireLease(s.runId);
    const fresh = await acquireRunLease(s.runId, ['running']);
    expect(fresh).not.toBeNull();
    const before = await readFlowRunState(s);

    const ok = await checkpoint(s.runId, stale!.token, { currentStepId: 'late', activeMs: 99_999 }, {
      update: { id: s.stepRowId, values: { status: 'completed', output: { late: true }, finishedAt: new Date() } },
      insert: {
        id: randomUUID(), runId: s.runId, orgId: before.run.orgId, stepId: 'late', tool: PIN.tool,
        toolSource: 'core', tier: 1, status: 'running',
      },
    });
    expect(ok).toBe(false);
    const after = await readFlowRunState(s);
    expect(after.run.currentStepId).toBe(before.run.currentStepId);
    expect(after.run.activeMs).toBe(before.run.activeMs);
    expect(after.run.leaseToken).toBe(fresh!.token);
    expect(after.step).toMatchObject({ status: 'running', output: null, finishedAt: null });
    const lateRows = await system(() => db.select().from(flowRunSteps).where(eq(flowRunSteps.stepId, 'late')));
    expect(lateRows).toHaveLength(0);

    // The live token writes.
    const live = await checkpoint(s.runId, fresh!.token, { currentStepId: 'cleanup', activeMs: 42 }, {
      update: { id: s.stepRowId, values: { status: 'completed', output: { ok: true }, finishedAt: new Date() } },
    });
    expect(live).toBe(true);
    const written = await readFlowRunState(s);
    expect(written.run.activeMs).toBe(42);
    expect(written.step).toMatchObject({ status: 'completed', output: { ok: true } });
  });

  runDb('a step attempt conflict rolls the whole checkpoint back', async () => {
    const { seed: s, orgId } = await seed();
    const lease = await acquireRunLease(s.runId, ['running']);
    const ok = await checkpoint(s.runId, lease!.token, { activeMs: 7 }, {
      // (run_id, step_id, item_index, attempt) = the seeded row's key
      insert: { id: randomUUID(), runId: s.runId, orgId, stepId: s.stepId, tool: PIN.tool, toolSource: 'core', tier: 1, status: 'running', attempt: 1 },
    });
    expect(ok).toBe(false);
    const after = await readFlowRunState(s);
    expect(after.run.activeMs).toBe(0);
  });

  runDb('a terminal run: its status UPDATE raises, and a checkpoint with its token returns false', async () => {
    const { seed: s } = await seed();
    const lease = await acquireRunLease(s.runId, ['running']);
    // Finish it the way an outside writer would, leaving the token in place.
    await system(() => db.update(flowRuns)
      .set({ status: 'failed', errorCode: 'drift', finishedAt: new Date() })
      .where(eq(flowRuns.id, s.runId)));

    const raised = await system(() => db.update(flowRuns)
      .set({ status: 'running', finishedAt: null })
      .where(eq(flowRuns.id, s.runId))).then(() => null, (err: unknown) => err);
    // Drizzle wraps the driver error; flow_runs_immutable_trg's text is on `.cause`.
    const cause = (raised as { cause?: { message?: string } } | null)?.cause?.message ?? '';
    expect(cause).toMatch(/terminal status is final/);

    await expect(checkpoint(s.runId, lease!.token, { activeMs: 5 })).resolves.toBe(false);
    const after = await readFlowRunState(s);
    expect(after.run.status).toBe('failed');
    expect(after.run.activeMs).toBe(0);
  });

  runDb('releaseRunLease clears only its own token', async () => {
    const { seed: s } = await seed();
    const lease = await acquireRunLease(s.runId, ['running']);
    await releaseRunLease(s.runId, randomUUID());
    expect((await readFlowRunState(s)).run.leaseToken).toBe(lease!.token);
    await releaseRunLease(s.runId, lease!.token);
    const { run } = await readFlowRunState(s);
    expect(run.leaseToken).toBeNull();
    expect(run.leaseExpiresAt).toBeNull();
  });
});

describe('claimRunSlot (real Postgres)', () => {
  runDb('refuses a second running run for the same (flow, org); admits it once the first finishes', async () => {
    const { seed: s, orgId, partnerId } = await seed(); // the seeded run is `running`
    const owner = { orgId, partnerId };
    const second = await insertSiblingRun(s, orgId, 'queued');
    const lease = await acquireRunLease(second, ['queued']);
    const ref = { id: second, flowId: s.flowId, orgId };

    await expect(claimRunSlot(ref, owner, lease!.token)).resolves.toBe(false);
    const [stillQueued] = await system(() => db.select().from(flowRuns).where(eq(flowRuns.id, second)));
    expect(stillQueued!.status).toBe('queued');

    await system(() => db.update(flowRuns)
      .set({ status: 'completed', finishedAt: new Date() })
      .where(eq(flowRuns.id, s.runId)));
    await expect(claimRunSlot(ref, owner, lease!.token)).resolves.toBe(true);
    const [admitted] = await system(() => db.select().from(flowRuns).where(eq(flowRuns.id, second)));
    expect(admitted).toMatchObject({ status: 'running', wakeAt: null });
    expect(admitted!.startedAt).toBeInstanceOf(Date);
  });

  runDb('a run already running holds its own slot; a stale token is refused', async () => {
    const { seed: s, orgId, partnerId } = await seed();
    const lease = await acquireRunLease(s.runId, ['running']);
    const ref = { id: s.runId, flowId: s.flowId, orgId };
    await expect(claimRunSlot(ref, { orgId, partnerId }, lease!.token)).resolves.toBe(true);
    await expect(claimRunSlot(ref, { orgId, partnerId }, randomUUID())).resolves.toBe(false);
  });

  runDb('a waiting run is admitted with wake_at cleared in the same write', async () => {
    const { seed: s, orgId, partnerId } = await seed();
    await system(() => db.update(flowRuns)
      .set({ status: 'waiting', wakeAt: sql`now() - interval '1 second'` })
      .where(eq(flowRuns.id, s.runId)));
    const lease = await acquireRunLease(s.runId, ['waiting']);
    await expect(claimRunSlot({ id: s.runId, flowId: s.flowId, orgId }, { orgId, partnerId }, lease!.token)).resolves.toBe(true);
    const { run } = await readFlowRunState(s);
    expect(run).toMatchObject({ status: 'running', wakeAt: null });
  });

  runDb('assertActiveCapacity counts the owner’s active runs', async () => {
    const { orgId, partnerId } = await seed();
    await expect(assertActiveCapacity({ orgId, partnerId })).resolves.toEqual({ ok: true });
  });
});
