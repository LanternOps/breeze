/**
 * AI Operator thin-slice schema contract (#5205 W03, #5208).
 * Migration: migrations/2026-10-14-100000-ai-operator-thin-slice.sql.
 *
 * Every invariant proved here lives in a CHECK, a composite FK, a unique index,
 * an RLS policy or a DB trigger — none of which a mocked Drizzle client
 * evaluates, and `pnpm db:check-drift` does not compare the Drizzle schema to
 * the database (scripts/check-drift.ts), so this suite is the only automated
 * thing that would catch a mis-modelled column or a transposed composite-FK
 * column pair.
 *
 * Deliberately NOT asserted here, because another suite already owns it and
 * duplicating it would rot: that every composite FK referencing an `org_id`
 * column is DEFERRABLE (orgLifecycleFoundations.integration.test.ts scans
 * pg_constraint for the whole schema), and that every org_id table is in the
 * cascade list (tenantCascade.integration.test.ts). What IS asserted here is
 * the BEHAVIOUR deferrability exists for — a merge-shaped parent-then-child
 * repoint inside one transaction — because a constraint can be deferrable and
 * still have the wrong column pair.
 *
 * Fixtures are seeded per-test (not in beforeAll): the shared integration
 * setup TRUNCATEs core tenant tables in a global beforeEach, and every table
 * here hangs off organizations.
 */
import './setup';
import { getTestDb } from './setup';

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  db,
  runOutsideDbContext,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { deleteDeviceCascade, type DeviceDeletionTx } from '../../services/deviceDeletion';
import {
  actionIntents,
  aiAgents,
  aiAgentRuns,
  aiOperatorOperations,
  aiOperatorTaskOutbox,
  aiOperatorTasks,
  devices,
} from '../../db/schema';
import { CUSTOM_RESOLVE_EXECUTORS, CUSTOM_WOULD_REVOKE_COUNTS } from '../../services/orgMergeCustomExecutors';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
};

function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [] };
}

/**
 * Drizzle/postgres-js wraps the Postgres error in a `DrizzleQueryError` whose
 * own `.code` is undefined — the SQLSTATE lands on `.cause.code`. A plain
 * `.rejects.toMatchObject({ code })` silently mismatches.
 */
async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  const cause = (raised as { cause?: { code?: string } })?.cause;
  expect(cause?.code ?? (raised as { code?: string })?.code).toBe(code);
}

interface Tenant {
  partnerId: string;
  orgId: string;
  userId: string;
  agentId: string;
  siteId: string;
}

async function seedTenant(partnerId?: string): Promise<Tenant> {
  const partner = partnerId ? { id: partnerId } : await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id });
  const site = await createSite({ orgId: org.id });
  const [agent] = await withDbAccessContext(SYSTEM_CTX, () =>
    db
      .insert(aiAgents)
      .values({ orgId: org.id, partnerId: null, kind: 'triage', name: 'Triage', createdBy: user.id })
      .returning(),
  );
  return { partnerId: partner.id, orgId: org.id, userId: user.id, agentId: agent!.id, siteId: site.id };
}

function taskValues(t: Tenant, overrides: Partial<typeof aiOperatorTasks.$inferInsert> = {}) {
  return {
    orgId: t.orgId,
    agentId: t.agentId,
    agentKind: 'triage',
    agentName: 'Triage',
    workflowKey: 'service_recovery',
    workflowVersion: 1,
    originKind: 'manual' as const,
    requesterUserId: t.userId,
    objective: 'Restart the print spooler on PRINTSRV01',
    ...overrides,
  };
}

async function insertTask(t: Tenant, overrides: Partial<typeof aiOperatorTasks.$inferInsert> = {}): Promise<string> {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(aiOperatorTasks).values(taskValues(t, overrides)).returning({ id: aiOperatorTasks.id }),
  );
  return row!.id;
}

async function insertDevice(orgId: string, siteId: string): Promise<string> {
  const adminDb = getTestDb() as never as typeof db;
  const unique = randomUUID().slice(0, 8);
  const [device] = await adminDb
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `operator-agent-${unique}`,
      hostname: `operator-host-${unique}`,
      osType: 'linux',
      osVersion: '22.04',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'offline',
    })
    .returning();
  return (device as { id: string }).id;
}

