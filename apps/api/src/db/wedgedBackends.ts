/**
 * Detection and reclamation for the #6048 failure: a pooled connection wedged
 * mid-way through the RLS GUC prologue, unreapable by any timeout on either
 * side.
 *
 * THE FAILURE. On both prod regions (2026-09-13 16:05Z) one `breeze_app`
 * backend sat for three days in `state = 'active'`,
 * `wait_event = 'Client/ClientRead'`, with
 * `query = select set_config('breeze.scope', $1, true)` — the FIRST statement of
 * `applyAccessContextGucs` — and `backend_start == xact_start`. Nothing reaps
 * that state:
 *
 *   - `idle_in_transaction_session_timeout` does not apply: the backend is
 *     `active`, not `idle in transaction`.
 *   - `statement_timeout` does not help: the server is not waiting on work of
 *     its own, it is waiting on the CLIENT for the next protocol message, so no
 *     server-side timer is what would end this.
 *   - TCP keepalive / `client_connection_check_interval` do not fire: the
 *     client socket is still open, the client just never writes again.
 *   - postgres.js `idle_timeout` and `max_lifetime` only recycle connections
 *     that RETURN to the idle pool. One stuck awaiting a query result never
 *     does, so its slot is lost for the life of the process.
 *
 * WHY A SIDE CONNECTION AND NOT A LOCAL SOCKET DESTROY. postgres.js 3.4.9 keeps
 * its `connections` array, and every per-connection `terminate()`, in closure
 * scope. The object it returns exposes only `parameters, largeObject, subscribe,
 * CLOSE, END, PostgresError, options, reserve, listen, begin, close, end` —
 * `sql.reserve()` yields a reserved handle with `release()` and no destroy, and
 * the only teardown reachable from application code is `sql.end()`, which is
 * WHOLE-POOL. Drizzle adds nothing: `drizzle-orm/postgres-js` delegates
 * `transaction()` straight to `sql.begin()`. So the one lever available without
 * forking the driver is the one the operator pulled by hand during the
 * incident: connect separately and `pg_terminate_backend` the wedged pid.
 *
 * That works because postgres.js `begin()` races the transaction body against
 * `new Promise((_, reject) => connection.onclose = reject)`. Terminating the
 * backend closes the socket, `onclose` fires, the abandoned transaction promise
 * finally rejects, and the pool slot is reconnected and returned to service.
 *
 * WHAT MAKES THE SWEEP SAFE. We cannot learn the wedged pid directly (the
 * driver hands out no connection identity, and the wedge lands on the very first
 * statement, so a "select pg_backend_pid() first" probe is just as wedgeable).
 * The predicate therefore has to stand on its own, and it is deliberately
 * narrow — every clause is load-bearing:
 *
 *   - `usename = current_user` + `datname = current_database()`: never signal
 *     another role's or another database's backend. Same-role
 *     `pg_terminate_backend` also needs no extra privilege, so this is both the
 *     safety bound and the permission bound.
 *   - `backend_type = 'client backend'`: never a walsender, autovacuum worker or
 *     background worker.
 *   - `pid <> pg_backend_pid()`: never the reclaimer's own connection.
 *   - `state = 'active' AND wait_event_type = 'Client' AND wait_event =
 *     'ClientRead'`: the exact pathological pair.
 *   - BOTH `xact_start` and `query_start` older than the threshold. `xact_start`
 *     alone is not enough: a legitimately long transaction can have started a
 *     perfectly healthy statement a millisecond ago.
 *   - `query` matching the prologue's own shape. `active`/`ClientRead` is a
 *     legitimate state for other extended-protocol exchanges (and for
 *     `COPY ... FROM STDIN`, which this codebase does not use), so the
 *     reclaimer refuses to touch anything that is not literally one of the
 *     RLS prologue's `select set_config('breeze.…', $1, true)` statements
 *     (narrowed from any `set_config` in #6348 — app code also issues
 *     `set_config('lock_timeout' | 'statement_timeout', …)` mid-transaction,
 *     and those are not the prologue). The DETECTOR does not apply this clause —
 *     it reports the whole class, because a wedge elsewhere is exactly as
 *     interesting.
 *   - TWO snapshots. `pg_stat_activity` is a sampled view whose columns can
 *     briefly disagree, and observation is not atomic with signalling. A pid is
 *     only signalled when a second snapshot still shows it with an IDENTICAL
 *     `(backend_start, xact_start, query_start)` triple — i.e. it demonstrably
 *     has not moved. A backend that made any progress between the two reads is
 *     dropped from the pass.
 *
 * Terminations are additionally capped per pass, so a misfire is bounded rather
 * than fleet-wide, and the reclaimer is single-flight with a floor between
 * attempts so a burst of expiring prologues cannot open a storm of recovery
 * connections against a database that may already be out of connection budget.
 */

