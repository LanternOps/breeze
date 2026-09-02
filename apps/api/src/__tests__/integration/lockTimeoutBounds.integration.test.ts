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
 * Tested here against the real server rather than asserted in a comment.
 *
 * NOTE what this file does NOT do: it installs the settings itself, so it
 * proves the Postgres semantics, not that catalogService installs both. That
 * wiring is pinned separately in catalogBundleCompositionRace
 * ("installs BOTH bounds before the locking query") — an earlier version of
 * this header wrongly claimed this test would catch that refactor.
 */
describe.runIf(RUN)('lock_timeout is per-acquisition; statement_timeout bounds the statement', () => {
  const mk = () => postgres(process.env.DATABASE_URL!, { max: 1 });

  /** Holds `id`, resolving `acquired` only once the row lock is actually held. */
  function holder(sqlc: ReturnType<typeof mk>, id: number, release: Promise<void>) {
    let acquired!: () => void;
    const ready = new Promise<void>((r) => { acquired = r; });
    const done = sqlc.begin(async (tx) => {
      await tx`SELECT id FROM _lt_bounds WHERE id = ${id} FOR UPDATE`;
      acquired();
      // Held until the CALLER releases. Hold durations are driven from a single
      // clock started after both holders are confirmed, rather than from each
      // holder's own acquisition — otherwise acquisition skew silently changes
      // the schedule the assertions depend on.
      await release;
    });
    return { ready, done };
  }

  /** Resolves after `ms`, measured from when this is called. */
  const after = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  it('two staggered blockers slip past lock_timeout but not statement_timeout', async () => {
    const setup = mk(); const a = mk(); const b = mk(); const reader = mk();
    // Generous margins on purpose: a 100ms cushion flakes on a loaded CI box,
    // and this test failing for timing reasons would teach the wrong lesson.
    const HOLD_1 = 2000, HOLD_2 = 4000, LOCK_MS = 2500, STMT_MS = 3000;
    try {
      await setup`CREATE TABLE IF NOT EXISTS _lt_bounds(id int primary key)`;
      await setup`TRUNCATE _lt_bounds`;
      await setup`INSERT INTO _lt_bounds VALUES (1),(2)`;

      const run = async (withStatementTimeout: boolean) => {
        let r1!: () => void, r2!: () => void;
        const g1 = new Promise<void>((r) => { r1 = r; });
        const g2 = new Promise<void>((r) => { r2 = r; });
        const h1 = holder(a, 1, g1);
        const h2 = holder(b, 2, g2);
        // Both rows provably locked BEFORE the clock that drives releases.
        await Promise.all([h1.ready, h2.ready]);
        void after(HOLD_1).then(r1);
        void after(HOLD_2).then(r2);

        const t0 = Date.now();
        let caught: any;
        try {
          await reader.begin(async (tx) => {
            // `unsafe` because SET does not accept bind parameters — a
            // templated value here becomes $1 and Postgres rejects it with a
            // syntax error. The values are local constants, not caller input.
            await tx.unsafe(`SET LOCAL lock_timeout = '${LOCK_MS}ms'`);
            if (withStatementTimeout) await tx.unsafe(`SET LOCAL statement_timeout = '${STMT_MS}ms'`);
            await tx`SELECT id FROM _lt_bounds WHERE id IN (1,2) ORDER BY id FOR UPDATE`;
          });
        } catch (err) { caught = err; }
        const ms = Date.now() - t0;
        await Promise.allSettled([h1.done, h2.done]);
        return { caught, ms };
      };

      // Each individual wait (2000ms, then ~2000ms more) stays under the 2500ms
      // per-lock bound; their sum does not. lock_timeout alone cannot stop it.
      const lockOnly = await run(false);
      expect(lockOnly.caught).toBeUndefined();
      expect(lockOnly.ms).toBeGreaterThan(LOCK_MS);

      // Same schedule, plus a statement deadline: bounded.
      const bounded = await run(true);
      expect(bounded.caught?.code).toBe('57014');
      expect(bounded.ms).toBeLessThan(lockOnly.ms);
    } finally {
      // In `finally` so a timing failure cannot leak clients into the rest of
      // the suite and turn one red test into a cascade.
      await setup`DROP TABLE IF EXISTS _lt_bounds`.catch(() => {});
      await Promise.allSettled([a.end(), b.end(), reader.end(), setup.end()]);
    }
  }, 60000);
});
