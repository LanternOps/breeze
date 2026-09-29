/**
 * Run code as if the API process were deployed in `timeZone`.
 *
 * CI runners and hosted production run in UTC, where a Date's local-time
 * behaviour and its UTC behaviour are indistinguishable. Code that reads a
 * Date's local fields, parses an offsetless string with `new Date(...)`, or
 * adjusts by `getTimezoneOffset()` is only exercised on a non-UTC host. This
 * helper gives a test that host without depending on the runner's own zone.
 *
 * Node re-reads `process.env.TZ` whenever it is assigned or deleted, on the
 * main thread and in child processes (vitest's default `forks` pool). It does
 * NOT take effect inside a worker thread. The helper therefore checks that the
 * switch landed, by comparing `getTimezoneOffset()` against the offset Intl
 * computes for the zone, and throws if it did not. A test that asks for a
 * western or eastern host can never silently run in the ambient zone instead.
 *
 * The previous zone is restored when `fn` returns, throws, or (for an async
 * `fn`) settles. Only one zone can be active per process, so do not overlap
 * calls (e.g. from `it.concurrent`).
 */
export function withHostTimeZone<T>(timeZone: string, fn: () => T): T {
  const previous = process.env.TZ;
  const restore = () => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  };

  process.env.TZ = timeZone;
  let result: T;
  try {
    assertHostTimeZoneActive(timeZone);
    result = fn();
  } catch (err) {
    restore();
    throw err;
  }

  if (result && typeof (result as { then?: unknown }).then === 'function') {
    return (result as unknown as Promise<unknown>).finally(restore) as T;
  }
  restore();
  return result;
}

/**
 * The UTC offset of `timeZone` at `atMs`, in `Date#getTimezoneOffset()`'s sign
 * convention (minutes, positive WEST of UTC), computed from Intl alone so it
 * does not depend on the process's own zone.
 */
export function zoneOffsetMinutes(timeZone: string, atMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(atMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wallAsUtcMs = Date.UTC(
    get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'),
  );
  const flooredAtMs = Math.floor(atMs / 1000) * 1000;
  return (flooredAtMs - wallAsUtcMs) / 60_000;
}

function assertHostTimeZoneActive(timeZone: string): void {
  // Two probes six months apart, so a zone is confirmed on both sides of DST.
  for (const probe of [Date.UTC(2026, 0, 15, 12), Date.UTC(2026, 6, 15, 12)]) {
    const expected = zoneOffsetMinutes(timeZone, probe);
    const actual = new Date(probe).getTimezoneOffset();
    if (actual !== expected) {
      throw new Error(
        `withHostTimeZone(${JSON.stringify(timeZone)}): the process still reports a UTC offset of ` +
          `${actual} min (expected ${expected}). process.env.TZ does not take effect in a worker ` +
          `thread; run this test in a forked process.`,
      );
    }
  }
}
