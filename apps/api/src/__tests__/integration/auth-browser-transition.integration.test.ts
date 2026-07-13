import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import './setup';
import { getTestDb } from './setup';
import { authBrowserTransitions } from '../../db/schema';
import {
  AuthBindingRotationRequiredError,
  beginAuthIssuance,
  finishAuthIssuance,
  resolveAuthBinding,
  rotateExpiredBinding,
  type AuthBindingSource,
} from '../../services/authBrowserTransition';

const CURRENT_KEY = 'integration-browser-binding-current-key-material';

function freshBrowserBinding(): AuthBindingSource {
  try {
    resolveAuthBinding(undefined);
  } catch (error) {
    if (error instanceof AuthBindingRotationRequiredError) return error.replacement;
    throw error;
  }
  throw new Error('Missing binding did not produce a replacement');
}

async function waitForBlockedTransitionQueries(minimum = 1): Promise<void> {
  const db = getTestDb();
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await db.execute(sql`
      SELECT count(*)::int AS blocked_count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'breeze_app'
        AND wait_event_type = 'Lock'
        AND position('auth_browser_transitions' in lower(query)) > 0
    `) as unknown as Array<{ blocked_count: number }>;
    if (Number(rows[0]?.blocked_count ?? 0) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${minimum} blocked auth-browser transition queries`);
}

beforeEach(() => {
  delete process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY_ID = 'current';
  process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({ current: CURRENT_KEY });
});

describe('auth browser transition leases against PostgreSQL', () => {
  it('finalizes a lease whose database timestamp contains sub-millisecond precision', async () => {
    const db = getTestDb();
    const binding = freshBrowserBinding();
    const capability = await beginAuthIssuance(binding);

    const precision = await db.execute(sql`
      UPDATE auth_browser_transitions
      SET active_operation_expires_at =
        date_trunc('milliseconds', active_operation_expires_at) + interval '321 microseconds'
      WHERE id = ${capability.transitionId}::uuid
      RETURNING extract(microseconds FROM active_operation_expires_at)::bigint AS micros
    `) as unknown as Array<{ micros: string }>;
    expect(BigInt(precision[0]!.micros) % 1000n).toBe(321n);

    await expect(finishAuthIssuance(capability, async () => 'committed')).resolves.toBe(
      'committed',
    );

    const [row] = await db
      .select()
      .from(authBrowserTransitions)
      .where(eq(authBrowserTransitions.id, capability.transitionId));
    expect(row).toMatchObject({
      activeOperationId: null,
      activeOperationExpiresAt: null,
    });
  });

  it('serializes expired lease replacement behind the transition row lock', async () => {
    const db = getTestDb();
    const binding = freshBrowserBinding();
    const stale = await beginAuthIssuance(binding);
    await db.execute(sql`
      UPDATE auth_browser_transitions
      SET active_operation_expires_at = now() - interval '1 second'
      WHERE id = ${stale.transitionId}::uuid
    `);

    let settled = false;
    let replacementPromise!: Promise<Awaited<ReturnType<typeof beginAuthIssuance>>>;
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT id
        FROM auth_browser_transitions
        WHERE id = ${stale.transitionId}::uuid
        FOR UPDATE
      `);
      replacementPromise = beginAuthIssuance(binding);
      void replacementPromise.then(
        () => { settled = true; },
        () => { settled = true; },
      );
      await waitForBlockedTransitionQueries();
      expect(settled).toBe(false);
    });

    const replacement = await replacementPromise;
    expect(replacement.operationId).not.toBe(stale.operationId);
    const [row] = await db
      .select()
      .from(authBrowserTransitions)
      .where(eq(authBrowserTransitions.id, stale.transitionId));
    expect(row?.activeOperationId).toBe(replacement.operationId);
  });

  it('forces concurrent retired-C1 rotations to return the same cookie and one active C2 row', async () => {
    const db = getTestDb();
    const c1 = freshBrowserBinding();
    const admission = await beginAuthIssuance(c1);
    await db.execute(sql`
      UPDATE auth_browser_transitions
      SET state = 'retired',
          active_operation_id = NULL,
          active_operation_expires_at = NULL,
          retired_at = now(),
          updated_at = now()
      WHERE id = ${admission.transitionId}::uuid
    `);

    let rotations!: Array<Promise<AuthBindingSource>>;
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT id
        FROM auth_browser_transitions
        WHERE id = ${admission.transitionId}::uuid
        FOR UPDATE
      `);
      rotations = [rotateExpiredBinding(c1), rotateExpiredBinding(c1)];
      await waitForBlockedTransitionQueries(2);
    });

    const [left, right] = await Promise.all(rotations);
    if (!left || !right) throw new Error('Concurrent rotations did not both complete');
    expect(left).toEqual(right);
    expect(left.value).not.toBe(c1.value);

    const rows = await db.select().from(authBrowserTransitions);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.state === 'retired')).toHaveLength(1);
    const activeRows = rows.filter((row) => row.state === 'active');
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0]?.bindingDigest).toBe(resolveAuthBinding(left).bindingDigest);
  });
});
