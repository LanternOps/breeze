/**
 * #8143 (W04 / spec W1e) — pool recovery against real Postgres.
 *
 * Each test imports a FRESH `db` module (own pool, own DB_POOL_MAX, own
 * timeouts) so it can size the pool down to 1–3 and make every assertion
 * deterministic. Acceptance from the spec: after a slow-event-loop stall the
 * pool is back at max within 30 s, with no leaked connection and no double use.
 *
 * Runs under the shared `vitest.integration.config.ts`. Its setup file's hooks
 * (TRUNCATE on beforeEach, a superuser + a raw breeze_app client) do not touch
 * the fresh module's pool, so no dedicated runner is needed: `vi.resetModules()`
 * plus env set BEFORE the dynamic import gives each test its own `db` module and
 * its own pool-admission registry.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { sql } from 'drizzle-orm';
import { startPgWireProxy, type PgWireProxy } from './helpers/pgWireProxy';
import { isRecoverablePostgresConnectionTeardown } from '../../services/rejectionSuppressions';

// The two getters are re-exported from `db/index.ts` by W04 Task 7. Typed from
// their home modules so this suite typechecks before that wiring lands; at
// runtime the fresh module either has them (Task 7) or the first call is the
// discriminating red (`... is not a function`).
type DbModule = typeof import('../../db')
  & Pick<typeof import('../../db/poolAdmission'), 'getRequestPoolAdmission'>
  & Pick<typeof import('../../db/prologueDeadline'), 'getDeadlineExpiryTotals'>;

const APP_URL = process.env.DATABASE_URL_APP;
const describeIf = APP_URL ? describe : describe.skip;
const ORIGINAL_ENV = { ...process.env };
const ORG = '5b0f3c1e-8d2a-4f6b-9c3e-1a2b3c4d5e6f';
const REQUEST_POOL_APPLICATION_NAME = 'breeze-api';

let admin: Sql;
let current: DbModule | null = null;
let proxy: PgWireProxy | null = null;

function busyWait(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // deliberately stalling the event loop
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
    await sleep(100);
  }
}

/**
 * Database clock reading taken just before the fresh module is imported. The
 * shared integration setup's own module graph keeps a request-pool connection
 * of its own (same application_name, same role), so the leak check only looks
 * at backends started after this instant, i.e. the ones this test's fresh pool
 * opened. Read from Postgres (clock_timestamp()) so host/container clock skew
 * cannot shift the cut-off.
 */
let freshPoolStartedAt: Date = new Date(0);

async function requestPoolBackends(): Promise<Array<{ pid: number; state: string | null; xact_start: Date | null }>> {
  const rows = await admin<Array<{ pid: number; state: string | null; xact_start: Date | null }>>`
    select pid, state, xact_start
      from pg_stat_activity
     where datname = current_database()
       and application_name = ${REQUEST_POOL_APPLICATION_NAME}
       and backend_start >= ${freshPoolStartedAt}`;
  return rows;
}

async function loadFreshDb(env: Record<string, string>): Promise<DbModule> {
  const [clock] = await admin<Array<{ now: Date }>>`select clock_timestamp() as now`;
  freshPoolStartedAt = clock!.now;
  vi.resetModules();
  Object.assign(process.env, env);
  current = (await import('../../db')) as DbModule;
  return current;
}

async function startProxy(): Promise<PgWireProxy> {
  const target = new URL(APP_URL!);
  proxy = await startPgWireProxy({ host: target.hostname, port: Number(target.port || 5432) });
  return proxy;
}

function admission(db: DbModule) {
  const gate = db.getRequestPoolAdmission();
  if (!gate) throw new Error('db module did not register its pool admission gate');
  return gate;
}

async function backendPid(db: DbModule): Promise<number> {
  const rows = (await db.db.execute(sql`select pg_backend_pid() as pid`)) as unknown as Array<{ pid: number }>;
  return Number(rows[0]!.pid);
}