describe('AI Operator thin-slice schema', () => {
  let t: Tenant;
  let attacker: Tenant;

  beforeEach(async () => {
    t = await seedTenant();
    // Second org under the SAME partner: a cross-tenant forge that a partner
    // token could plausibly attempt is the interesting case, not two unrelated
    // partners.
    attacker = await seedTenant(t.partnerId);
  });

  // -------------------------------------------------------------------------
  // RLS — the forge every new tenant table owes (CLAUDE.md step 6)
  // -------------------------------------------------------------------------

  describe('RLS as breeze_app', () => {
    it('POSITIVE CONTROL: an ORG-scoped context can insert its own rows into all three tables', async () => {
      // Without this, the three forge tests below are half a test: a WITH CHECK
      // policy broken to deny EVERY org-scoped insert (own org included) would
      // leave all three of them passing while the W04 write path is dead. Every
      // other successful insert in this file goes through SYSTEM_CTX or the
      // admin connection, so this is the only proof the org path works at all.
      const ctx = orgContext(t.orgId);
      const [task] = await withDbAccessContext(ctx, () =>
        db.insert(aiOperatorTasks).values(taskValues(t)).returning({ id: aiOperatorTasks.id }),
      );
      expect(task!.id).toBeTruthy();

      const [op] = await withDbAccessContext(ctx, () =>
        db
          .insert(aiOperatorOperations)
          .values({
            orgId: t.orgId,
            taskId: task!.id,
            taskStepKey: 'restart',
            operationKey: 'restart:spooler:1',
            argumentDigest: 'a'.repeat(64),
          })
          .returning({ id: aiOperatorOperations.id }),
      );
      expect(op!.id).toBeTruthy();

      const [wake] = await withDbAccessContext(ctx, () =>
        db
          .insert(aiOperatorTaskOutbox)
          .values({
            orgId: t.orgId,
            taskId: task!.id,
            sourceKind: 'intent',
            sourceId: randomUUID(),
            transitionSeq: 1,
          })
          .returning({ id: aiOperatorTaskOutbox.id }),
      );
      expect(wake!.id).toBeTruthy();
    });

    it('cannot UPDATE or DELETE another org\'s task', async () => {
      const victim = await insertTask(t);
      const ctx = orgContext(attacker.orgId);

      // RLS filters the row out rather than raising, so the assertion has to be
      // on the row COUNT and on the victim row still being intact — a rejected
      // statement and a silently-zero-row statement look identical otherwise.
      await withDbAccessContext(ctx, () =>
        db.update(aiOperatorTasks).set({ state: 'cancelled' }).where(eq(aiOperatorTasks.id, victim)),
      );
      await withDbAccessContext(ctx, () =>
        db.delete(aiOperatorTasks).where(eq(aiOperatorTasks.id, victim)),
      );

      const after = (await withDbAccessContext(SYSTEM_CTX, () =>
        db.execute(sql`SELECT state FROM ai_operator_tasks WHERE id = ${victim}::uuid`),
      )) as unknown as Array<{ state: string }>;
      expect(after).toHaveLength(1);
      expect(after[0]!.state).toBe('queued');

      // Positive control: the SAME statements under the OWNING org do land, so
      // the two no-ops above are RLS and not a broken WHERE clause.
      await withDbAccessContext(orgContext(t.orgId), () =>
        db.update(aiOperatorTasks).set({ state: 'cancelled' }).where(eq(aiOperatorTasks.id, victim)),
      );
      const owned = (await withDbAccessContext(SYSTEM_CTX, () =>
        db.execute(sql`SELECT state FROM ai_operator_tasks WHERE id = ${victim}::uuid`),
      )) as unknown as Array<{ state: string }>;
      expect(owned[0]!.state).toBe('cancelled');
    });

    it('rejects a cross-org ai_operator_tasks forge (42501)', async () => {
      await expectSqlState(
        () =>
          withDbAccessContext(orgContext(attacker.orgId), () =>
            db.insert(aiOperatorTasks).values(taskValues({ ...t })).returning(),
          ),
        '42501',
      );
    });

    it('rejects a cross-org ai_operator_operations forge (42501)', async () => {
      const taskId = await insertTask(t);
      await expectSqlState(
        () =>
          withDbAccessContext(orgContext(attacker.orgId), () =>
            db
              .insert(aiOperatorOperations)
              .values({
                orgId: t.orgId,
                taskId,
                taskStepKey: 'restart',
                operationKey: 'restart:spooler:1',
                argumentDigest: 'a'.repeat(64),
              })
              .returning(),
          ),
        '42501',
      );
    });

    it('rejects a cross-org ai_operator_task_outbox forge (42501)', async () => {
      const taskId = await insertTask(t);
      await expectSqlState(
        () =>
          withDbAccessContext(orgContext(attacker.orgId), () =>
            db
              .insert(aiOperatorTaskOutbox)
              .values({
                orgId: t.orgId,
                taskId,
                sourceKind: 'intent',
                sourceId: randomUUID(),
                transitionSeq: 1,
              })
              .returning(),
          ),
        '42501',
      );
    });

    it('hides another org\'s tasks from a SELECT (positive control: own rows are visible)', async () => {
      const mine = await insertTask(t);
      await insertTask(attacker);

      const visible = await withDbAccessContext(orgContext(t.orgId), () =>
        db.select({ id: aiOperatorTasks.id }).from(aiOperatorTasks),
      );
      // The positive half matters: an empty result would "pass" a
      // not-visible assertion while proving only that the context is broken.
      expect(visible.map((r) => r.id)).toEqual([mine]);
    });
  });

  // -------------------------------------------------------------------------
  // CHECK constraints
  // -------------------------------------------------------------------------

  describe('all-or-none task linkage CHECKs', () => {
    it('rejects a partially linked action_intents row (23514)', async () => {
      const taskId = await insertTask(t);
      await expectSqlState(
        () =>
          withSystemDbAccessContext(() =>
            db
              .insert(actionIntents)
              .values({
                orgId: t.orgId,
                partnerId: t.partnerId,
                source: 'chat',
                originPrincipalKind: 'unknown',
                actionName: 'device.restart_service',
                arguments: { service: 'spooler' },
                argumentDigest: 'a'.repeat(64),
                targetSummary: 'Restart spooler',
                impactSummary: 'Service restarts',
                riskTier: 3,
                idempotencyKey: `idem-${randomUUID()}`,
                correlationId: randomUUID(),
                expiresAt: new Date(Date.now() + 3_600_000),
                requestedByUserId: t.userId,
                // task_id set, the other two left NULL — exactly what the
                // CHECK exists to forbid.
                taskId,
              })
              .returning(),
          ),
        '23514',
      );
    });

    it('rejects a partially linked ai_agent_runs row (23514)', async () => {
      const taskId = await insertTask(t);
      await expectSqlState(
        () =>
          withSystemDbAccessContext(() =>
            db
              .insert(aiAgentRuns)
              .values({
                agentId: t.agentId,
                orgId: t.orgId,
                triggerKind: 'alert',
                dedupeKey: `operator-${randomUUID()}`,
                modeAtStart: 'shadow',
                policySnapshot: { schemaVersion: 1 } as never,
                taskId,
                taskStepKey: 'restart',
                // task_attempt_ordinal deliberately omitted.
              })
              .returning(),
          ),
        '23514',
      );
    });

    it('accepts a fully linked ai_agent_runs row and rejects a duplicate admission (23505)', async () => {
      const taskId = await insertTask(t);
      const admission = {
        agentId: t.agentId,
        orgId: t.orgId,
        triggerKind: 'alert' as const,
        modeAtStart: 'shadow' as const,
        policySnapshot: { schemaVersion: 1 } as never,
        taskId,
        taskStepKey: 'restart',
        taskAttemptOrdinal: 0,
      };
      await withSystemDbAccessContext(() =>
        db.insert(aiAgentRuns).values({ ...admission, dedupeKey: `operator-${randomUUID()}` }).returning(),
      );
      await expectSqlState(
        () =>
          withSystemDbAccessContext(() =>
            db.insert(aiAgentRuns).values({ ...admission, dedupeKey: `operator-${randomUUID()}` }).returning(),
          ),
        '23505',
      );
    });

    it('rejects a detach stamp with a reason but no timestamp (23514)', async () => {
      await expectSqlState(
        () => insertTask(t, { targetDetachedReason: 'device_moved' }),
        '23514',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Operation identity
  // -------------------------------------------------------------------------

  describe('operation identity', () => {
    it('permanently rejects a replayed (org, task, operation_key) even after the first is terminal (23505)', async () => {
      const taskId = await insertTask(t);
      const values = {
        orgId: t.orgId,
        taskId,
        taskStepKey: 'restart',
        operationKey: 'restart:spooler:1',
        argumentDigest: 'a'.repeat(64),
      };
      await withDbAccessContext(SYSTEM_CTX, () => db.insert(aiOperatorOperations).values(values).returning());

      // Terminalise the first operation. This is the whole point of the
      // no-status-predicate unique (baseline H2/C7): the intent's live-only
      // index would have released the key here, while the effect may still be
      // in flight on the device.
      await withDbAccessContext(SYSTEM_CTX, () =>
        db
          .update(aiOperatorOperations)
          .set({ dispatchState: 'dispatched', resultState: 'succeeded', resultAt: new Date() })
          .where(and(eq(aiOperatorOperations.taskId, taskId), eq(aiOperatorOperations.orgId, t.orgId))),
      );

      await expectSqlState(
        () =>
          withDbAccessContext(SYSTEM_CTX, () =>
            db.insert(aiOperatorOperations).values({ ...values, attemptOrdinal: 1 }).returning(),
          ),
        '23505',
      );
    });

    it('does NOT carry a second unique arbiter on action_intents (org_id, task_id, operation_key)', async () => {
      // Baseline H1/C6: a second partial UNIQUE would make createActionIntent's
      // ON CONFLICT (org_id, idempotency_key) raise a bare 23505 instead of an
      // idempotent replay. Assert the index exists and is NOT unique, so
      // "upgrading" it is a test failure rather than a silent production bug.
      const rows = (await withDbAccessContext(SYSTEM_CTX, () =>
        db.execute(sql`
          SELECT indexname, indexdef
            FROM pg_indexes
           WHERE schemaname = 'public'
             AND tablename = 'action_intents'
             AND indexdef LIKE '%operation_key%'`),
      )) as unknown as Array<{ indexname: string; indexdef: string }>;

      expect(rows.map((r) => r.indexname)).toEqual(['action_intents_task_operation_idx']);
      expect(rows[0]!.indexdef).not.toContain('UNIQUE');
    });
  });

  // -------------------------------------------------------------------------
  // Deferrability, proved by the behaviour it exists for
  // -------------------------------------------------------------------------

  it('allows a merge-shaped parent-then-child org repoint in one transaction', async () => {
    const taskId = await insertTask(t);
    await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .insert(aiOperatorOperations)
        .values({
          orgId: t.orgId,
          taskId,
          taskStepKey: 'restart',
          operationKey: 'restart:spooler:1',
          argumentDigest: 'a'.repeat(64),
        })
        .returning(),
    );

    // The org merge shape: SET CONSTRAINTS ALL DEFERRED, then move parent and
    // child org_id in SEPARATE statements. With a non-deferrable composite FK
    // the second statement raises 23503 and the whole merge aborts (#4585).
    // ai_operator_tasks.org_id is immutable by policy, not by trigger, so this
    // is a synthetic exercise of the CONSTRAINT, not a sanctioned operation.
    const adminDb = getTestDb() as never as typeof db;
    await adminDb.transaction(async (tx) => {
      await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      await tx.execute(sql`UPDATE ai_operator_tasks SET org_id = ${attacker.orgId}::uuid WHERE id = ${taskId}::uuid`);
      await tx.execute(
        sql`UPDATE ai_operator_operations SET org_id = ${attacker.orgId}::uuid WHERE task_id = ${taskId}::uuid`,
      );
    });

    const moved = (await withDbAccessContext(SYSTEM_CTX, () =>
      db.execute(sql`SELECT org_id FROM ai_operator_operations WHERE task_id = ${taskId}::uuid`),
    )) as unknown as Array<{ org_id: string }>;
    expect(moved[0]!.org_id).toBe(attacker.orgId);
  });

  it('rejects a cross-org operation->task pointer even under system context (23503)', async () => {
    const taskId = await insertTask(t);
    await expectSqlState(
      () =>
        withDbAccessContext(SYSTEM_CTX, () =>
          db
            .insert(aiOperatorOperations)
            .values({
              // org_id from the attacker, task_id from the victim: same-org
              // alone is not the invariant, the composite FK is.
              orgId: attacker.orgId,
              taskId,
              taskStepKey: 'restart',
              operationKey: 'restart:spooler:1',
              argumentDigest: 'a'.repeat(64),
            })
            .returning(),
        ),
      '23503',
    );
  });

  // -------------------------------------------------------------------------
  // Task deletion vs. the all-or-none CHECK groups (Codex quorum findings 1-2)
  // -------------------------------------------------------------------------

  describe('deleting a referenced task', () => {
    it('is refused (23503) rather than half-clearing an action_intents link', async () => {
      // The trap this pins: `ON DELETE SET NULL (task_id)` can null only
      // columns of the FK, so it would leave task_step_key/operation_key set
      // and raise 23514 from action_intents_task_link_chk — deferring the FK
      // does not defer the CHECK. RESTRICT states the invariant honestly.
      const taskId = await insertTask(t);
      await withSystemDbAccessContext(() =>
        db.insert(actionIntents).values({
          orgId: t.orgId,
          partnerId: t.partnerId,
          source: 'chat',
          originPrincipalKind: 'unknown',
          actionName: 'device.restart_service',
          arguments: { service: 'spooler' },
          argumentDigest: 'a'.repeat(64),
          targetSummary: 'Restart spooler',
          impactSummary: 'Service restarts',
          riskTier: 3,
          idempotencyKey: `idem-${randomUUID()}`,
          correlationId: randomUUID(),
          expiresAt: new Date(Date.now() + 3_600_000),
          requestedByUserId: t.userId,
          taskId,
          taskStepKey: 'restart',
          operationKey: 'restart:spooler:1',
        }),
      );

      await expectSqlState(
        () =>
          withDbAccessContext(SYSTEM_CTX, () =>
            db.delete(aiOperatorTasks).where(eq(aiOperatorTasks.id, taskId)),
          ),
        '23503',
      );
    });

    it('is refused (23503) rather than half-clearing an ai_agent_runs link', async () => {
      const taskId = await insertTask(t);
      await withSystemDbAccessContext(() =>
        db.insert(aiAgentRuns).values({
          agentId: t.agentId,
          orgId: t.orgId,
          triggerKind: 'alert',
          dedupeKey: `operator-${randomUUID()}`,
          modeAtStart: 'shadow',
          policySnapshot: { schemaVersion: 1 } as never,
          taskId,
          taskStepKey: 'restart',
          taskAttemptOrdinal: 0,
        }),
      );

      await expectSqlState(
        () =>
          withDbAccessContext(SYSTEM_CTX, () =>
            db.delete(aiOperatorTasks).where(eq(aiOperatorTasks.id, taskId)),
          ),
        '23503',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Reference lifecycle: device move / device delete detach
  // -------------------------------------------------------------------------

  it('is excluded from the DYNAMIC device-child org re-stamp discovery helper', async () => {
    // breeze_device_child_orgid_tables() returns every table carrying both
    // device_id and org_id MINUS an exclusion list, so simply creating
    // ai_operator_tasks enrolled it in the re-stamp loop. Being absent from the
    // TypeScript CORE_DEVICE_ORG_DENORMALIZED_TABLES list is NOT sufficient —
    // the DB trigger drives its own discovery. Without the exclusion the loop
    // would set the task's immutable org_id to the destination org.
    const rows = (await withDbAccessContext(SYSTEM_CTX, () =>
      db.execute(sql`SELECT public.breeze_device_child_orgid_tables() AS t`),
    )) as unknown as Array<{ t: string }>;
    const tables = rows.map((r) => r.t);
    // Positive control: the helper is actually returning a populated list, so
    // "not included" is a real exclusion and not an empty result set.
    expect(tables.length).toBeGreaterThan(10);
    expect(tables).not.toContain('ai_operator_tasks');
    expect(tables).not.toContain('ai_agent_runs');
  });

  it('detaches and fences a live task when the device org changes directly (trigger path)', async () => {
    const deviceId = await insertDevice(t.orgId, t.siteId);
    const liveId = await insertTask(t, {
      deviceId,
      targetLabel: 'PRINTSRV01',
      state: 'waiting',
      waitReason: 'approval',
      nextWakeAt: new Date(Date.now() + 60_000),
      leaseOwner: 'coordinator-1',
    });
    const doneId = await insertTask(t, { deviceId, targetLabel: 'PRINTSRV01', state: 'completed', outcome: 'verified_resolved' });

    // A DIRECT devices.org_id UPDATE bypasses routes/devices/moveOrg.ts
    // entirely — only breeze_cascade_device_org_id() runs. That is the hole
    // this statement closes (baseline §9.1 item 2).
    const adminDb = getTestDb() as never as typeof db;
    await adminDb.execute(
      sql`UPDATE devices SET org_id = ${attacker.orgId}::uuid, site_id = ${attacker.siteId}::uuid WHERE id = ${deviceId}::uuid`,
    );

    const rows = (await withDbAccessContext(SYSTEM_CTX, () =>
      db.execute(sql`
        SELECT id, org_id, device_id, target_label, target_detached_at, target_detached_reason, state
          FROM ai_operator_tasks WHERE id IN (${liveId}::uuid, ${doneId}::uuid)`),
    )) as unknown as Array<Record<string, unknown>>;
    const byId = new Map(rows.map((r) => [r.id as string, r]));

    const live = byId.get(liveId)!;
    expect(live.device_id).toBeNull();
    expect(live.target_detached_reason).toBe('device_moved');
    expect(live.target_detached_at).not.toBeNull();
    // Frozen label survives — the evidence still says what it was pointed at.
    expect(live.target_label).toBe('PRINTSRV01');
    expect(live.state).toBe('stopping');
    // org_id is NOT restamped: task history stays with the source org.
    expect(live.org_id).toBe(t.orgId);

    const done = byId.get(doneId)!;
    expect(done.device_id).toBeNull();
    // A terminal task is detached but never resurrected into 'stopping'.
    expect(done.state).toBe('completed');
  });

  it('detaches, stamps and fences a live task when the device is hard-deleted', async () => {
    // Unlike device MOVE, device DELETE fires no org-change trigger, so
    // deviceDeletion.ts's explicit statement is the ONLY thing that stamps the
    // reason and fences the task. It also carries an ordering invariant worth
    // pinning: `ai_operator_tasks` is in DEVICE_DETACH_DEVICE_ID_TABLES, whose
    // generic loop nulls `device_id` with no stamp — so the specific statement
    // must run FIRST. If someone reorders it after the loop, `WHERE device_id
    // = <id>` matches nothing and every device-deleted task silently loses its
    // detach reason and its fence. This test fails in exactly that case.
    const deviceId = await insertDevice(t.orgId, t.siteId);
    const liveId = await insertTask(t, {
      deviceId,
      targetLabel: 'PRINTSRV01',
      state: 'running',
      leaseOwner: 'coordinator-1',
    });
    const doneId = await insertTask(t, { deviceId, targetLabel: 'PRINTSRV01', state: 'completed' });

    await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db.transaction(async (tx) => {
          await deleteDeviceCascade(tx as unknown as DeviceDeletionTx, deviceId);
        }),
      ),
    );

    const rows = (await withDbAccessContext(SYSTEM_CTX, () =>
      db.execute(sql`
        SELECT id, org_id, device_id, target_label, target_detached_at, target_detached_reason, state
          FROM ai_operator_tasks WHERE id IN (${liveId}::uuid, ${doneId}::uuid)`),
    )) as unknown as Array<Record<string, unknown>>;
    // Positive control: the task rows SURVIVED the device delete. If the table
    // had been (mis)registered in the device cascade-delete list instead of the
    // detach list, this would be 0 and every assertion below would vacuously
    // never run.
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [r.id as string, r]));

    const live = byId.get(liveId)!;
    expect(live.device_id).toBeNull();
    expect(live.target_detached_reason).toBe('device_deleted');
    expect(live.target_detached_at).not.toBeNull();
    expect(live.target_label).toBe('PRINTSRV01');
    expect(live.state).toBe('stopping');
    expect(live.org_id).toBe(t.orgId);

    const done = byId.get(doneId)!;
    expect(done.device_id).toBeNull();
    expect(done.target_detached_reason).toBe('device_deleted');
    expect(done.state).toBe('completed');
  });

  // -------------------------------------------------------------------------
  // Remaining constraint surface
  // -------------------------------------------------------------------------

  describe('constraints', () => {
    it('rejects a detach timestamp with no reason (23514) — the other branch of the CHECK', async () => {
      await expectSqlState(() => insertTask(t, { targetDetachedAt: new Date() }), '23514');
    });

    it('rejects a cross-org accounting-root pointer (23503)', async () => {
      const victimRoot = await insertTask(t);
      await expectSqlState(
        () => insertTask(attacker, { accountingRootTaskId: victimRoot }),
        '23503',
      );
    });

    it('rejects a cross-org successor pointer (23503)', async () => {
      const victimPrior = await insertTask(t);
      await expectSqlState(
        () => insertTask(attacker, { successorOfTaskId: victimPrior }),
        '23503',
      );
    });

    it('accepts a SAME-org lineage pointer (positive control for the two above)', async () => {
      const root = await insertTask(t);
      const child = await insertTask(t, { accountingRootTaskId: root, successorOfTaskId: root });
      expect(child).toBeTruthy();
    });

    it('rejects a task that is its own accounting root (23514)', async () => {
      const id = randomUUID();
      await expectSqlState(
        () =>
          withDbAccessContext(SYSTEM_CTX, () =>
            db.insert(aiOperatorTasks).values({ ...taskValues(t), id, accountingRootTaskId: id }),
          ),
        '23514',
      );
    });

    it('rejects an over-length objective (23514) — the bounded-text CHECKs are live', async () => {
      await expectSqlState(() => insertTask(t, { objective: 'x'.repeat(4001) }), '23514');
    });

    it('rejects an oversized checkpoint (23514) — the jsonb size CHECK is live', async () => {
      await expectSqlState(
        () => insertTask(t, { checkpoint: { blob: 'x'.repeat(70_000) } }),
        '23514',
      );
    });

    it('dedupes outbox wakes on (org, task, source kind, source id, transition) (23505)', async () => {
      const taskId = await insertTask(t);
      const row = {
        orgId: t.orgId,
        taskId,
        sourceKind: 'intent' as const,
        sourceId: randomUUID(),
        transitionSeq: 1,
      };
      await withDbAccessContext(SYSTEM_CTX, () => db.insert(aiOperatorTaskOutbox).values(row));
      // A duplicate delivery of the same transition must converge, not double.
      await expectSqlState(
        () =>
          withDbAccessContext(SYSTEM_CTX, () =>
            db.insert(aiOperatorTaskOutbox).values({ ...row, dueAt: new Date() }),
          ),
        '23505',
      );
      // Positive control: a DIFFERENT transition of the same source is allowed.
      const second = await withDbAccessContext(SYSTEM_CTX, () =>
        db.insert(aiOperatorTaskOutbox).values({ ...row, transitionSeq: 2 }).returning(),
      );
      expect(second).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Org merge fencing
  // -------------------------------------------------------------------------

  describe('org merge', () => {
    it('fences live loser-org tasks and leaves terminal ones alone', async () => {
      const liveStates = ['queued', 'running', 'waiting', 'paused'] as const;
      const liveIds: string[] = [];
      for (const state of liveStates) {
        liveIds.push(
          await insertTask(t, {
            state,
            leaseOwner: 'coordinator-1',
            leaseExpiresAt: new Date(Date.now() + 60_000),
            nextWakeAt: new Date(Date.now() + 60_000),
          }),
        );
      }
      const terminalId = await insertTask(t, { state: 'failed', outcome: 'unresolved', outcomeDetail: 'gave up' });
      // A live task in the SURVIVOR org must not be touched.
      const survivorId = await insertTask(attacker, { state: 'running' });

      const preview = await withDbAccessContext(SYSTEM_CTX, () =>
        db.execute(CUSTOM_WOULD_REVOKE_COUNTS.ai_operator_tasks!(t.orgId)),
      );
      expect(Number((preview as unknown as Array<{ n: number }>)[0]!.n)).toBe(liveStates.length);

      const outcome = await withSystemDbAccessContext(() =>
        CUSTOM_RESOLVE_EXECUTORS.ai_operator_tasks!(t.orgId, attacker.orgId),
      );
      // The fence moves and drops nothing — Operator history is
      // leave-for-erasure, and that is the point of the disposition.
      expect(outcome).toMatchObject({ moved: 0, dropped: 0 });
      expect(outcome.notes).toHaveLength(1);
      expect(outcome.notes[0]).toContain(`fenced ${liveStates.length}`);

      const rows = (await withDbAccessContext(SYSTEM_CTX, () =>
        db.execute(sql`
          SELECT id, state, org_id, lease_owner, next_wake_at, outcome_detail
            FROM ai_operator_tasks`),
      )) as unknown as Array<Record<string, unknown>>;
      const byId = new Map(rows.map((r) => [r.id as string, r]));

      for (const id of liveIds) {
        const row = byId.get(id)!;
        expect(row.state).toBe('stopping');
        expect(row.lease_owner).toBeNull();
        expect(row.next_wake_at).toBeNull();
        // The reason lands in an EXPORTABLE text column, not only in a jsonb
        // container the export policy excludes.
        expect(String(row.outcome_detail)).toContain('organization merge');
        // Never repointed: the row is erased with the loser shell.
        expect(row.org_id).toBe(t.orgId);
      }

      const terminal = byId.get(terminalId)!;
      expect(terminal.state).toBe('failed');
      expect(terminal.outcome_detail).toBe('gave up');

      expect(byId.get(survivorId)!.state).toBe('running');
    });

    it('labels a device-targeted task \'org_merged\', not \'device_moved\'', async () => {
      // The trap: `devices` is a plain `repoint` table, so the merge's MOVE
      // phase runs `UPDATE devices SET org_id = <survivor>`, firing
      // breeze_cascade_device_org_id(), whose statement stamps
      // COALESCE(target_detached_reason, 'device_moved'). If the resolve-phase
      // fence does not stamp the reason first, every merge-caused detachment
      // is mislabelled 'device_moved' and 'org_merged' — a value both the CHECK
      // constraint and the TS union define — is written by nothing, ever.
      const deviceId = await insertDevice(t.orgId, t.siteId);
      const liveId = await insertTask(t, { deviceId, targetLabel: 'PRINTSRV01', state: 'running' });
      const doneId = await insertTask(t, { deviceId, targetLabel: 'PRINTSRV01', state: 'completed' });

      await withSystemDbAccessContext(() =>
        CUSTOM_RESOLVE_EXECUTORS.ai_operator_tasks!(t.orgId, attacker.orgId),
      );

      // Now simulate the move phase's devices repoint, which fires the trigger.
      const adminDb = getTestDb() as never as typeof db;
      await adminDb.execute(
        sql`UPDATE devices SET org_id = ${attacker.orgId}::uuid, site_id = ${attacker.siteId}::uuid WHERE id = ${deviceId}::uuid`,
      );

      const rows = (await withDbAccessContext(SYSTEM_CTX, () =>
        db.execute(sql`
          SELECT id, device_id, target_label, target_detached_reason, state, org_id
            FROM ai_operator_tasks WHERE id IN (${liveId}::uuid, ${doneId}::uuid)`),
      )) as unknown as Array<Record<string, unknown>>;
      const byId = new Map(rows.map((r) => [r.id as string, r]));

      for (const id of [liveId, doneId]) {
        const row = byId.get(id)!;
        expect(row.target_detached_reason).toBe('org_merged');
        expect(row.device_id).toBeNull();
        expect(row.target_label).toBe('PRINTSRV01');
        expect(row.org_id).toBe(t.orgId);
      }
      // The live one is still fenced; the terminal one is detached but not
      // resurrected.
      expect(byId.get(liveId)!.state).toBe('stopping');
      expect(byId.get(doneId)!.state).toBe('completed');
    });

    it('is idempotent — a second fence pass reports nothing to fence', async () => {
      await insertTask(t, { state: 'running' });
      await withSystemDbAccessContext(() => CUSTOM_RESOLVE_EXECUTORS.ai_operator_tasks!(t.orgId, attacker.orgId));
      const second = await withSystemDbAccessContext(() =>
        CUSTOM_RESOLVE_EXECUTORS.ai_operator_tasks!(t.orgId, attacker.orgId),
      );
      expect(second.notes).toEqual([]);
    });
  });
});
