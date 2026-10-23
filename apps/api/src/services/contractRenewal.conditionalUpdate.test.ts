/**
 * #9243: the renewal sweep reads its candidates unlocked, then extends each
 * term. A pause, cancel, auto-renew opt-out or end-date edit that commits in
 * between must win, so the extension is a CONDITIONAL update on everything the
 * decision read. Zero matched rows means no event, no notice and no count.
 *
 * Asserted as compiled SQL plus the 0-row path. The DB is a mocked chain that
 * answers each awaited statement from a queue.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Mock } from 'vitest';
import { SQL } from 'drizzle-orm';

const { results } = vi.hoisted(() => ({ results: [] as unknown[][] }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit', 'innerJoin', 'insert', 'values', 'onConflictDoNothing', 'returning', 'update', 'set']) {
    chain[m] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(results.shift() ?? []).then(resolve);
  return { db: chain };
});

vi.mock('./contractEvents', () => ({ emitContractEvent: vi.fn() }));
vi.mock('./notificationSenders/inAppSender', () => ({ sendInAppNotification: vi.fn() }));
vi.mock('./email', () => ({ getEmailService: () => null }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { db } from '../db';
import { emitContractEvent } from './contractEvents';
import { runContractRenewalSweep } from './contractRenewal';

const dialect = new PgDialect();
const candidate = {
  id: 'c1', orgId: 'o1', partnerId: 'p1', name: 'Renew', billingTiming: 'advance', intervalMonths: 1,
  endDate: '2027-01-01', nextBillingAt: '2027-01-01', autoRenew: true, renewalTermMonths: 12, renewalNoticeDays: 30,
};
const asOf = new Date('2027-01-01T05:00:00Z');

describe('renewal sweep conditional extension (#9243)', () => {
  beforeEach(() => { vi.clearAllMocks(); results.length = 0; });

  it('guards the update on status, auto_renew, the end date it read and the term', async () => {
    results.push([candidate], [{ id: 'c1' }], [{ id: 'n1' }]); // candidates, update…returning, claimNotice
    const out = await runContractRenewalSweep(asOf);
    expect(out.renewed).toBe(1);

    const where = (db as unknown as { where: Mock }).where.mock.calls[1]![0] as SQL;
    const { sql, params } = dialect.sqlToQuery(where);
    expect(sql).toContain('"contracts"."id" =');
    expect(sql).toContain('"contracts"."status" =');
    expect(sql).toContain('"contracts"."auto_renew" =');
    expect(sql).toContain('"contracts"."end_date" =');
    expect(sql).toContain('"contracts"."renewal_term_months" =');
    expect(params).toEqual(expect.arrayContaining(['c1', 'active', true, '2027-01-01', 12]));
    expect((db as unknown as { set: Mock }).set).toHaveBeenCalledWith(expect.objectContaining({ endDate: '2028-01-01' }));
    expect(emitContractEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'contract.auto_renewed', contractId: 'c1' }));
  });

  it('a contract that changed since the read (0 rows matched) is not counted, evented or noticed', async () => {
    results.push([candidate], []); // candidates, update…returning matched nothing
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const out = await runContractRenewalSweep(asOf);
      expect(out.renewed).toBe(0);
      expect(emitContractEvent).not.toHaveBeenCalled();
      expect((db as unknown as { insert: Mock }).insert).not.toHaveBeenCalled(); // no renewed-notice claim
      expect(info).toHaveBeenCalledWith(expect.stringContaining('renewal skipped'), 'contractId=c1');
    } finally {
      info.mockRestore();
    }
  });

  it('does not renew the day before end_date', async () => {
    results.push([candidate]);
    const out = await runContractRenewalSweep(new Date('2026-12-31T05:00:00Z'));
    expect(out.renewed).toBe(0);
    expect((db as unknown as { update: Mock }).update).not.toHaveBeenCalled();
  });
});