/**
 * Real-Postgres leak check (spec W1e "no leaked connections"): the fresh
 * request pool (application_name 'breeze-api', minus the backends that
 * predate it) holds at most `max` backends, and none of them is inside a
 * transaction. A backend left `idle in transaction` is a connection whose RLS
 * GUCs / open transaction could be handed to the next request.
 */
async function assertNoLeakedRequestBackends(max: number): Promise<void> {
  const rows = await requestPoolBackends();
  expect(rows.length, `request-pool backends: ${JSON.stringify(rows)}`).toBeLessThanOrEqual(max);
  for (const row of rows) {
    expect(row.state, `backend ${row.pid} state`).toBe('idle');
    expect(row.xact_start, `backend ${row.pid} has an open transaction`).toBeNull();
  }
}

const ORG_CONTEXT = {
  scope: 'organization' as const,
  orgId: ORG,
  accessibleOrgIds: [ORG],
  accessiblePartnerIds: null,
  userId: null,
  currentPartnerId: null,
};

const TYPED_TIMEOUTS = ['DbPoolAcquireTimeoutError', 'DbAccessContextPrologueTimeoutError'];

/**
 * Production parity for the postgres@3 teardown write race (#1105). When a
 * backend dies mid-transaction (the wedge test terminates one by design; the
 * proxy tears sockets down in afterEach), postgres.js's `begin` issues its
 * ROLLBACK on the dead connection and the orphaned `nextWrite` Immediate throws
 * `Cannot read properties of null (reading 'write')` outside every async frame.
 * The API's own `uncaughtException` handler (`index.ts`) suppresses exactly
 * this, via the same predicate; without the same filter here vitest would count
 * it as an unhandled error and fail the file for a behaviour production
 * survives. Everything else is forwarded to vitest's listeners untouched.
 */
let savedUncaughtListeners: NodeJS.UncaughtExceptionListener[] = [];
let suppressedTeardownWrites = 0;
function installTeardownWriteRaceFilter(): void {
  savedUncaughtListeners = process.listeners('uncaughtException');
  process.removeAllListeners('uncaughtException');
  process.on('uncaughtException', (err, origin) => {
    if (isRecoverablePostgresConnectionTeardown(err)) {
      suppressedTeardownWrites += 1;
      return;
    }
    for (const listener of savedUncaughtListeners) listener(err, origin);
  });
}
function removeTeardownWriteRaceFilter(): void {
  process.removeAllListeners('uncaughtException');
  for (const listener of savedUncaughtListeners) process.on('uncaughtException', listener);
  savedUncaughtListeners = [];
}

