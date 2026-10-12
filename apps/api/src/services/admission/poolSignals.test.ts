import { afterEach, describe, expect, it, vi } from 'vitest';

const { expiryTotals } = vi.hoisted(() => ({
  expiryTotals: {
    acquire: { late: 0, 'on-time': 0 },
    prologue: { late: 0, 'on-time': 0 },
  },
}));
vi.mock('../../db/prologueDeadline', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/prologueDeadline')>()),
  getDeadlineExpiryTotals: () => ({
    acquire: { ...expiryTotals.acquire },
    prologue: { ...expiryTotals.prologue },
  }),
}));

import {
  __resetRequestPoolAdmissionForTests,
  createPoolAdmission,
  registerRequestPoolAdmission,
} from '../../db/poolAdmission';
import { readPoolSignals } from './poolSignals';

afterEach(() => {
  __resetRequestPoolAdmissionForTests();
  expiryTotals.acquire.late = 0;
  expiryTotals.acquire['on-time'] = 0;
  expiryTotals.prologue.late = 0;
  expiryTotals.prologue['on-time'] = 0;
});

describe('readPoolSignals', () => {
  it('reads as unavailable — never as pressure — when this process has no request-pool gate (Review Focus 3)', () => {
    expect(readPoolSignals()).toEqual({
      available: false, inUse: 0, waiting: 0, effectivePermits: 0, oldestWaitMs: 0, grantWaitP95Ms: 0, dbTimeoutsTotal: 0,
    });
  });

  it('reads in-use, waiting, effective permits and the wait statistics from the gate', async () => {
    let nowMs = 0;
    const gate = createPoolAdmission({ permits: 2, nestedReserve: 0, now: () => nowMs });
    registerRequestPoolAdmission(gate);
    await gate.acquire('a');
    await gate.acquire('b');
    void gate.acquire('waiter-1');
    nowMs += 250;
    expect(readPoolSignals()).toEqual({
      available: true, inUse: 2, waiting: 1, effectivePermits: 2, oldestWaitMs: 250, grantWaitP95Ms: 0, dbTimeoutsTotal: 0,
    });
  });

  it('counts acquire-clock and prologue-clock deadline expiries together as DB timeouts', () => {
    expiryTotals.acquire['on-time'] = 1;
    expiryTotals.prologue['on-time'] = 2;
    const signals = readPoolSignals();
    // Reported even with no gate registered.
    expect(signals.available).toBe(false);
    expect(signals.dbTimeoutsTotal).toBe(3);
  });
});
