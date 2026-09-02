import { describe, expect, it } from 'vitest';
import { pgOffsetlessTimestamp } from './pgOffsetlessTimestamp';

/**
 * Guards the SIMULATION itself. If this helper stopped reproducing the driver's
 * behaviour, every timezone test built on it would go quietly vacuous, so the
 * two load-bearing properties are asserted directly rather than round-tripped
 * through the function under test (which would be circular).
 */
describe('pgOffsetlessTimestamp', () => {
  const INSTANT = Date.UTC(2026, 7, 25, 18, 34, 15, 123);

  it('reproduces the exact wire format Postgres emits for an offsetless column', () => {
    // Reconstruct the string the helper parsed, in the host's own zone: it must
    // be the UTC wall clock of the instant, with no zone marker.
    const d = pgOffsetlessTimestamp(INSTANT);
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    const wire =
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;

    expect(wire).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(wire).toBe('2026-08-25 18:34:15.123');
  });

  it('carries the UTC wall clock in LOCAL fields, which is the whole defect', () => {
    const d = pgOffsetlessTimestamp(INSTANT);
    // Local fields read back as the UTC wall clock...
    expect(d.getHours()).toBe(18);
    // ...so the epoch is wrong by exactly the host offset. Under UTC that is
    // zero, which is precisely why CI cannot see this class of bug.
    expect(d.getTime() - INSTANT).toBe(d.getTimezoneOffset() * 60_000);
  });
});
