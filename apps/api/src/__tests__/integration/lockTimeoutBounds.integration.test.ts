import './setup';
import { describe, it, expect } from 'vitest';
import postgres from 'postgres';

const RUN = !!process.env.DATABASE_URL;

/**
 * `lock_timeout` and `statement_timeout` are NOT interchangeable, and the
 * difference is the whole reason `db/lockTimeout.ts` installs both.
 *
 * `lock_timeout` applies to each lock ACQUISITION separately. A statement that
 * locks N rows therefore gets a fresh interval per row, so a run of staggered
 * blockers can hold a pooled connection for roughly the SUM of the waits while
 * retaining every lock already taken. `statement_timeout` is the only one that
 * caps the statement as a whole.
 *
 * Tested here against the real server rather than asserted in a comment,
 * because a future refactor that "simplifies" the pair down to one would
 * reintroduce an unbounded wait while every higher-level test still passed.
 */
describe.runIf(RUN)('lock_timeout is per-acquisition; statement_timeout bounds the statement', () => {
  const mk = () => postgres(process.env.DATABASE_URL!, { max: 1 });

  /** Holds `id`, resolving `acquired` only once the row lock is actually held. */
  function holder(sqlc: ReturnType<typeof mk>, id: number, holdMs: number) {
    let acquired!: () => void;
    const ready = new Promise<void>((r) => { acquired = r; });
    const done = sqlc.begin(async (tx) => {
      await tx`SELECT id FROM _lt_bounds WHERE id = ${id} FOR UPDATE`;
      acquired();
      await new Promise((r) => setTimeout(r, holdMs));
    });
    return { ready, done };
  }

  it('two staggered blockers slip past lock_timeout but not statement_timeout', async () => {
    const setup = mk();
    await setup`CREATE TABLE IF NOT EXISTS _lt_bounds(id int primary key)`;
    await setup`TRUNCATE _lt_bounds`;
    await setup`INSERT INTO _lt_bounds VALUES (1),(2)`;

    const a = mk(); const b = mk(); const reader = mk();
    // Barriers, not sleeps: both rows are provably locked before the reader
    // starts, so the schedule cannot silently degrade into a single blocker.
    const h1 = holder(a, 1, 900);
    const h2 = holder(b, 2, 1800);
    await Promise.all([h1.ready, h2.ready]);

    // Each individual wait stays under 1000ms; their sum does not.
    const t0 = Date.now();
    let lockOnly: unknown;
    try {
      await reader.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '1000ms'`;
        await tx`SELECT id FROM _lt_bounds WHERE id IN (1,2) ORDER BY id FOR UPDATE`;
      });
    } catch (err) { lockOnly = err; }
    const lockOnlyMs = Date.now() - t0;

    await Promise.allSettled([h1.done, h2.done]);

    // lock_timeout alone did NOT bound it: it ran past its own 1000ms.
    expect(lockOnly).toBeUndefined();
    expect(lockOnlyMs).toBeGreaterThan(1000);

    // Same shape, now with a statement deadline: bounded.
    const h3 = holder(a, 1, 900);
    const h4 = holder(b, 2, 1800);
    await Promise.all([h3.ready, h4.ready]);

    const t1 = Date.now();
    let bounded: any;
    try {
      await reader.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '1000ms'`;
        await tx`SET LOCAL statement_timeout = '1200ms'`;
        await tx`SELECT id FROM _lt_bounds WHERE id IN (1,2) ORDER BY id FOR UPDATE`;
      });
    } catch (err) { bounded = err; }
    const boundedMs = Date.now() - t1;

    await Promise.allSettled([h3.done, h4.done]);
    await setup`DROP TABLE IF EXISTS _lt_bounds`;
    await Promise.all([a.end(), b.end(), reader.end(), setup.end()]);

    expect(bounded?.code).toBe('57014');
    expect(boundedMs).toBeLessThan(lockOnlyMs);
  }, 40000);
});