import postgres from 'postgres';
import { resolveRequestDatabaseConfig } from './requestDatabaseConfig';

/**
 * `application_name` for the short-lived client the reclaimer opens. Anyone
 * reading `pg_stat_activity` during this exact failure must be able to tell the
 * recovery connection apart from request traffic instantly.
 */
export const WEDGED_BACKEND_RECLAIM_APPLICATION_NAME = 'breeze-wedged-backend-reclaim';

/** `application_name` for the detector's read-only scan client. */
export const WEDGED_BACKEND_SCAN_APPLICATION_NAME = 'breeze-wedged-backend-scan';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function envFlag(name: string): boolean {
  return TRUTHY.has((process.env[name] ?? '').trim().toLowerCase());
}

function envInt(name: string, fallback: number, min: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(raw) || raw < min) return fallback;
  return raw;
}

/** Reclamation kill-switch, for an operator who wants detection only. */
export function isWedgedBackendReclaimDisabled(): boolean {
  return envFlag('DB_WEDGED_BACKEND_RECLAIM_DISABLED');
}

/**
 * Floor between reclamation passes. A wedge tends to expire many concurrent
 * prologues at once (they are all queued behind the same exhausted pool), and
 * every pass costs a fresh connection to a database that in this failure mode
 * is the scarce resource.
 */
export function getWedgedBackendReclaimMinIntervalMs(): number {
  return envInt('DB_WEDGED_BACKEND_RECLAIM_MIN_INTERVAL_MS', 60_000, 1_000);
}

/** Hard cap on terminations in one pass, so a misfire stays bounded. */
export function getWedgedBackendReclaimMaxPerPass(): number {
  return envInt('DB_WEDGED_BACKEND_RECLAIM_MAX_PER_PASS', 4, 1);
}

/** Wall-clock bound on a whole reclamation pass, connect included. */
export function getWedgedBackendReclaimTimeoutMs(): number {
  return envInt('DB_WEDGED_BACKEND_RECLAIM_TIMEOUT_MS', 5_000, 1_000);
}

/** Gap between the two confirming snapshots. */
export function getWedgedBackendConfirmDelayMs(): number {
  return envInt('DB_WEDGED_BACKEND_CONFIRM_DELAY_MS', 250, 0);
}

/**
 * Detector threshold (issue #6048 ask 2). Five minutes: far longer than any
 * healthy prologue, far shorter than the three days the incident ran.
 */
export function getWedgedBackendMinAgeMs(): number {
  return envInt('DB_WEDGED_BACKEND_MIN_AGE_MS', 5 * 60_000, 30_000);
}

/** How often the detector scans. Independent of the connect-timeout watchdog. */
export function getWedgedBackendScanIntervalMs(): number {
  return envInt('DB_WEDGED_BACKEND_SCAN_INTERVAL_MS', 5 * 60_000, 30_000);
}

/** Detector kill-switch. */
export function isWedgedBackendScanDisabled(): boolean {
  return envFlag('DB_WEDGED_BACKEND_SCAN_DISABLED');
}

/**
 * Kill-switch for scanner-driven reclaim (#6348) only: the 5-minute detector
 * keeps reporting, and the prologue-deadline reclaim keeps working. Default is
 * reclaim ON. `DB_WEDGED_BACKEND_RECLAIM_DISABLED` still disables BOTH paths.
 */
export function isWedgedBackendScannerReclaimDisabled(): boolean {
  return envFlag('DB_WEDGED_BACKEND_SCANNER_RECLAIM_DISABLED');
}

/**
 * Hard floor on the age at which the SCANNER may signal a backend (#6348).
 * Deliberately a constant, not derived from `DB_WEDGED_BACKEND_MIN_AGE_MS`: an
 * operator who tunes the detector down to see wedges sooner must not thereby
 * shorten the clock on `pg_terminate_backend`. A breeze prologue `set_config`
 * sitting in `active`/`ClientRead` for five minutes is never legitimate.
 */
