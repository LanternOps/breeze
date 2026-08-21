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
function captureTx(lockedRowCount = 1) {
  const statements: string[] = [];
  const tx: DeviceDeletionTx = {
    execute: vi.fn().mockImplementation((query: unknown) => {
      const text = JSON.stringify(query);
      statements.push(text);
      // Only the FOR UPDATE probe reads a result; everything else is a write.
      if (text.includes('FOR UPDATE')) {
        return Promise.resolve({ rowCount: lockedRowCount, rows: [] });
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

    const firstStatement = statements[0];
    expect(firstStatement).toContain('FOR UPDATE');
    expect(firstStatement).toContain('devices');

    // And nothing touches a child table ahead of it.
    const lockIndex = statements.findIndex((s) => s.includes('FOR UPDATE'));
    expect(lockIndex).toBe(0);
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
