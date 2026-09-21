/**
 * Wave E2 DML backfill contract
 * (`apps/api/migrations/2026-10-26-160100-ai-operator-inline-target-backfill.sql`).
 *
 * Proves the backfill correctly migrates pre-E2 "inline" task state
 * (`device_id` / `target_label` / `target_detached_at` / `target_detached_reason` /
 * `current_step_key` on `ai_operator_tasks`) into rows in the new
 * `ai_operator_task_targets` / `ai_operator_task_steps` / `ai_operator_task_events`
 * tables, that a second replay is a true no-op, and that the inline columns
 * are left untouched — they are a READ PROJECTION per the migration's header,
 * not dropped or mutated by this backfill.
 *
 * THE BACKFILL IS ORG-WIDE / DATABASE-WIDE: it has no `WHERE org_id = ...`
 * clause and will touch every pre-existing `ai_operator_tasks` row in the test
 * database, not just the ones this suite seeds. Every assertion below is
 * therefore scoped by this suite's own seeded task ids, never by counting all
 * rows in a table.
 *
 * Fixture tasks are inserted DIRECTLY into `ai_operator_tasks` under system
 * scope, bypassing the app-layer admission function entirely (which, as of
 * this wave, already writes target/step/event rows) — this reproduces the
 * pre-E2 "inline only" shape the backfill exists to migrate.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { describe, it, expect, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { aiAgents, aiOperatorTasks, devices } from '../../db/schema';
import {
  aiOperatorTaskTargets,
  aiOperatorTaskSteps,
  aiOperatorTaskEvents,
} from '../../db/schema/aiOperatorTaskGraph';
import { appendTaskEvent } from '../../services/aiOperator/eventService';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const RUN = !!process.env.DATABASE_URL;
const runDb = it.runIf(RUN);

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
};

const sys = <T,>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

const MIGRATION = '2026-10-26-160100-ai-operator-inline-target-backfill.sql';
const migrationSql = readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8');

// A dedicated superuser client (the role autoMigrate runs as) with onnotice
// wired, so the migration's RAISE WARNING row counts can be inspected if
// needed for debugging. Mirrors documentLocaleBackfill.integration.test.ts.
const notices: string[] = [];
const adminSql = postgres(process.env.DATABASE_URL ?? '', {
  max: 1,
  onnotice: (n) => { notices.push(String(n.message)); },
});
afterAll(async () => { await adminSql.end({ timeout: 5 }); });

async function runBackfill(): Promise<void> {
  notices.length = 0;
  await adminSql.unsafe(migrationSql);
}

interface Fixture {
  orgId: string;
  agentId: string;
  siteId: string;
  deviceId: string;
}

async function seedFixture(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id });

  const [agent] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(aiAgents).values({
      orgId: org.id, partnerId: null, kind: 'triage', name: 'Operator', enabled: true, createdBy: user.id,
    }).returning(),
  );

  // Devices are inserted with the ADMIN connection, same pattern as
  // aiOperatorAdmission.integration.test.ts's insertDevice — seeding a device
  // is not the thing under test.
  const adminDb = getTestDb() as unknown as typeof db;
  const unique = randomUUID().slice(0, 8);
  const [device] = await adminDb.insert(devices).values({
    orgId: org.id,
    siteId: site.id,
    agentId: `inline-backfill-agent-${unique}`,
    hostname: `WS-${unique}`,
    osType: 'windows',
    osVersion: '10',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'online',
  }).returning();

  return { orgId: org.id, agentId: agent!.id, siteId: site.id, deviceId: (device as { id: string }).id };
}

/**
 * Insert a task DIRECTLY into `ai_operator_tasks` under system scope, with NO
 * corresponding rows in the graph tables — the pre-E2 shape. Deliberately
 * bypasses `admitServiceRecoveryTask` and every other app-layer writer, which
 * already write target/step/event rows as of this wave.
 */
async function insertInlineTask(
  f: Fixture,
  overrides: Partial<typeof aiOperatorTasks.$inferInsert>,
): Promise<string> {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(aiOperatorTasks).values({
      orgId: f.orgId,
      agentId: f.agentId,
      agentKind: 'triage',
      agentName: 'Operator',
      workflowKey: 'service_recovery',
      workflowVersion: 1,
      mode: 'live',
      originKind: 'manual',
      objective: 'Restart the print spooler',
      revision: 1,
      leaseEpoch: 0,
      attemptOrdinal: 0,
      checkpoint: {},
      ...overrides,
    }).returning({ id: aiOperatorTasks.id }),
  );
  return row!.id;
}

async function taskRow(id: string) {
  const [row] = await sys(() => db.select().from(aiOperatorTasks).where(eq(aiOperatorTasks.id, id)));
  return row!;
}

async function targetsFor(taskIds: string[]) {
  return sys(() =>
    db.select().from(aiOperatorTaskTargets).where(inArray(aiOperatorTaskTargets.taskId, taskIds)),
  );
}
async function stepsFor(taskIds: string[]) {
  return sys(() =>
    db.select().from(aiOperatorTaskSteps).where(inArray(aiOperatorTaskSteps.taskId, taskIds)),
  );
}
async function eventsFor(taskIds: string[]) {
  return sys(() =>
    db.select().from(aiOperatorTaskEvents).where(inArray(aiOperatorTaskEvents.taskId, taskIds)),
  );
}

