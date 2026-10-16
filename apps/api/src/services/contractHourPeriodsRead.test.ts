vi.mock('./autopay/autopayGate', () => ({ isAutopayEnabledForPartner: vi.fn().mockResolvedValue(false) }));
import { describe, it, expect, vi, beforeEach } from 'vitest';

type QueuedQuery = { rows: unknown[] } | { error: unknown };
const results: QueuedQuery[] = [];
function queueResult(rows: unknown[]) { results.push({ rows }); }
function queueError(error: unknown) { results.push({ error }); }

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin', 'leftJoin', 'execute', 'onConflictDoNothing'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    chain.transaction = vi.fn(async (run: (tx: unknown) => unknown) => run(chain));
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      const result = results.shift() ?? { rows: [] };
      return 'error' in result ? reject(result.error) : resolve(result.rows);
    };
    return chain;
  };
  const db = makeChain();
  return {
    db, assertInTransaction: vi.fn(),
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    getCurrentDbAccessContext: vi.fn(),
  };
});
vi.mock('./contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./invoiceService', () => ({ createManualInvoice: vi.fn(), addContractLine: vi.fn(), deleteDraftInvoice: vi.fn() }));
vi.mock('./contractQuantities', () => ({
  countContractDevices: vi.fn(), countContractSeats: vi.fn(), snapshotContractDevices: vi.fn(), groupMembersForBilling: vi.fn(),
}));

vi.mock('./autopay/autopayGate', () => ({ isAutopayEnabledForPartner: vi.fn().mockResolvedValue(false) }));

import { encodeHourPeriodCursor, decodeHourPeriodCursor, listContractHourPeriods } from './contractHourPeriodsRead';

describe('hour-period cursor', () => {
  it('round-trips and rejects a malformed value', () => {
    const c = encodeHourPeriodCursor('2026-08-01', '11111111-1111-4111-8111-111111111111');
    expect(c).toBe('2026-08-01|11111111-1111-4111-8111-111111111111');
    expect(decodeHourPeriodCursor(c)).toEqual({ periodStart: '2026-08-01', id: '11111111-1111-4111-8111-111111111111' });
    expect(decodeHourPeriodCursor('nope')).toBeNull();
    expect(decodeHourPeriodCursor("2026-08-01|x'; drop")).toBeNull();
  });
});

describe('listContractHourPeriods', () => {
  const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
  const row = (i: number) => ({
    id: `00000000-0000-4000-8000-00000000000${i}`, contractLineId: 'b1', periodStart: `2026-0${i}-01`, periodEnd: `2026-0${i + 1}-01`,
    includedHours: '10.00', carriedInHours: '0.00', consumedHours: '6.50', overageHours: '0.00', carriedOutHours: '0.00',
    foreignCurrencyHours: '0.00', entryCount: 4, overageUnitPrice: '150.00', currencyCode: 'USD',
    overageInvoiceId: null, closeSource: 'billing_run', closedAt: new Date('2026-09-01T00:00:00Z'),
  });
  beforeEach(() => { results.length = 0; });

  it('returns a page and a cursor when more rows exist (limit+1 read), with ISO closedAt', async () => {
    queueResult([{ id: 'c1', orgId: 'org1', partnerId: 'p1' }]);   // getOwnedContractOr404
    queueResult([row(3), row(2), row(1)]);                           // limit 2 -> reads 3
    const out = await listContractHourPeriods('c1', { limit: 2 }, actor);
    expect(out.items.map((r) => r.periodStart)).toEqual(['2026-03-01', '2026-02-01']);
    expect(out.nextCursor).toBe('2026-02-01|00000000-0000-4000-8000-000000000002');
    expect(typeof out.items[0]!.closedAt).toBe('string');
  });

  it('has no cursor on the last page', async () => {
    queueResult([{ id: 'c1', orgId: 'org1', partnerId: 'p1' }]);
    queueResult([row(2), row(1)]);
    const out = await listContractHourPeriods('c1', { limit: 5 }, actor);
    expect(out.items).toHaveLength(2);
    expect(out.nextCursor).toBeNull();
  });

  it('404s an unknown contract and 403s a foreign org', async () => {
    queueResult([]);
    await expect(listContractHourPeriods('nope', { limit: 5 }, actor)).rejects.toMatchObject({ code: 'CONTRACT_NOT_FOUND', status: 404 });
    queueResult([{ id: 'c2', orgId: 'org9', partnerId: 'p1' }]);
    await expect(listContractHourPeriods('c2', { limit: 5 }, actor)).rejects.toMatchObject({ code: 'ORG_DENIED', status: 403 });
  });
});
