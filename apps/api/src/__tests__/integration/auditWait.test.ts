/**
 * Unit coverage for the `awaitAuditRows` poll (#6555).
 *
 * The helper needs no database — it only drives a caller-supplied `read`. It
 * lives here because it belongs next to the integration suites that use it, and
 * the unit runner excludes `src/__tests__/integration/**` wholesale, so this
 * file runs under `vitest.integration.config.ts` with the rest of the directory.
 *
 * What is pinned here is the contract the whole PR rests on: the helper removes
 * a timing race and nothing else. It must never throw, never assert, and never
 * return early on fewer rows than asked for — otherwise a regression that drops
 * an audit row could be masked before the caller's own `expect` ever sees it.
 */
import { describe, expect, it } from 'vitest';
import { awaitAuditRows } from './auditWait';

/** A `read` that yields each scripted result in turn, repeating the last one. */
function scriptedRead<Row>(script: Row[][]): { read: () => Promise<Row[]>; calls: () => number } {
  let call = 0;
  return {
    read: async () => script[Math.min(call++, script.length - 1)]!,
    calls: () => call,
  };
}

describe('awaitAuditRows', () => {
  it('returns on the first read when the rows are already there', async () => {
    const { read, calls } = scriptedRead([[{ action: 'a' }, { action: 'b' }]]);
    const rows = await awaitAuditRows(read, 2, { pollMs: 1 });
    expect(rows).toEqual([{ action: 'a' }, { action: 'b' }]);
    expect(calls(), 'a satisfied read must not poll again').toBe(1);
  });

  it('keeps polling until the count is reached, then returns the rows it saw', async () => {
    const { read, calls } = scriptedRead([[], [{ action: 'a' }], [{ action: 'a' }, { action: 'b' }]]);
    const rows = await awaitAuditRows(read, 2, { pollMs: 1 });
    expect(rows).toEqual([{ action: 'a' }, { action: 'b' }]);
    expect(calls()).toBe(3);
  });

  it('returns the last short read after the deadline instead of throwing', async () => {
    // The caller's own assertion is what must go red — the helper stays silent
    // so that failure carries the suite's message, not a generic timeout.
    const { read } = scriptedRead([[{ action: 'a' }]]);
    const rows = await awaitAuditRows(read, 2, { pollMs: 1, timeoutMs: 20 });
    expect(rows).toEqual([{ action: 'a' }]);
  });

  it('honours the deadline rather than polling forever', async () => {
    const { read, calls } = scriptedRead<{ action: string }>([[]]);
    const started = Date.now();
    await awaitAuditRows(read, 1, { pollMs: 1, timeoutMs: 30 });
    const elapsed = Date.now() - started;
    expect(elapsed, 'must not return before the deadline').toBeGreaterThanOrEqual(25);
    expect(elapsed, 'must not overrun the deadline').toBeLessThan(5_000);
    expect(calls(), 'must have retried, not read once and given up').toBeGreaterThan(1);
  });

  it('accepts more rows than expected so an over-count still reaches the caller', async () => {
    // `>=`, not `===`: an extra row is a real regression, and the caller's
    // exact-length assertion is what should report it. Blocking here would
    // instead burn the full timeout and report nothing useful.
    const { read } = scriptedRead([[{ action: 'a' }, { action: 'b' }, { action: 'c' }]]);
    const rows = await awaitAuditRows(read, 2, { pollMs: 1, timeoutMs: 50 });
    expect(rows).toHaveLength(3);
  });
});
