import { describe, expect, it, vi } from 'vitest';

import { deleteDeviceCascade, type DeviceDeletionTx } from './deviceDeletion';

const sentry = { captureMessage: vi.fn() };
// The service reports through the `services/sentry` WRAPPER (init guard +
// scrubEvent), not raw `@sentry/node`, so that is what has to be mocked —
// mocking the raw SDK here would silently intercept nothing.
vi.mock('./sentry', () => ({
  captureMessage: (...a: unknown[]) => sentry.captureMessage(...a),
}));

/**
 * Captures the SQL this cascade issues, in order, so the lock-ordering
 * regression is testable without a database. Follows the `ops` pattern from
 * the #3739 fix (BREEZE-1S).
 *
 * What this CANNOT prove, and deliberately does not claim: that Postgres
 * actually acquired a row lock, that RLS did not filter the row, or that two
 * concurrent transactions serialize. Those need two real connections and belong
 * in an integration test. What it does prove is the ordering contract — that
 * the lock statement is issued before any child table is touched — which is the
 * part a refactor can silently break.
 */
/**
 * A result shaped the way THIS driver actually returns one.
 *
 * The api runs on drizzle-orm/postgres-js (`db/index.ts`), whose `execute()`
 * resolves to an array-like carrying `.count`. It has no `.rowCount` and no
 * `.rows`. An earlier revision of this mock returned `{ rowCount, rows: [] }` —
 * the node-postgres shape — so the code, the mock and the assertions all agreed
 * with each other and were all wrong about the driver, hiding a read that
 * returned 0 on every call. Keep this faithful: if the mock lies, the test
 * cannot see the bug it exists to catch.
 */
function pgResult(rowCount: number): unknown {
  const rows: Record<string, unknown>[] = Array.from({ length: rowCount }, () => ({
    id: 'device-1',
  }));
  Object.defineProperty(rows, 'count', { value: rowCount, enumerable: false });
  return rows;
}

function captureTx(lockedRowCount = 1) {
  const statements: string[] = [];
  const tx: DeviceDeletionTx = {
    execute: vi.fn().mockImplementation((query: unknown) => {
      const text = JSON.stringify(query);
      statements.push(text);
      if (text.includes('FOR UPDATE')) {
        return Promise.resolve(pgResult(lockedRowCount));
      }
      // The tighten statement reads pg_settings (milliseconds, as an integer)
      // and applies the bound in the SAME statement — postgres-js returns a row
      // array carrying a non-enumerable `.count`.
      if (text.includes('pg_settings')) {
        const row: Record<string, unknown>[] = [{ prior_ms: '7000' }];
        Object.defineProperty(row, 'count', { value: 1, enumerable: false });
        return Promise.resolve(row);
      }
      return Promise.resolve(undefined);
    }),
    delete: vi.fn().mockImplementation(() => {
      statements.push('__DELETE_DEVICES_ROW__');
      return { where: vi.fn().mockResolvedValue(undefined) };
    }),
  };
  return { tx, statements };
}

