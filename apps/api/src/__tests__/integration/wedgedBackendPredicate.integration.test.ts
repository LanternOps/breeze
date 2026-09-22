/**
 * #6048 — live-database checks the unit job cannot make.
 *
 * Two things about `WEDGED_BACKEND_SELECT_SQL` can only be established against a
 * real Postgres, and both of them fail in production rather than in CI if they
 * are wrong:
 *
 *   1. **It has to parse and run.** The predicate is a raw string handed to
 *      `sql.unsafe`, so a typo, a column that does not exist on this server
 *      version, or a bad `make_interval` cast is not a compile error — it is an
 *      exception thrown from the recovery path at the exact moment the pool is
 *      already short a slot.
 *   2. **It must not match a healthy connection.** The single most common
 *      long-lived state in this codebase is an open transaction holding a
 *      pooled connection (that is what `withDbAccessContext` IS). If the
 *      predicate matched that, the reclaimer would terminate live tenant
 *      transactions. This test holds one open and asserts the predicate stays
 *      empty — an open transaction reports `idle in transaction`, never
 *      `active`/`ClientRead`.
 *
 * NOT ASSERTED HERE, and deliberately: that the reclaimer terminates a genuinely
 * wedged backend. Manufacturing the wedge requires driving the extended
 * protocol by hand and abandoning the connection mid-exchange, which would leak
 * a backend in the test database for the life of the run. The termination path
 * is covered by unit tests against an injected terminator.
 */

import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { withSystemDbAccessContext } from '../../db';
import { resolveRequestDatabaseConfig } from '../../db/requestDatabaseConfig';
import {
  WEDGED_BACKEND_SELECT_SQL,
  type WedgedBackendRow,
} from '../../db/wedgedBackends';

const hasDatabase = Boolean(process.env.DATABASE_URL || process.env.DATABASE_URL_APP);
const describeIf = hasDatabase ? describe : describe.skip;

describeIf('#6048 wedged-backend predicate (live database)', () => {
  async function scan(minAgeSeconds: number, prologueOnly = false): Promise<WedgedBackendRow[]> {
    const { url } = resolveRequestDatabaseConfig();
    const sql = postgres(url, {
      max: 1,
      connect_timeout: 10,
      idle_timeout: 1,
      connection: { application_name: 'breeze-wedged-backend-predicate-test' },
    });
    try {
      const rows = await sql.unsafe(WEDGED_BACKEND_SELECT_SQL, [minAgeSeconds, prologueOnly]);
      return rows as unknown as WedgedBackendRow[];
    } finally {
      await sql.end({ timeout: 0 });
    }
  }

  it('parses and executes against pg_stat_activity', async () => {
    // A zero-second threshold is the widest the predicate can ever be, so this
    // exercises every clause rather than being satisfied by an empty result.
    await expect(scan(0)).resolves.toBeInstanceOf(Array);
  });

  it('does not match a healthy open transaction holding a pooled connection', async () => {
    await withSystemDbAccessContext(async () => {
      // Inside a live `withDbAccessContext` transaction: prologue applied,
      // connection held, exactly the shape the reclaimer must never touch.
      const rows = await scan(0);
      expect(rows.filter((row) => row.query.includes('set_config'))).toEqual([]);
    }, 'wedgedBackendPredicateTest');
  });

  // #6348: the reclaimer's narrowed `query like 'select set_config(''breeze.%'`
  // clause is a hand-escaped literal in a raw string. The scanner now drives
  // termination through it every 5 minutes, so a quoting mistake must fail
  // here, not in prod during a reclaim.
  it('parses and executes the reclaimer (prologue-only) predicate', async () => {
    await expect(scan(0, true)).resolves.toBeInstanceOf(Array);
  });

  it('prologue-only predicate does not match a healthy open transaction either', async () => {
    await withSystemDbAccessContext(async () => {
      const rows = await scan(0, true);
      expect(rows).toEqual([]);
    }, 'wedgedBackendPredicateTest');
  });
});
