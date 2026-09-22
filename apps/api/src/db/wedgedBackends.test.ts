/**
 * #6048 — reclamation of a pool connection wedged in active/ClientRead.
 *
 * The safety argument for this module is the PREDICATE and the two-snapshot
 * confirmation, because the action it takes is `pg_terminate_backend` against a
 * production database. These tests pin that argument directly rather than only
 * exercising the happy path: a reclaimer that terminates one backend too many is
 * worse than the leak it repairs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WEDGED_BACKEND_SELECT_SQL,
  __resetWedgedBackendReclaimForTests,
  confirmStillWedged,
  getLastWedgedBackendReclaimOutcome,
  getWedgedBackendReclaimFailures,
  getWedgedBackendReclaimSkipCount,
  getWedgedBackendReclaimTerminatedTotal,
  reclaimWedgedBackends,
  requestWedgedBackendReclaim,
  type WedgedBackendRow,
} from './wedgedBackends';

function row(overrides: Partial<WedgedBackendRow> = {}): WedgedBackendRow {
  return {
    pid: 3634176,
    backendStart: '2026-09-13 16:05:00.222+00',
    xactStart: '2026-09-13 16:05:00.464+00',
    queryStart: '2026-09-13 16:05:00.464+00',
    ageSeconds: 259_200,
    query: "select set_config('breeze.scope', $1, true)",
    ...overrides,
  };
}

describe('WEDGED_BACKEND_SELECT_SQL', () => {
  // Every clause below is load-bearing for safety. They are asserted as text
  // because the alternative — a live DB — cannot run in the unit job, and
  // silently losing one of them is how this becomes a fleet-wide outage.
  it.each([
    ['scopes to the current database', 'datname = current_database()'],
    ['scopes to the current role', 'usename = current_user'],
    ['excludes background workers', "backend_type = 'client backend'"],
    ['never signals its own backend', 'pid <> pg_backend_pid()'],
    ['matches the pathological state', "state = 'active'"],
    ['matches the pathological wait', "wait_event = 'ClientRead'"],
    ['requires the wait to be on the client', "wait_event_type = 'Client'"],
    ['ages out on the transaction', 'xact_start < now() - make_interval'],
    ['ages out on the STATEMENT too', 'query_start < now() - make_interval'],
    // Narrowed to the breeze RLS prologue GUCs (#6348): a `set_config` of
    // lock_timeout / statement_timeout is not the prologue and never signalled.
    ['can narrow to the prologue only', "query like 'select set_config(''breeze.%'"],
  ])('%s', (_name, clause) => {
    expect(WEDGED_BACKEND_SELECT_SQL).toContain(clause);
  });
});

describe('confirmStillWedged', () => {
  it('confirms a row whose timestamps did not move between snapshots', () => {
    expect(confirmStillWedged([row()], [row()])).toHaveLength(1);
  });

  it('drops a row that made progress (query_start advanced)', () => {
    // The whole point: a backend that started a NEW statement between the two
    // reads is healthy and busy, not wedged.
    const moved = row({ queryStart: '2026-09-16 09:00:00+00' });
    expect(confirmStillWedged([row()], [moved])).toHaveLength(0);
  });

  it('drops a row that vanished from the second snapshot', () => {
    expect(confirmStillWedged([row()], [])).toHaveLength(0);
  });

  it('drops a pid that reconnected between snapshots (backend_start changed)', () => {
    const reused = row({ backendStart: '2026-09-16 09:00:00+00' });
    expect(confirmStillWedged([row()], [reused])).toHaveLength(0);
  });

  it('does not confirm a DIFFERENT pid that happens to share timestamps', () => {
    expect(confirmStillWedged([row({ pid: 1 })], [row({ pid: 2 })])).toHaveLength(0);
  });
});

describe('reclaimWedgedBackends', () => {
  const noSleep = async () => {};

  it('terminates a backend confirmed wedged by both snapshots', async () => {
    const terminate = vi.fn(async (pids: number[]) => pids);
    const outcome = await reclaimWedgedBackends({
      scan: async () => [row()],
      terminate,
      sleep: noSleep,
      minAgeMs: 15_000,
    });

    expect(terminate).toHaveBeenCalledWith([3634176]);
    expect(outcome.terminated).toEqual([3634176]);
    expect(outcome.error).toBeNull();
  });

  it('asks for the prologue-only predicate, never the wide one', async () => {
    const scan = vi.fn(async () => [] as WedgedBackendRow[]);
    await reclaimWedgedBackends({ scan, terminate: async () => [], sleep: noSleep });
    // `prologueOnly` false here would let the reclaimer signal a backend the
    // detector reports but whose shape we have made no safety argument about.
    expect(scan).toHaveBeenCalledWith(expect.any(Number), true);
  });

  it('terminates nothing when the second snapshot shows progress', async () => {
    const terminate = vi.fn(async (pids: number[]) => pids);
    const snapshots = [[row()], [row({ queryStart: '2026-09-16 09:00:00+00' })]];
    const outcome = await reclaimWedgedBackends({
      scan: async () => snapshots.shift() ?? [],
      terminate,
      sleep: noSleep,
    });

    expect(terminate).not.toHaveBeenCalled();
    expect(outcome.scanned).toBe(1);
    expect(outcome.confirmed).toBe(0);
  });

  it('never scans twice or terminates when the first snapshot is empty', async () => {
    const scan = vi.fn(async () => [] as WedgedBackendRow[]);
    const terminate = vi.fn(async () => []);
    const outcome = await reclaimWedgedBackends({ scan, terminate, sleep: noSleep });

    expect(scan).toHaveBeenCalledTimes(1);
    expect(terminate).not.toHaveBeenCalled();
    expect(outcome.terminated).toEqual([]);
  });

  it('caps terminations per pass so a misfire stays bounded', async () => {
    const terminate = vi.fn(async (pids: number[]) => pids);
    const rows = [1, 2, 3, 4, 5, 6].map((pid) => row({ pid }));
    const outcome = await reclaimWedgedBackends({
      scan: async () => rows,
      terminate,
      sleep: noSleep,
      maxPerPass: 2,
    });

    expect(terminate).toHaveBeenCalledWith([1, 2]);
    expect(outcome.confirmed).toBe(6);
    expect(outcome.cappedAt).toBe(2);
  });

  it('reports a scan failure instead of throwing', async () => {
    // Recovery that can itself fault would replace the caller's real error with
    // its own, from a background promise nobody is awaiting.
    const outcome = await reclaimWedgedBackends({
      scan: async () => {
        throw new Error('no connection slots available');
      },
      terminate: async () => [],
      sleep: noSleep,
    });

    expect(outcome.error).toBe('no connection slots available');
    expect(outcome.terminated).toEqual([]);
  });

  it('reports a termination failure instead of throwing', async () => {
    const outcome = await reclaimWedgedBackends({
      scan: async () => [row()],
      terminate: async () => {
        throw new Error('permission denied for function pg_terminate_backend');
      },
      sleep: noSleep,
    });

    expect(outcome.error).toContain('permission denied');
  });
});

describe('requestWedgedBackendReclaim', () => {
  beforeEach(() => {
    __resetWedgedBackendReclaimForTests();
  });
  afterEach(() => {
    __resetWedgedBackendReclaimForTests();
    vi.restoreAllMocks();
  });

  const deps = (over: Record<string, unknown> = {}) => ({
    scan: async () => [row()],
    terminate: async (pids: number[]) => pids,
    sleep: async () => {},
    disabled: false,
    minIntervalMs: 60_000,
    ...over,
  });

  it('runs a pass and records the outcome', async () => {
    const pass = requestWedgedBackendReclaim(deps());
    expect(pass).not.toBeNull();
    await pass;
    expect(getLastWedgedBackendReclaimOutcome()?.terminated).toEqual([3634176]);
  });

  it('declines a second request inside the interval floor', async () => {
    // A wedge expires many concurrent prologues at once; one recovery connection
    // per expiry is a storm against a database already short of connections.
    let clock = 1_000_000;
    const now = () => clock;
    await requestWedgedBackendReclaim(deps({ now }));

    clock += 5_000;
    expect(requestWedgedBackendReclaim(deps({ now }))).toBeNull();
    expect(getWedgedBackendReclaimSkipCount()).toBe(1);

    clock += 60_000;
    expect(requestWedgedBackendReclaim(deps({ now }))).not.toBeNull();
  });

  it('is single-flight: a concurrent request joins the pass in progress', async () => {
    let releaseScan: ((rows: WedgedBackendRow[]) => void) | null = null;
    const scan = vi.fn(
      () =>
        new Promise<WedgedBackendRow[]>((resolve) => {
          releaseScan = resolve;
        }),
    );

    const first = requestWedgedBackendReclaim(deps({ scan }));
    const second = requestWedgedBackendReclaim(deps({ scan }));
    expect(second).toBe(first);

    releaseScan!([]);
    await first;
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('accumulates terminations and failures across passes, monotonically', async () => {
    // Derived on scrape from `lastReclaimOutcome` these would be wrong twice
    // over: a scrape between two passes double-counts the last one, and a burst
    // of passes between two scrapes collapses into whichever ran last.
    let clock = 1_000_000;
    const now = () => clock;

    await requestWedgedBackendReclaim(deps({ now }));
    expect(getWedgedBackendReclaimTerminatedTotal()).toBe(1);
    expect(getWedgedBackendReclaimFailures()).toBe(0);

    clock += 120_000;
    await requestWedgedBackendReclaim(deps({ now, scan: async () => [row({ pid: 99 })] }));
    expect(getWedgedBackendReclaimTerminatedTotal()).toBe(2);

    clock += 120_000;
    await requestWedgedBackendReclaim(
      deps({
        now,
        scan: async () => {
          throw new Error('too many clients already');
        },
      }),
    );
    // A pass that could not run must be COUNTED, not just logged: a reclaimer
    // broken for days otherwise looks identical to one with nothing to do.
    expect(getWedgedBackendReclaimFailures()).toBe(1);
    expect(getWedgedBackendReclaimTerminatedTotal()).toBe(2);
  });

  it('returns null — not an empty outcome — when reclamation is disabled', async () => {
    // A declined pass must never be readable as "nothing was wedged".
    expect(requestWedgedBackendReclaim(deps({ disabled: true }))).toBeNull();
    expect(getLastWedgedBackendReclaimOutcome()).toBeNull();
  });
});