describe('deleteDeviceCascade lock ordering', () => {
  it('locks the devices row BEFORE touching any child table (40P01, cf. #3739)', async () => {
    // FK constraints force children-before-parent for the DELETEs, so the
    // order cannot be inverted to match the rest of the codebase. Every other
    // writer spanning both levels takes the devices row first, so without an
    // explicit parent lock a permanent delete racing a re-enrollment of the
    // same device is a textbook AB-BA deadlock.
    const { tx, statements } = captureTx();

    await deleteDeviceCascade(tx, 'device-1');

    // Guard against a vacuous order check: the cascade must actually have run
    // past the lock, otherwise "first statement" is trivially satisfied.
    expect(statements.length).toBeGreaterThan(5);
    expect(statements).toContain('__DELETE_DEVICES_ROW__');

    // NOTE ON WHAT THIS CAN AND CANNOT SEE: these assertions prove the ORDER in
    // which statements are emitted, nothing more. The mock has no connection,
    // transaction, savepoint or GUC semantics, so it would still pass if the
    // timeout were '3000s', if is_local were false, or if each statement ran on
    // a different pooled connection. Proving the bound actually fires needs two
    // real connections and belongs in an integration test.
    //
    // Emission order: ONE tighten-and-read statement, take the lock, put it
    // back — all before any child table is touched. This used to be four
    // statements; reading pg_settings and applying the bound now ride together,
    // which is what removes the client-side unit parsing.
    expect(statements[0]).toContain('pg_settings');
    expect(statements[0]).toContain('set_config');
    expect(statements[1]).toContain('FOR UPDATE');
    expect(statements[1]).toContain('devices');
    expect(statements[2]).toContain('set_config');
    expect(statements[2]).toContain('lock_timeout');

    // And nothing touches a child table ahead of it.
    const lockIndex = statements.findIndex((t) => t.includes('FOR UPDATE'));
    expect(lockIndex).toBe(1);
  });

  it('restores the caller lock_timeout immediately after taking the lock', async () => {
    // set_config(..., true) is TRANSACTION-local, not statement-local, and both
    // callers run inside an outer transaction (withDbAccessContext) where a
    // nested db.transaction() is only a SAVEPOINT — releasing which does NOT
    // undo a SET LOCAL. Left in force, this function's 3s bound would govern
    // every child DELETE, the route's link-group dissolution, and every later
    // device in the reaper's pass. It must be handed back at once.
    const { tx, statements } = captureTx();

    await deleteDeviceCascade(tx, 'device-1');

    const restoreIndex = statements.findIndex(
      (t, i) => i > 1 && t.includes('set_config') && t.includes('lock_timeout')
    );
    expect(restoreIndex).toBe(2);
    // Restored to the caller's value, not blindly reset to a hardcoded default.
    expect(statements[restoreIndex]).toContain('7000ms');

    // Nothing that can block may sit between the lock and the restore.
    const firstChildWrite = statements.findIndex(
      (s) => s.includes('DELETE FROM') || s === '__DELETE_DEVICES_ROW__'
    );
    expect(firstChildWrite).toBeGreaterThan(restoreIndex);
  });

  it('stays bounded, reports, and skips the restore when the prior lock_timeout cannot be read', async () => {
    // This used to assert a throw, then briefly asserted an UNBOUNDED wait —
    // both wrong. Aborting kills a delete whose SELF_UNINSTALL already went out;
    // proceeding unbounded pins a pooled connection, which is the outage class
    // the bound exists to prevent. Applying the bound inside the SQL statement
    // makes the question moot: the timeout is ALREADY tightened by the time the
    // client tries to decode the prior value, so an unreadable result costs
    // only the restore — and skipping that leaves the STRICTER value in force.
    const statements: string[] = [];
    const tx: DeviceDeletionTx = {
      execute: vi.fn().mockImplementation((query: unknown) => {
        const text = JSON.stringify(query);
        statements.push(text);
        // node-postgres shape: what a driver swap would hand back. The point of
        // this fixture is that `[0].prior_ms` is NOT reachable on it, so the
        // service cannot learn what to restore.
        if (text.includes('pg_settings')) {
          return Promise.resolve({ rows: [{ prior_ms: '7000' }], rowCount: 1 });
        }
        // Stay in that same node-postgres shape for every other statement,
        // rather than handing back undefined — a driver returns results, and
        // the point here is a shape swap, not a missing response.
        return Promise.resolve({ rows: [{ id: 'device-1' }], rowCount: 1 });
      }),
      delete: vi.fn().mockImplementation(() => {
        statements.push('__DELETE_DEVICES_ROW__');
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    };

    sentry.captureMessage.mockClear();
    await expect(deleteDeviceCascade(tx, 'device-1')).resolves.toBeUndefined();

    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(String(sentry.captureMessage.mock.calls[0]?.[0])).toContain('lock_timeout');
    // The bound WAS applied (it rides on the same statement), so exactly one
    // set_config was issued and none afterwards to undo it.
    expect(statements.filter((t) => t.includes('set_config')).length).toBe(1);
    expect(statements[0]).toContain('pg_settings');
    expect(statements.some((t) => t.includes('FOR UPDATE'))).toBe(true);
    expect(statements).toContain('__DELETE_DEVICES_ROW__');
  });

  it('does not widen a caller that already set a stricter lock_timeout', async () => {
    // The doc comment promises this function will not relax a tighter bound.
    // An unconditional set_config broke that promise: a caller holding 500ms
    // was silently relaxed to 3000ms for the REST of the outer transaction,
    // because SET LOCAL is transaction-scoped, not statement-scoped.
    const statements: string[] = [];
    const tx: DeviceDeletionTx = {
      execute: vi.fn().mockImplementation((query: unknown) => {
        const text = JSON.stringify(query);
        statements.push(text);
        if (text.includes('pg_settings')) {
          const row: Record<string, unknown>[] = [{ prior_ms: '500' }];
          Object.defineProperty(row, 'count', { value: 1, enumerable: false });
          return Promise.resolve(row);
        }
        const empty: Record<string, unknown>[] = [{ id: 'device-1' }];
        Object.defineProperty(empty, 'count', { value: 1, enumerable: false });
        return Promise.resolve(empty);
      }),
      delete: vi.fn().mockImplementation(() => {
        statements.push('__DELETE_DEVICES_ROW__');
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    };

    await deleteDeviceCascade(tx, 'device-1');

    // The SQL CASE keeps the caller's 500ms, and because nothing changed there
    // is no restore statement afterwards — one set_config total, not two.
    expect(statements.filter((t) => t.includes('set_config')).length).toBe(1);
    // Still took the lock and still completed under the caller's own bound.
    expect(statements.some((t) => t.includes('FOR UPDATE'))).toBe(true);
    expect(statements).toContain('__DELETE_DEVICES_ROW__');
  });

  it('applies the bound when the caller\'s is looser, and restores exactly what was there', async () => {
    const { tx, statements } = captureTx();
    await deleteDeviceCascade(tx, 'device-1');
    // captureTx reports 7000ms > 3000ms, so the bound genuinely tightens and
    // must be applied — then restored to the caller's ORIGINAL value, not to a
    // hard-coded default.
    const sets = statements.filter((t) => t.includes('set_config'));
    expect(sets.length).toBe(2);
    expect(sets[0]).toContain('3000');
    expect(sets[1]).toContain('7000ms');
  });

  it('deletes the devices row last, after the child tables', async () => {
    // The other half of the contract: the parent lock moves to the front, the
    // parent DELETE stays at the back. A change that "fixed" ordering by
    // moving the delete would violate the FKs.
    const { tx, statements } = captureTx();

    await deleteDeviceCascade(tx, 'device-1');

    expect(statements[statements.length - 1]).toBe('__DELETE_DEVICES_ROW__');
  });
});


describe('deleteDeviceCascade when the parent lock is not acquired', () => {
  it('reports rather than aborting when FOR UPDATE matches no row', async () => {
    // Zero rows means the device is already gone (a re-run, or two reapers
    // racing) or RLS filtered it. Deleting an absent device is legitimately
    // idempotent, so aborting would turn a harmless race into an error — but
    // the cascade below then runs under the OLD child-first ordering, which is
    // exactly the race the lock exists to close. It must be visible, not
    // silently assumed safe.
    sentry.captureMessage.mockClear();
    const { tx, statements } = captureTx(0);

    await expect(deleteDeviceCascade(tx, 'device-gone')).resolves.toBeUndefined();

    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(String(sentry.captureMessage.mock.calls[0]?.[0])).toContain('without holding');
    // Still idempotent: the cascade completed rather than throwing.
    expect(statements).toContain('__DELETE_DEVICES_ROW__');
  });

  it('stays quiet on the normal path where the row is locked', async () => {
    sentry.captureMessage.mockClear();
    const { tx } = captureTx(1);

    await deleteDeviceCascade(tx, 'device-1');

    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });
});