describeIf('db pool recovery (#8143)', () => {
  beforeAll(() => {
    installTeardownWriteRaceFilter();
    admin = postgres(APP_URL!, { max: 1 });
  });
  afterAll(async () => {
    await admin.end({ timeout: 1 });
    removeTeardownWriteRaceFilter();
    if (suppressedTeardownWrites > 0) {
      console.info(`[W04] suppressed ${suppressedTeardownWrites} postgres teardown write race(s), as production does (#1105)`);
    }
  });
  afterEach(async () => {
    await proxy?.close();
    proxy = null;
    if (current) {
      await Promise.race([current.closeDb(), sleep(3_000)]);
      current = null;
    }
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  /**
   * 12 contexts against a stalled event loop. Without `inFlightVia` the stall
   * starts right after the calls are issued (before any connection is handed
   * over), which exercises the ACQUIRE clock only. With a proxy, the stall
   * starts the instant the first prologue is on the wire, so its reply sits
   * buffered behind the stall and the PROLOGUE clock expires on a live
   * transaction: the case that abandons a permit.
   */
  async function stallScenario(
    db: DbModule,
    inFlightVia?: PgWireProxy,
  ): Promise<{ errors: number; stallEndedAt: number }> {
    let stallEndedAt = 0;
    const stall = () => {
      busyWait(2_500); // longer than both 1 s budgets
      stallEndedAt = Date.now();
    };
    inFlightVia?.armStallAfterNextPrologue(stall);
    const calls = Array.from({ length: 12 }, () =>
      db.withSystemDbAccessContext(() => db.db.execute(sql`select pg_sleep(0.05)`)),
    );
    if (inFlightVia) {
      await waitFor(() => stallEndedAt !== 0, 5_000, 'the stall to fire on an in-flight prologue');
    } else {
      await new Promise((resolve) => setImmediate(resolve));
      stall();
    }
    const outcomes = await Promise.allSettled(calls);
    let errors = 0;
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        errors += 1;
        expect(TYPED_TIMEOUTS).toContain((outcome.reason as Error).name);
      }
    }
    return { errors, stallEndedAt };
  }

  it('permits and real connections are back at max within 30 s of an event-loop stall', async () => {
    const p = await startProxy();
    const db = await loadFreshDb({
      DATABASE_URL_APP: p.urlFor(APP_URL!),
      DB_POOL_MAX: '3',
      DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS: '1000',
      DB_POOL_ACQUIRE_TIMEOUT_MS: '1000',
      // No lag grace: the stall must actually expire budgets and abandon
      // permits, or "back at max" is trivially true (grace 2000 → 0/12 errors).
      DB_TIMER_LAG_GRACE_MS: '0',
    });
    const suppressedBefore = suppressedTeardownWrites;
    await Promise.all([0, 1].map(() => db.withSystemDbAccessContext(() => db.db.execute(sql`select 1`))));

    const { errors, stallEndedAt } = await stallScenario(db, p);
    expect(errors).toBeGreaterThan(0);
    // At least one prologue expiry abandoned the permit of a live transaction.
    // Read from the monotonic totals, not the snapshot: an abandoned permit can
    // already have come back by rollback before allSettled resolved.
    expect(admission(db).totals().abandoned).toBeGreaterThan(0);

    await waitFor(() => {
      const s = admission(db).snapshot();
      return s.inUse === 0 && s.waiting === 0 && s.abandoned === 0 && s.effectivePermits === 3;
    }, 30_000, 'all permits returned');
    expect(Date.now() - stallEndedAt).toBeLessThan(30_000);

    // All three permits usable AT ONCE on three distinct backends: two
    // top-level contexts plus one nested escalation (the reserve).
    const pids: number[] = [];
    let release!: () => void;
    const allHeld = new Promise<void>((resolve) => { release = resolve; });
    const hold = async () => {
      pids.push(await backendPid(db));
      if (pids.length === 3) release();
      await allHeld;
    };
    const parent = (nest: boolean) => db.withSystemDbAccessContext(async () => {
      if (nest) {
        // The nesting parent's own backend counts too: it stays held while the
        // nested context (served from the reserve) runs on a third backend.
        pids.push(await backendPid(db));
        await db.runOutsideDbContext(() => db.withSystemDbAccessContext(hold));
        return;
      }
      await hold();
    });
    await Promise.race([
      Promise.all([parent(true), parent(false)]).then(() => undefined),
      sleep(5_000).then(() => { throw new Error('could not hold all three permits at once'); }),
    ]);
    expect(pids).toHaveLength(3);
    // No double use: three concurrently held contexts sit on three backends.
    expect(new Set(pids).size).toBe(3);

    const states = await admin`select pid, state from pg_stat_activity where pid = any(${pids}::int[])`;
    expect(states).toHaveLength(3);
    for (const row of states) expect(row.state).toBe('idle');
    await assertNoLeakedRequestBackends(3);
    // Recovery went through rollback, not through dropped connections.
    expect(suppressedTeardownWrites).toBe(suppressedBefore);
  }, 60_000);

  it('grace keeps buffered replies from failing after a stall (measured, not assumed)', async () => {
    const db = await loadFreshDb({
      DB_POOL_MAX: '3',
      DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS: '1000',
      DB_POOL_ACQUIRE_TIMEOUT_MS: '1000',
    });
    const suppressedBefore = suppressedTeardownWrites;
    await db.withSystemDbAccessContext(() => db.db.execute(sql`select 1`));

    process.env.DB_TIMER_LAG_GRACE_MS = '2000';
    const withGrace = await stallScenario(db);
    await waitFor(() => admission(db).snapshot().inUse === 0, 30_000, 'drain after grace run');

    process.env.DB_TIMER_LAG_GRACE_MS = '0';
    const withoutGrace = await stallScenario(db);
    await waitFor(() => admission(db).snapshot().inUse === 0, 30_000, 'drain after no-grace run');

    console.info(`[W04 grace comparison] errors with grace=${withGrace.errors}, without=${withoutGrace.errors} (of 12)`);
    // Without this the comparison below passes vacuously at 0/0: the stall
    // must actually produce timeouts when the grace is off.
    expect(withoutGrace.errors).toBeGreaterThan(0);
    expect(withGrace.errors).toBeLessThan(withoutGrace.errors);
    await assertNoLeakedRequestBackends(3);
    expect(suppressedTeardownWrites).toBe(suppressedBefore);
  }, 90_000);

  it('slow database: the caller fails fast, fn never runs, the late reply rolls back, no GUC survives', async () => {
    const p = await startProxy();
    const db = await loadFreshDb({
      DATABASE_URL_APP: p.urlFor(APP_URL!),
      DB_POOL_MAX: '1',
      DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS: '1000',
    });
    const pidBefore = await db.withSystemDbAccessContext(() => backendPid(db));

    p.armHoldResponsesAfterNextPrologue();
    const fn = vi.fn(async () => 'never');
    await expect(db.withDbAccessContext(ORG_CONTEXT, fn)).rejects.toMatchObject({
      name: 'DbAccessContextPrologueTimeoutError',
    });
    expect(admission(db).snapshot()).toMatchObject({ inUse: 1, abandoned: 1, effectivePermits: 0 });

    p.resume();
    await waitFor(() => admission(db).snapshot().inUse === 0, 10_000, 'abandoned permit returned by rollback');
    expect(fn).not.toHaveBeenCalled();
    expect(admission(db).totals().abandonedReturned.rollback).toBe(1);

    // DB_POOL_MAX=1, so this bare read runs on the SAME backend that carried the
    // abandoned org-scope prologue. Empty GUCs here are consistent with that
    // transaction having ended (commit would also discard set_config(..., true)
    // values), so they do not on their own prove rollback or is_local; the
    // rollback itself is asserted via abandonedReturned.rollback above.
    const rows = (await db.db.execute(
      sql`select pg_backend_pid() as pid, current_setting('breeze.scope', true) as scope, current_setting('breeze.org_id', true) as org_id`,
    )) as unknown as Array<{ pid: number; scope: string | null; org_id: string | null }>;
    expect(Number(rows[0]!.pid)).toBe(pidBefore);
    expect(rows[0]!.scope ?? '').toBe('');
    expect(rows[0]!.org_id ?? '').toBe('');
    await assertNoLeakedRequestBackends(1);
  }, 30_000);

  it('true ClientRead wedge: the deferred reclaim terminates it and the pool reconnects', async () => {
    const p = await startProxy();
    const db = await loadFreshDb({
      DATABASE_URL_APP: p.urlFor(APP_URL!),
      DB_POOL_MAX: '1',
      DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS: '1000',
      DB_WEDGED_BACKEND_RECLAIM_MIN_INTERVAL_MS: '1000',
      DB_WEDGED_BACKEND_CONFIRM_DELAY_MS: '100',
    });
    await db.withSystemDbAccessContext(() => db.db.execute(sql`select 1`));

    p.armWedgeOnNextPrologue();
    await expect(db.withSystemDbAccessContext(async () => 'never')).rejects.toMatchObject({
      name: 'DbAccessContextPrologueTimeoutError',
    });

    let wedgedPid = 0;
    await waitFor(async () => {
      const rows = await admin`
        select pid from pg_stat_activity
         where state = 'active' and wait_event = 'ClientRead'
           and query like 'select set_config(''breeze.%'`;
      wedgedPid = rows[0]?.pid ?? 0;
      return wedgedPid !== 0;
    }, 5_000, 'the #6048 wedge shape is visible in pg_stat_activity');

    // Deferred, not immediate: at expiry the set_config cannot be old enough to
    // be reclaimable. Eligibility is abandonedAt + prologue budget + 1 s margin
    // (about 2 s after the rejection), so 1 s in the backend must still be
    // alive and its permit still abandoned.
    await sleep(1_000);
    expect(await admin`select 1 from pg_stat_activity where pid = ${wedgedPid}`).toHaveLength(1);
    expect(admission(db).snapshot().abandoned).toBe(1);

    await waitFor(async () => (await admin`select 1 from pg_stat_activity where pid = ${wedgedPid}`).length === 0,
      15_000, 'the wedged backend is terminated');
    await waitFor(() => admission(db).totals().abandonedReturned['connection-closed'] === 1
      && admission(db).snapshot().inUse === 0, 5_000, 'the permit returns via connection-closed');

    await expect(db.withSystemDbAccessContext(() => db.db.execute(sql`select 1`))).resolves.toBeDefined();
    await assertNoLeakedRequestBackends(1);
  }, 40_000);

  it('a request that cannot get a permit never reaches the driver (no zombie BEGIN)', async () => {
    const p = await startProxy();
    const db = await loadFreshDb({
      DATABASE_URL_APP: p.urlFor(APP_URL!),
      DB_POOL_MAX: '1',
      DB_POOL_ACQUIRE_TIMEOUT_MS: '1000',
      DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS: '1000',
      // Deterministic under host lag: no grace stretching the 1 s acquire
      // budget toward the holder's 2.5 s.
      DB_TIMER_LAG_GRACE_MS: '0',
    });
    await db.withSystemDbAccessContext(() => db.db.execute(sql`select 1`));
    const holder = db.withSystemDbAccessContext(() => db.db.execute(sql`select pg_sleep(2.5)`));
    await waitFor(() => p.stats.begins === 2, 2_000, 'holder BEGIN sent');

    const waiters = [0, 1, 2].map(() => db.withSystemDbAccessContext(async () => 'late'));
    for (const waiter of waiters) {
      await expect(waiter).rejects.toMatchObject({ name: 'DbPoolAcquireTimeoutError' });
    }
    await holder;
    await sleep(1_000);
    expect(p.stats.begins).toBe(2);
    const acquireExpiries = db.getDeadlineExpiryTotals().acquire;
    expect(acquireExpiries['on-time'] + acquireExpiries.late).toBe(3);
    await assertNoLeakedRequestBackends(1);
  }, 30_000);

  it('nested escalation at saturation makes progress instead of stalling to a timeout', async () => {
    const db = await loadFreshDb({
      DB_POOL_MAX: '3',
      DB_POOL_ACQUIRE_TIMEOUT_MS: '3000',
      DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS: '1000',
    });
    const suppressedBefore = suppressedTeardownWrites;
    const parent = () => db.withSystemDbAccessContext(async () => {
      await db.db.execute(sql`select pg_sleep(0.2)`);
      return db.runOutsideDbContext(() => db.withSystemDbAccessContext(async () => {
        await db.db.execute(sql`select 1`);
        return 'nested-ok';
      }));
    });
    await expect(Promise.all([parent(), parent(), parent()])).resolves.toEqual(['nested-ok', 'nested-ok', 'nested-ok']);
    await assertNoLeakedRequestBackends(3);
    expect(suppressedTeardownWrites).toBe(suppressedBefore);
  }, 30_000);
});