export const WEDGED_BACKEND_SCANNER_RECLAIM_MIN_AGE_MS = 5 * 60_000;

/**
 * Leading text of every RLS prologue statement (`applyAccessContextGucs`).
 * Mirrors the `query like` clause of {@link WEDGED_BACKEND_SELECT_SQL}; used
 * client-side only to decide whether a reclaim pass is worth a connection —
 * the server-side predicate remains the authority on what gets signalled.
 */
export const WEDGED_BACKEND_PROLOGUE_QUERY_PREFIX = "select set_config('breeze.";

/**
 * One `pg_stat_activity` row in the pathological state. Field names match the
 * aliases in {@link WEDGED_BACKEND_SELECT_SQL} so a row can be handed straight
 * through from the driver.
 */
export interface WedgedBackendRow {
  pid: number;
  /** ISO timestamps, compared only for EQUALITY across the two snapshots. */
  backendStart: string;
  xactStart: string;
  queryStart: string;
  ageSeconds: number;
  query: string;
}

/**
 * The shared predicate. `$1` is the minimum age in seconds; `$2` selects the
 * reclaimer's extra `set_config` clause (true) or the detector's wider view
 * (false).
 *
 * Kept as ONE string used by both callers on purpose: a detector that can see a
 * backend the reclaimer would refuse to touch is a useful asymmetry, but a
 * reclaimer that could touch something the detector never reports would be a
 * silent one.
 */
export const WEDGED_BACKEND_SELECT_SQL = `
  select pid,
         backend_start::text as "backendStart",
         xact_start::text    as "xactStart",
         query_start::text   as "queryStart",
         extract(epoch from (now() - xact_start))::float8 as "ageSeconds",
         query
    from pg_stat_activity
   where datname = current_database()
     and usename = current_user
     and backend_type = 'client backend'
     and pid <> pg_backend_pid()
     and state = 'active'
     and wait_event_type = 'Client'
     and wait_event = 'ClientRead'
     and xact_start is not null
     and query_start is not null
     and xact_start < now() - make_interval(secs => $1::float8)
     and query_start < now() - make_interval(secs => $1::float8)
     and (not $2::boolean or query like 'select set_config(''breeze.%')
   order by xact_start
`;

/** Runs the scan query. Injected in tests; defaults to a fresh side client. */
export type WedgedBackendScanner = (
  minAgeMs: number,
  prologueOnly: boolean,
) => Promise<WedgedBackendRow[]>;

/** Issues `pg_terminate_backend` for the given pids. Returns the pids signalled. */
export type WedgedBackendTerminator = (pids: number[]) => Promise<number[]>;

/**
 * A row's identity for the two-snapshot confirmation. Any movement in
 * `query_start` means the backend progressed and must not be signalled.
 */
function identityOf(row: WedgedBackendRow): string {
  return `${row.pid}|${row.backendStart}|${row.xactStart}|${row.queryStart}`;
}

/**
 * Rows present in BOTH snapshots with an identical identity, in first-snapshot
 * order. Exported for its own unit test: this is the whole safety argument for
 * signalling, so it is tested directly rather than only through the pass.
 */
export function confirmStillWedged(
  first: readonly WedgedBackendRow[],
  second: readonly WedgedBackendRow[],
): WedgedBackendRow[] {
  const secondIdentities = new Set(second.map(identityOf));
  return first.filter((row) => secondIdentities.has(identityOf(row)));
}

export interface WedgedBackendReclaimOutcome {
  /** Rows seen in the FIRST snapshot. */
  scanned: number;
  /** Rows still unmoved in the second snapshot. */
  confirmed: number;
  /** Pids actually signalled, after the per-pass cap. */
  terminated: number[];
  /** True when the cap dropped confirmed candidates from this pass. */
  cappedAt: number | null;
  /** Failure message, or null. Never thrown: recovery must not become a fault. */
  error: string | null;
  /** Wall time of the pass. */
  elapsedMs: number;
}

