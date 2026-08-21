import { describe, expect, it, vi } from 'vitest';

import { deleteDeviceCascade, type DeviceDeletionTx } from './deviceDeletion';

const sentry = { captureMessage: vi.fn() };
vi.mock('@sentry/node', () => ({
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
      // current_setting('lock_timeout') — postgres-js returns a row array.
      if (text.includes('current_setting')) {
        const row: Record<string, unknown>[] = [{ lock_timeout: '7s' }];
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
    // Emission order: read the caller's lock_timeout, narrow it, take the lock,
    // put it back — all before any child table is touched.
    expect(statements[0]).toContain('current_setting');
    expect(statements[1]).toContain('set_config');
    expect(statements[1]).toContain('lock_timeout');
    expect(statements[2]).toContain('FOR UPDATE');
    expect(statements[2]).toContain('devices');

    // And nothing touches a child table ahead of it.
    const lockIndex = statements.findIndex((s) => s.includes('FOR UPDATE'));
    expect(lockIndex).toBe(2);
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
      (s, i) => i > 2 && s.includes('set_config') && s.includes('lock_timeout')
    );
    expect(restoreIndex).toBe(3);
    // Restored to the caller's value, not blindly reset to a hardcoded default.
    expect(statements[restoreIndex]).toContain('7s');

    // Nothing that can block may sit between the lock and the restore.
    const firstChildWrite = statements.findIndex(
      (s) => s.includes('DELETE FROM') || s === '__DELETE_DEVICES_ROW__'
    );
    expect(firstChildWrite).toBeGreaterThan(restoreIndex);
  });

  it('aborts instead of guessing when the prior lock_timeout cannot be read', async () => {
    // '0' means "wait forever" in Postgres, so substituting it on an
    // unrecognised result shape would silently WIDEN a caller that had set a
    // stricter timeout — for the rest of the outer transaction. Only a driver
    // shape change can trigger this, which is exactly the silent-breakage class
    // the row-count fix in this commit addresses. Fail loudly, before mutating.
    const statements: string[] = [];
    const tx: DeviceDeletionTx = {
      execute: vi.fn().mockImplementation((query: unknown) => {
        const text = JSON.stringify(query);
        statements.push(text);
        // node-postgres shape: what a driver swap would hand back.
        if (text.includes('current_setting')) {
          return Promise.resolve({ rows: [{ lock_timeout: '7s' }], rowCount: 1 });
        }
        return Promise.resolve(undefined);
      }),
      delete: vi.fn().mockImplementation(() => {
        statements.push('__DELETE_DEVICES_ROW__');
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    };

    await expect(deleteDeviceCascade(tx, 'device-1')).rejects.toThrow(/lock_timeout/);

    // Aborted before changing the setting and before touching any table.
    expect(statements.some((s) => s.includes('set_config'))).toBe(false);
    expect(statements.some((s) => s.includes('FOR UPDATE'))).toBe(false);
    expect(statements).not.toContain('__DELETE_DEVICES_ROW__');
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
