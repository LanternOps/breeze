/**
 * W08 — the ONE place admission control reads DB pool state.
 *
 * Source: W04's request-pool gate (db/poolAdmission.ts, built on #8243) and
 * the deadline-expiry totals. W08 publishes no pool gauges of its own — W04
 * owns `breeze_db_pool_admission_*` — and never measures the pool a second way.
 *
 * Without a registered gate (unit tests; a process that never loaded the
 * request pool) the signals read `available: false` and zero. That is
 * "unknown", never "pressure": the controller then decides on lag alone and
 * cannot raise a false DB emergency.
 */
import { getRequestPoolAdmission } from '../../db/poolAdmission';
import { getDeadlineExpiryTotals } from '../../db/prologueDeadline';

export interface PoolSignals {
  available: boolean;
  inUse: number;
  waiting: number;
  effectivePermits: number;
  oldestWaitMs: number;
  grantWaitP95Ms: number;
  /**
   * Monotonic since boot: every deadline expiry, on both the pool-acquire clock
   * and the prologue clock, late or on-time. The gate's own cancelledWaiters is
   * deliberately NOT added: it is the same event as an acquire expiry.
   */
  dbTimeoutsTotal: number;
}

function sumExpiries(): number {
  let sum = 0;
  for (const clock of Object.values(getDeadlineExpiryTotals())) {
    for (const value of Object.values(clock)) sum += value;
  }
  return sum;
}

export function readPoolSignals(): PoolSignals {
  const dbTimeoutsTotal = sumExpiries();
  const gate = getRequestPoolAdmission();
  if (!gate) {
    return {
      available: false, inUse: 0, waiting: 0, effectivePermits: 0, oldestWaitMs: 0, grantWaitP95Ms: 0,
      dbTimeoutsTotal,
    };
  }
  const snapshot = gate.snapshot();
  const stats = gate.waitStats();
  return {
    available: true,
    inUse: snapshot.inUse,
    waiting: snapshot.waiting,
    effectivePermits: snapshot.effectivePermits,
    oldestWaitMs: stats.oldestWaitMs,
    grantWaitP95Ms: stats.grantWaitP95Ms,
    dbTimeoutsTotal,
  };
}