export interface ReclaimWedgedBackendsDeps {
  scan?: WedgedBackendScanner;
  terminate?: WedgedBackendTerminator;
  minAgeMs?: number;
  maxPerPass?: number;
  confirmDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/**
 * One reclamation pass. NEVER throws — it is recovery for a fault, and recovery
 * that can itself fault would replace the caller's real error with its own.
 */
export async function reclaimWedgedBackends(
  deps: ReclaimWedgedBackendsDeps = {},
): Promise<WedgedBackendReclaimOutcome> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const minAgeMs = deps.minAgeMs ?? getWedgedBackendMinAgeMs();
  const maxPerPass = deps.maxPerPass ?? getWedgedBackendReclaimMaxPerPass();
  const confirmDelayMs = deps.confirmDelayMs ?? getWedgedBackendConfirmDelayMs();
  const sleep = deps.sleep ?? defaultSleep;
  const scan = deps.scan ?? scanWedgedBackends;
  const terminate = deps.terminate ?? terminateBackends;

  const empty = (error: string | null, scanned = 0, confirmed = 0): WedgedBackendReclaimOutcome => ({
    scanned,
    confirmed,
    terminated: [],
    cappedAt: null,
    error,
    elapsedMs: now() - startedAt,
  });

  try {
    const first = await scan(minAgeMs, true);
    if (first.length === 0) return empty(null);

    if (confirmDelayMs > 0) await sleep(confirmDelayMs);
    const second = await scan(minAgeMs, true);
    const confirmed = confirmStillWedged(first, second);
    if (confirmed.length === 0) return empty(null, first.length, 0);

    const selected = confirmed.slice(0, maxPerPass);
    const terminated = await terminate(selected.map((row) => row.pid));

    return {
      scanned: first.length,
      confirmed: confirmed.length,
      terminated,
      cappedAt: confirmed.length > maxPerPass ? maxPerPass : null,
      error: null,
      elapsedMs: now() - startedAt,
    };
  } catch (err) {
    return empty(err instanceof Error ? err.message : String(err));
  }
}

let reclaimInFlight: Promise<WedgedBackendReclaimOutcome> | null = null;
let lastReclaimAt = 0;
let lastReclaimOutcome: WedgedBackendReclaimOutcome | null = null;
let reclaimSkipped = 0;
let reclaimTerminatedTotal = 0;
let reclaimFailures = 0;

export interface RequestWedgedBackendReclaimDeps extends ReclaimWedgedBackendsDeps {
  minIntervalMs?: number;
  disabled?: boolean;
}

/**
 * Single-flight, rate-limited entry point. Returns null when the request was
 * declined (disabled, or inside the interval floor) so the caller can say so
 * rather than imply a pass ran.
 *
 * Named `request…` because it may legitimately do nothing: a caller that reads
 * a null as "no wedged backends" would turn a declined pass into a clean bill
 * of health, which is the one reading this module must never support.
 */
export function requestWedgedBackendReclaim(
  deps: RequestWedgedBackendReclaimDeps = {},
): Promise<WedgedBackendReclaimOutcome> | null {
  const disabled = deps.disabled ?? isWedgedBackendReclaimDisabled();
  if (disabled) return null;
  if (reclaimInFlight) {
    reclaimSkipped += 1;
    return reclaimInFlight;
  }

  const now = deps.now ?? Date.now;
  const minIntervalMs = deps.minIntervalMs ?? getWedgedBackendReclaimMinIntervalMs();
  const at = now();
  if (lastReclaimAt !== 0 && at - lastReclaimAt < minIntervalMs) {
    reclaimSkipped += 1;
    return null;
  }
  lastReclaimAt = at;

  const pass = reclaimWedgedBackends(deps)
    .then((outcome) => {
      lastReclaimOutcome = outcome;
      // Monotonic totals, kept here rather than derived from `lastReclaimOutcome`
      // on scrape: a scrape landing between two passes would otherwise
      // double-count the last one, and a burst of passes between two scrapes
      // would be collapsed into whichever happened to be last.
      reclaimTerminatedTotal += outcome.terminated.length;
      if (outcome.error !== null) reclaimFailures += 1;
      return outcome;
    })
    .finally(() => {
      reclaimInFlight = null;
    });
  reclaimInFlight = pass;
  return pass;
}

/** Latest reclamation outcome, or null when none has completed. */
export function getLastWedgedBackendReclaimOutcome(): WedgedBackendReclaimOutcome | null {
  return lastReclaimOutcome;
}

/** Reclaim requests declined by the single-flight guard or the interval floor. */
export function getWedgedBackendReclaimSkipCount(): number {
  return reclaimSkipped;
}