describe.runIf(RUN)('AI Operator inline target/step backfill (2026-10-26-160100)', () => {
  runDb('migrates a live device-targeted task and a detached task into target/step/event rows, is idempotent, continues the event counter, and leaves inline columns untouched', async () => {
    const f = await seedFixture();

    // Task A: "live" — has a device target and a current step.
    const taskAId = await insertInlineTask(f, {
      deviceId: f.deviceId,
      targetLabel: 'WS-001',
      currentStepKey: 'execute',
      attemptOrdinal: 0,
      state: 'running',
    });

    // Task B: "detached/gone" — device_id NULL, target_detached_at set,
    // no current step (section 2 of the backfill skips it).
    const detachedAt = new Date(Date.now() - 60 * 60 * 1000);
    const taskBId = await insertInlineTask(f, {
      deviceId: null,
      targetLabel: 'WS-GONE',
      targetDetachedAt: detachedAt,
      targetDetachedReason: 'device_deleted',
      currentStepKey: null,
      state: 'completed',
    });

    const taskIds = [taskAId, taskBId];

    // ---- Precondition: no graph rows exist yet for these two tasks. ----
    expect(await targetsFor(taskIds)).toHaveLength(0);
    expect(await stepsFor(taskIds)).toHaveLength(0);
    expect(await eventsFor(taskIds)).toHaveLength(0);

    // ---- Replay the backfill. ----
    await runBackfill();

    // 1. Task A's target row.
    const targetsAfterFirst = await targetsFor(taskIds);
    const targetA = targetsAfterFirst.find((row) => row.taskId === taskAId);
    expect(targetA).toBeDefined();
    expect(targetA).toMatchObject({
      targetOrdinal: 0,
      targetKind: 'device',
      deviceId: f.deviceId,
      targetLabel: 'WS-001',
      state: 'active',
    });

    // 2. Task A's step row: execute -> effect (service_recovery mapping).
    const stepsAfterFirst = await stepsFor(taskIds);
    const stepA = stepsAfterFirst.find((row) => row.taskId === taskAId);
    expect(stepA).toBeDefined();
    expect(stepA).toMatchObject({
      stepKey: 'execute',
      stepKind: 'effect',
    });

    // 3. Task B's target row.
    const targetB = targetsAfterFirst.find((row) => row.taskId === taskBId);
    expect(targetB).toBeDefined();
    expect(targetB).toMatchObject({
      deviceId: null,
      state: 'detached',
      detachedReason: 'device_deleted',
      targetLabel: 'WS-GONE',
    });
    // Task B has no current_step_key, so section 2 must not create a step row.
    expect(stepsAfterFirst.find((row) => row.taskId === taskBId)).toBeUndefined();

    // 4. A task_admitted event exists for BOTH tasks with transition_seq 1,
    //    actor_kind 'system', actor_user_id NULL.
    const eventsAfterFirst = await eventsFor(taskIds);
    for (const id of taskIds) {
      const evt = eventsAfterFirst.find((row) => row.taskId === id);
      expect(evt, `expected a task_admitted event for task ${id}`).toBeDefined();
      expect(evt).toMatchObject({
        eventType: 'task_admitted',
        transitionSeq: 1,
        actorKind: 'system',
        actorUserId: null,
      });
    }

    // 5. event_seq on both tasks equals 1.
    const taskAAfterFirst = await taskRow(taskAId);
    const taskBAfterFirst = await taskRow(taskBId);
    expect(taskAAfterFirst.eventSeq).toBe(1);
    expect(taskBAfterFirst.eventSeq).toBe(1);

    // 6. Re-run the backfill a second time: counts scoped to these two tasks
    //    must be unchanged (idempotent, true no-op).
    await runBackfill();

    const targetsAfterSecond = await targetsFor(taskIds);
    const stepsAfterSecond = await stepsFor(taskIds);
    const eventsAfterSecond = await eventsFor(taskIds);
    expect(targetsAfterSecond).toHaveLength(targetsAfterFirst.length);
    expect(stepsAfterSecond).toHaveLength(stepsAfterFirst.length);
    expect(eventsAfterSecond).toHaveLength(eventsAfterFirst.length);

    // 7. appendTaskEvent continues the counter correctly past the backfilled
    //    seq-1 row — returns 2, not null, not a 23505 rejection.
    const nextSeq = await withSystemDbAccessContext(() =>
      appendTaskEvent(db, {
        orgId: f.orgId,
        taskId: taskAId,
        eventType: 'lease_claimed',
        actor: { kind: 'system' },
      }),
    );
    expect(nextSeq).toBe(2);

    // 8. Inline columns are untouched by the backfill (read-projection
    //    contract) — re-read and compare to the original seeded values.
    const taskAFinal = await taskRow(taskAId);
    expect(taskAFinal.deviceId).toBe(f.deviceId);
    expect(taskAFinal.targetLabel).toBe('WS-001');
    expect(taskAFinal.currentStepKey).toBe('execute');

    const taskBFinal = await taskRow(taskBId);
    expect(taskBFinal.deviceId).toBeNull();
    expect(taskBFinal.targetLabel).toBe('WS-GONE');
    expect(taskBFinal.currentStepKey).toBeNull();
    expect(taskBFinal.targetDetachedReason).toBe('device_deleted');
    expect(taskBFinal.targetDetachedAt?.getTime()).toBe(detachedAt.getTime());
  });
});
