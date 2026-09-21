// Regression coverage for #6322 (second half): `reconcileDrExecution` opened
// with a bare `SELECT ... FOR UPDATE` outside a transaction — a lock that
// auto-committed and excluded nothing. It is gone; the closing write-back is
// now a compare-and-swap guarded on `status NOT IN (terminal)`.
//
// The unit tests can only pin the zero-rows-matched branch, because the drizzle
// mock's return value is chosen by the test rather than derived from the WHERE
// clause: reverting the guard to a bare `eq(id, …)` leaves every unit test
// green. Only real Postgres evaluates the predicate, so this is the suite that
// would actually catch that revert.
import './setup';

import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withSystemDbAccessContext } from '../../db';
import { drExecutions, drPlanGroups, drPlans } from '../../db/schema';
import { reconcileDrExecution } from '../../services/drExecutionService';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('reconcileDrExecution compare-and-swap against real PostgreSQL (#6322)', () => {
  async function seedPendingExecution() {
    const testDb = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [plan] = await testDb.insert(drPlans).values({
      orgId: org.id,
      name: `DR CAS ${crypto.randomUUID()}`,
    }).returning({ id: drPlans.id });
    if (!plan) throw new Error('DR plan fixture insert failed');

    // An empty group reconciles to "completed" with no device commands, so the
    // tick attempts a real non-terminal -> terminal write with no side effects.
    await testDb.insert(drPlanGroups).values({
      planId: plan.id,
      orgId: org.id,
      name: 'Tier 1',
      sequence: 1,
      devices: [],
      restoreConfig: { commandType: 'vm_restore_from_backup', payload: {} },
    });

    const [execution] = await testDb.insert(drExecutions).values({
      planId: plan.id,
      orgId: org.id,
      executionType: 'rehearsal',
      status: 'pending',
      authorizationPrincipalKind: 'api_key',
      authorizationPrincipalId: crypto.randomUUID(),
      authorizationGrantRevision: 'grant',
      authorizationState: 'authorized',
      authorizationCheckedAt: new Date(),
    }).returning({ id: drExecutions.id });
    if (!execution) throw new Error('DR execution fixture insert failed');
    return { orgId: org.id, executionId: execution.id };
  }

  async function readStatus(executionId: string): Promise<string | undefined> {
    const [row] = await getTestDb()
      .select({ status: drExecutions.status })
      .from(drExecutions)
      .where(eq(drExecutions.id, executionId))
      .limit(1);
    return row?.status;
  }

  // An abort landing at ANY point during a tick must stick. Whichever way the
  // two interleave — abort before the tick's read (early return), or after it
  // (the compare-and-swap refuses the write) — 'aborted' is the only correct
  // final state. Without the guard the tick's write-back overwrites it.
  // Repeated so the run covers both interleavings rather than one by luck.
  runDb('never overwrites a concurrent abort, whichever way the tick interleaves', async () => {
    const testDb = getTestDb();

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const { executionId } = await seedPendingExecution();

      const tick = withSystemDbAccessContext(() => reconcileDrExecution(executionId));
      const abort = testDb
        .update(drExecutions)
        .set({ status: 'aborted', completedAt: new Date() })
        .where(eq(drExecutions.id, executionId));

      const [outcome] = await Promise.all([tick, abort]);

      // The only correct final state, in every interleaving.
      expect(await readStatus(executionId)).toBe('aborted');

      // If the tick observed the abort (early return or a refused write-back),
      // it must report the real row and stop rescheduling itself.
      if (outcome.execution?.status === 'aborted') {
        expect(outcome.nextDelayMs).toBeNull();
      }
    }
  });

  runDb('a terminal execution is never moved by a later tick', async () => {
    const testDb = getTestDb();
    const { executionId } = await seedPendingExecution();

    await testDb
      .update(drExecutions)
      .set({ status: 'aborted', completedAt: new Date() })
      .where(eq(drExecutions.id, executionId));

    const outcome = await withSystemDbAccessContext(() => reconcileDrExecution(executionId));

    expect(outcome.execution?.status).toBe('aborted');
    expect(outcome.nextDelayMs).toBeNull();
    expect(await readStatus(executionId)).toBe('aborted');

    const commands = await testDb.execute(sql`
      select id from device_commands where payload ->> 'drExecutionId' = ${executionId}
    `);
    expect(commands).toHaveLength(0);
  });
});