/** Backends this process has signalled, since start. Monotonic. */
export function getWedgedBackendReclaimTerminatedTotal(): number {
  return reclaimTerminatedTotal;
}

/**
 * Reclamation passes that failed, since start. Monotonic.
 *
 * This is the series to alert on alongside the detector's count: a wedged count
 * that will not come down while THIS climbs means the repair path itself is
 * broken — which is the same three-day-invisible failure #6048 was filed for,
 * one layer up.
 */
export function getWedgedBackendReclaimFailures(): number {
  return reclaimFailures;
}

export function __resetWedgedBackendReclaimForTests(): void {
  sideClientCloseFailures = 0;
  reclaimInFlight = null;
  lastReclaimAt = 0;
  lastReclaimOutcome = null;
  reclaimSkipped = 0;
  reclaimTerminatedTotal = 0;
  reclaimFailures = 0;
}

/**
 * Opens a single-use client, runs `fn`, and closes it.
 *
 * MUST NOT use the request pool. In this failure the request pool is the thing
 * under investigation — and in the worst case it has no slot left to lend.
 */
async function withSideClient<T>(
  applicationName: string,
  timeoutMs: number,
  fn: (sql: ReturnType<typeof postgres>) => Promise<T>,
): Promise<T> {
  const { url } = resolveRequestDatabaseConfig();
  const sql = postgres(url, {
    max: 1,
    // postgres.js takes seconds; ceil so a sub-second budget still permits one
    // real attempt rather than being floored to an instant timeout.
    connect_timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
    idle_timeout: 1,
    max_lifetime: 30,
    connection: { application_name: applicationName },
  });
  try {
    return await fn(sql);
  } finally {
    // `timeout: 0` destroys rather than draining: this client exists to repair a
    // connection fault and must never block on one. Close failures are logged,
    // not swallowed — each one is a possibly leaked socket against a database
    // already under connection pressure.
    await Promise.resolve()
      .then(() => sql.end({ timeout: 0 }))
      .catch((endErr: unknown) => {
        // Counted, not just logged. A repeatedly failing close leaks one socket
        // per pass against a database that — in the failure this module exists
        // for — is already short of connections, so the recovery path would be
        // quietly making things worse. Mirrors `probeCloseFailures` in
        // dbPoolHealthMonitor, which exists for exactly this reason.
        sideClientCloseFailures += 1;
        console.warn(
          `[db-wedged-backend] side client (${applicationName}) end() failed `
            + `(${sideClientCloseFailures} total); the connection may be leaked:`,
          endErr,
        );
      });
  }
}

let sideClientCloseFailures = 0;

/** Side-connection closes that failed — each one a possible leaked socket. */
export function getWedgedBackendSideClientCloseFailures(): number {
  return sideClientCloseFailures;
}

/** Default scanner: one fresh side connection, one read. */
export async function scanWedgedBackends(
  minAgeMs: number = getWedgedBackendMinAgeMs(),
  prologueOnly = false,
): Promise<WedgedBackendRow[]> {
  return withSideClient(
    prologueOnly ? WEDGED_BACKEND_RECLAIM_APPLICATION_NAME : WEDGED_BACKEND_SCAN_APPLICATION_NAME,
    getWedgedBackendReclaimTimeoutMs(),
    async (sql) => {
      const rows = await sql.unsafe(WEDGED_BACKEND_SELECT_SQL, [minAgeMs / 1000, prologueOnly]);
      return rows as unknown as WedgedBackendRow[];
    },
  );
}

/**
 * Default terminator. Returns the pids for which `pg_terminate_backend`
 * reported the signal was sent.
 *
 * A `true` here means the SIGNAL was delivered, not that the backend is gone or
 * that our process has observed the socket close — so callers must treat this
 * as "requested", never as "reclaimed".
 */
export async function terminateBackends(pids: number[]): Promise<number[]> {
  if (pids.length === 0) return [];
  return withSideClient(
    WEDGED_BACKEND_RECLAIM_APPLICATION_NAME,
    getWedgedBackendReclaimTimeoutMs(),
    async (sql) => {
      const rows = await sql.unsafe(
        'select pid, pg_terminate_backend(pid) as signalled from unnest($1::int[]) as pid',
        [pids],
      );
      return (rows as unknown as { pid: number; signalled: boolean }[])
        .filter((row) => row.signalled)
        .map((row) => row.pid);
    },
  );
}
