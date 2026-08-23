/**
 * Multi-currency wave 6 (#3778) — the mismatch report must not compute an
 * eligibility verdict it is going to throw away.
 *
 * reasonFor short-circuits to STATUS_NOT_ACTIVE for any non-active contract, so
 * for cancelled / expired / draft / paused rows the four-query eligibility
 * computation was pure waste — up to 100 of them, plus 100 org-wide
 * invoice_lines scans, on one connection per operator page load.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// vi.hoisted: vi.mock factories are hoisted above these declarations, so the
// spies they close over must be hoisted too.
const h = vi.hoisted(() => ({
  inspectContractCurrencyEligibility: vi.fn(async () => ({
    eligible: true,
    draftInvoiceIds: [] as string[],
    orphanedBillingPeriodIds: [] as string[],
    orphanedContractSourceLineIds: [] as string[],
    brokenLineageInvoiceIds: [] as string[],
  })),
  rows: [] as Record<string, unknown>[],
  transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
}));
const { inspectContractCurrencyEligibility, rows, transaction } = h;

vi.mock('../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            orderBy: () => ({ limit: () => Promise.resolve(h.rows) }),
          }),
        }),
      }),
    }),
    transaction: h.transaction,
  },
}));

vi.mock('./contractService', () => ({
  inspectContractCurrencyEligibility: h.inspectContractCurrencyEligibility,
}));

import { listContractCurrencyMismatches } from './contractCurrencyReportService';
import type { ContractActor } from './contractTypes';

const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: null } as unknown as ContractActor;

function row(id: string, status: string, orgId = 'org-A') {
  return {
    contractId: id, contractName: `C ${id}`, orgId, orgName: 'Org A',
    status, contractCurrencyCode: 'USD', orgCurrencyCode: 'EUR', nextBillingAt: null,
  };
}

beforeEach(() => {
  rows.length = 0;
  inspectContractCurrencyEligibility.mockClear();
  transaction.mockClear();
});

describe('listContractCurrencyMismatches — eligibility is computed only where it can matter', () => {
  it('issues NO eligibility queries for non-active rows', async () => {
    rows.push(row('c1', 'cancelled'), row('c2', 'expired'), row('c3', 'draft'), row('c4', 'paused'));

    const res = await listContractCurrencyMismatches({}, actor);

    expect(inspectContractCurrencyEligibility).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(res.items.map((i) => i.ineligibleReason)).toEqual(
      ['STATUS_NOT_ACTIVE', 'STATUS_NOT_ACTIVE', 'STATUS_NOT_ACTIVE', 'STATUS_NOT_ACTIVE'],
    );
    expect(res.items.every((i) => i.activeChangeEligible === false)).toBe(true);
  });

  it('computes eligibility for ACTIVE rows only, skipping the non-active ones in the same page', async () => {
    rows.push(row('c1', 'active'), row('c2', 'cancelled'), row('c3', 'active'));

    const res = await listContractCurrencyMismatches({}, actor);

    expect(inspectContractCurrencyEligibility).toHaveBeenCalledTimes(2);
    const inspected = inspectContractCurrencyEligibility.mock.calls.map((c) => (c as unknown[])[1]);
    expect(inspected).toEqual(['c1', 'c3']);
    expect(res.items.find((i) => i.contractId === 'c2')!.ineligibleReason).toBe('STATUS_NOT_ACTIVE');
    expect(res.items.find((i) => i.contractId === 'c1')!.activeChangeEligible).toBe(true);
  });

  it('shares ONE orphan-scan memo across every row of the page', async () => {
    rows.push(row('c1', 'active'), row('c2', 'active'), row('c3', 'active', 'org-B'));

    await listContractCurrencyMismatches({}, actor);

    const caches = inspectContractCurrencyEligibility.mock.calls
      .map((c) => ((c as unknown[])[2] as { orphanScanCache?: Map<string, string[]> }).orphanScanCache);
    expect(caches).toHaveLength(3);
    expect(caches[0]).toBeInstanceOf(Map);
    // Same object identity for every row — that is what makes the org-wide scan
    // run once per org rather than once per row.
    expect(caches[1]).toBe(caches[0]);
    expect(caches[2]).toBe(caches[0]);
  });

  it('does not leak the memo between separate report calls', async () => {
    rows.push(row('c1', 'active'));
    await listContractCurrencyMismatches({}, actor);
    const first = (inspectContractCurrencyEligibility.mock.calls[0] as unknown[])[2] as { orphanScanCache?: Map<string, string[]> };

    inspectContractCurrencyEligibility.mockClear();
    await listContractCurrencyMismatches({}, actor);
    const second = (inspectContractCurrencyEligibility.mock.calls[0] as unknown[])[2] as { orphanScanCache?: Map<string, string[]> };

    expect(second.orphanScanCache).not.toBe(first.orphanScanCache);
  });
});
