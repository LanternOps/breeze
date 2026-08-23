/**
 * Multi-currency wave 6 (#3778) — COST of the contract-vs-org currency mismatch
 * report.
 *
 * The report walks up to MAX_LIMIT = 100 rows and asked
 * inspectContractCurrencyEligibility for a verdict on every one. Each call issues
 * four queries — two WITH RECURSIVE lineage walks, one ORG-WIDE invoice_lines
 * scan, one per-period proof — on a single connection. Two things made that
 * gratuitously expensive:
 *
 *   1. The org-wide scan (blocker 4) is ORG-scoped, identical for every contract
 *      of the same org, and was re-run once per ROW.
 *   2. reasonFor short-circuits to STATUS_NOT_ACTIVE for any non-active row, so
 *      the entire four-query computation was executed and then discarded for
 *      cancelled / expired / draft / paused contracts.
 *
 * This repo has documented connection-hold and pool-starvation incidents, so the
 * query count of an operator page load is a correctness-adjacent property, not a
 * micro-optimisation. These tests pin it.
 */
import { describe, expect, it, vi } from 'vitest';

import { inspectContractCurrencyEligibility } from './contractService';

/**
 * A minimal DbExecutor stand-in. Every tx.execute consumer in the helper is
 * satisfied by an empty row set, so a single vi.fn serves all four queries and
 * the CALL COUNT becomes the thing under test — no SQL-text matching needed.
 */
function fakeTx(orgId: string) {
  const execute = vi.fn(async () => [] as unknown[]);
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ id: 'contract-1', orgId, partnerId: 'partner-1' }]),
        }),
      }),
    }),
    execute,
  };
  return { tx: tx as never, execute };
}

describe('inspectContractCurrencyEligibility — org-wide scan memoisation', () => {
  it('issues the org-wide orphan scan once per ORG, not once per contract', async () => {
    const orphanScanCache = new Map<string, string[]>();

    const first = fakeTx('org-A');
    await inspectContractCurrencyEligibility(first.tx, 'contract-1', { orphanScanCache });
    // reachable + directDrafts + orphanSources + periods
    expect(first.execute).toHaveBeenCalledTimes(4);
    expect(orphanScanCache.has('org-A')).toBe(true);

    // A SECOND contract in the SAME org: the org-wide scan must be served from
    // the memo, leaving only the three contract-scoped queries.
    const second = fakeTx('org-A');
    await inspectContractCurrencyEligibility(second.tx, 'contract-2', { orphanScanCache });
    expect(second.execute).toHaveBeenCalledTimes(3);

    // A DIFFERENT org must NOT be served from another org's memo.
    const other = fakeTx('org-B');
    await inspectContractCurrencyEligibility(other.tx, 'contract-3', { orphanScanCache });
    expect(other.execute).toHaveBeenCalledTimes(4);
  });

  it('serves the memoised value as the verdict — it is the orphan scan that is skipped', async () => {
    // Pre-seeding the cache proves WHICH query the saved call was: the returned
    // orphan ids can only have come from the memo, and the other three verdict
    // fields stay empty from the live (still-executed) queries.
    const orphanScanCache = new Map<string, string[]>([['org-A', ['line-legacy-1']]]);
    const { tx, execute } = fakeTx('org-A');

    const result = await inspectContractCurrencyEligibility(tx, 'contract-1', { orphanScanCache });

    expect(execute).toHaveBeenCalledTimes(3);
    expect(result.orphanedContractSourceLineIds).toEqual(['line-legacy-1']);
    expect(result.draftInvoiceIds).toEqual([]);
    expect(result.orphanedBillingPeriodIds).toEqual([]);
    expect(result.brokenLineageInvoiceIds).toEqual([]);
    expect(result.eligible).toBe(false);
  });

  it('the MUTATION path passes no cache and always re-runs all four queries', async () => {
    // changeContractCurrency must never accept a memoised blocker (4): its
    // verdict has to be read fresh under the contract's FOR UPDATE.
    const a = fakeTx('org-A');
    await inspectContractCurrencyEligibility(a.tx, 'contract-1');
    expect(a.execute).toHaveBeenCalledTimes(4);

    const b = fakeTx('org-A');
    await inspectContractCurrencyEligibility(b.tx, 'contract-2');
    expect(b.execute).toHaveBeenCalledTimes(4);
  });
});
