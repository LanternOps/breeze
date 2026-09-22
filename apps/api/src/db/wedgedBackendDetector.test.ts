/**
 * #6048 ask 2 — the detector.
 *
 * The incident produced ZERO connect timeouts, so the existing #3214 watchdog
 * (which only probes above a CONNECT_TIMEOUT rate threshold) would never have
 * looked. These tests pin that this scan is independent of that threshold, and
 * that a failed scan can never be read as "no wedged backends".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/sentry', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

import { captureMessage } from '../services/sentry';
import {
  __resetDbPoolHealthMonitorForTests,
  getLastWedgedBackendObservation,
  getLastWedgedBackendScanSuccessAt,
  getWedgedBackendScanFailures,
  runWedgedBackendScan,
} from './dbPoolHealthMonitor';
import {
  __resetWedgedBackendReclaimForTests,
  getWedgedBackendReclaimTerminatedTotal,
  requestWedgedBackendReclaim,
  type WedgedBackendRow,
} from './wedgedBackends';

/** The two rows the incident actually produced, one per region. */
const INCIDENT_ROWS: WedgedBackendRow[] = [
  {
    pid: 3634176,
    backendStart: '2026-09-13 16:05:00.222+00',
    xactStart: '2026-09-13 16:05:00.464+00',
    queryStart: '2026-09-13 16:05:00.464+00',
    ageSeconds: 259_200,
    query: "select set_config('breeze.scope', $1, true)",
  },
  {
    pid: 4007387,
    backendStart: '2026-09-13 16:05:00.215+00',
    xactStart: '2026-09-13 16:05:00.439+00',
    queryStart: '2026-09-13 16:05:00.439+00',
    ageSeconds: 259_100,
    query: "select set_config('breeze.scope', $1, true)",
  },
];

describe('runWedgedBackendScan', () => {
  beforeEach(() => {
    // These cases pin the REPORTING contract; scanner-driven reclaim (#6348)
    // has its own suite below and would otherwise open a real side connection.
    vi.stubEnv('DB_WEDGED_BACKEND_SCANNER_RECLAIM_DISABLED', 'true');
    __resetDbPoolHealthMonitorForTests();
    vi.mocked(captureMessage).mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    __resetDbPoolHealthMonitorForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('reports the wedged backends and their oldest age', async () => {
    const observation = await runWedgedBackendScan({
      scan: async () => INCIDENT_ROWS,
      minAgeMs: 300_000,
      now: 1_000,
    });

    expect(observation.count).toBe(2);
    expect(observation.pids).toEqual([3634176, 4007387]);
    expect(observation.oldestAgeSeconds).toBe(259_200);
    expect(observation.error).toBeNull();
    expect(getLastWedgedBackendObservation()).toEqual(observation);
    expect(getLastWedgedBackendScanSuccessAt()).toBe(1_000);
  });

  it('scans the WIDE predicate, not the reclaimer prologue-only one', async () => {
    // A wedge of a different query shape is exactly as interesting, and nobody
    // would be looking for it — reporting must be wider than signalling.
    const scan = vi.fn(async () => [] as WedgedBackendRow[]);
    await runWedgedBackendScan({ scan, minAgeMs: 300_000 });
    expect(scan).toHaveBeenCalledWith(300_000, false);
  });

  it('captures to Sentry with the #6048 event code when backends are wedged', async () => {
    await runWedgedBackendScan({
      scan: async () => INCIDENT_ROWS,
      minAgeMs: 300_000,
      now: 1_000,
      throttleMs: 0,
    });

    expect(captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('#6048'),
      expect.objectContaining({ eventCode: 'db_wedged_client_read_backends' }),
    );
  });

  it('stays silent — no warning, no capture — when nothing is wedged', async () => {
    const observation = await runWedgedBackendScan({
      scan: async () => [],
      minAgeMs: 300_000,
      now: 1_000,
    });

    expect(observation.count).toBe(0);
    expect(observation.oldestAgeSeconds).toBeNull();
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('throttles the capture across repeated scans of a persistent condition', async () => {
    // A wedged backend stays wedged until someone acts, so every scan would
    // report it. This repo has twice blacked out Sentry with an unthrottled
    // recurring warning.
    for (const at of [1_000, 2_000, 3_000]) {
      await runWedgedBackendScan({
        scan: async () => INCIDENT_ROWS,
        minAgeMs: 300_000,
        now: at,
        throttleMs: 900_000,
      });
    }
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it('publishes a FAILED scan as "not observed" (count null), never as zero', async () => {
    // A stale 0 republished on every scrape is an affirmative wrong answer about
    // a detector that has been blind the whole time.
    await runWedgedBackendScan({ scan: async () => [], minAgeMs: 300_000, now: 1_000 });
    expect(getLastWedgedBackendObservation()?.count).toBe(0);

    const failed = await runWedgedBackendScan({
      scan: async () => {
        throw new Error('too many clients already');
      },
      minAgeMs: 300_000,
      now: 2_000,
    });

    expect(failed.count).toBeNull();
    expect(failed.error).toBe('too many clients already');
    expect(getLastWedgedBackendObservation()?.count).toBeNull();
    expect(getWedgedBackendScanFailures()).toBe(1);
    // The last SUCCESS timestamp must not advance on a failure, or staleness
    // becomes invisible.
    expect(getLastWedgedBackendScanSuccessAt()).toBe(1_000);
  });

  it('never throws — a watchdog that can crash its tick is worse than none', async () => {
    await expect(
      runWedgedBackendScan({
        scan: async () => {
          throw new Error('boom');
        },
      }),
    ).resolves.toMatchObject({ count: null });
  });
});

/**
 * #6348 — the 5-minute scanner reclaims, it does not only report.
 *
 * Four occurrences across both regions: the detector saw the wedge within
 * 6–8 minutes, but `breeze_db_wedged_backend_reclaim_terminated_total` stayed
 * 0 every time, because termination was only ever requested by a prologue
 * deadline — and a wedge nobody is awaiting never expires one. The scanner's
 * own confirmed observation must be enough.
 */
describe('runWedgedBackendScan — scanner-driven reclaim (#6348)', () => {
  const PROLOGUE = "select set_config('breeze.scope', $1, true)";

  /**
   * A fake pg_stat_activity that applies the same filters the real
   * WEDGED_BACKEND_SELECT_SQL does: age on both clocks, and — for the
   * reclaimer's `prologueOnly` read — the breeze prologue query shape.
   */
  function fakeActivity(rows: WedgedBackendRow[]) {
    const calls: Array<[number, boolean]> = [];
    const scan = vi.fn(async (minAgeMs: number, prologueOnly: boolean) => {
      calls.push([minAgeMs, prologueOnly]);
      return rows.filter(
        (row) =>
          row.ageSeconds * 1000 >= minAgeMs
          && (!prologueOnly || row.query.startsWith("select set_config('breeze.")),
      );
    });
    return { scan, calls };
  }

  const wedged = (pid: number, overrides: Partial<WedgedBackendRow> = {}): WedgedBackendRow => ({
    pid,
    backendStart: '2026-09-22 16:05:00.200+00',
    xactStart: '2026-09-22 16:05:00.210+00',
    queryStart: '2026-09-22 16:05:00.210+00',
    ageSeconds: 400,
    query: PROLOGUE,
    ...overrides,
  });

  beforeEach(() => {
    __resetDbPoolHealthMonitorForTests();
    __resetWedgedBackendReclaimForTests();
    vi.unstubAllEnvs();
    vi.mocked(captureMessage).mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    __resetDbPoolHealthMonitorForTests();
    __resetWedgedBackendReclaimForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('terminates a confirmed prologue wedge older than 5 minutes and counts it', async () => {
    const { scan, calls } = fakeActivity([wedged(4242)]);
    const terminate = vi.fn(async (pids: number[]) => pids);

    const observation = await runWedgedBackendScan({
      scan,
      minAgeMs: 300_000,
      now: 1_000,
      throttleMs: 0,
      reclaim: { terminate, confirmDelayMs: 0 },
    });

    expect(observation.count).toBe(1);
    expect(terminate).toHaveBeenCalledWith([4242]);
    expect(observation.reclaim?.terminated).toEqual([4242]);
    expect(getWedgedBackendReclaimTerminatedTotal()).toBe(1);
    // Wide detector read, then the reclaimer's two narrow confirming snapshots.
    expect(calls).toEqual([
      [300_000, false],
      [300_000, true],
      [300_000, true],
    ]);
  });

  it('never terminates a wedged backend whose query is not the breeze set_config prologue', async () => {
    const { scan } = fakeActivity([
      wedged(1, { query: 'select * from devices where id = $1' }),
      wedged(2, { query: "select set_config('lock_timeout', $1, true)" }),
    ]);
    const terminate = vi.fn(async (pids: number[]) => pids);

    const observation = await runWedgedBackendScan({
      scan,
      minAgeMs: 300_000,
      now: 1_000,
      throttleMs: 0,
      reclaim: { terminate, confirmDelayMs: 0 },
    });

    // Reported (the detector sees the whole class) ...
    expect(observation.count).toBe(2);
    // ... but never signalled.
    expect(terminate).not.toHaveBeenCalled();
    expect(getWedgedBackendReclaimTerminatedTotal()).toBe(0);
  });

  it('never terminates a prologue backend younger than 5 minutes, even if the detector threshold is lower', async () => {
    // Ops tuned the detector down to 60 s; a 2-minute-old prologue is reported
    // but must not be signalled — 5 minutes is the floor for scanner reclaim.
    const { scan, calls } = fakeActivity([wedged(7, { ageSeconds: 120 })]);
    const terminate = vi.fn(async (pids: number[]) => pids);

    const observation = await runWedgedBackendScan({
      scan,
      minAgeMs: 60_000,
      now: 1_000,
      throttleMs: 0,
      reclaim: { terminate, confirmDelayMs: 0 },
    });

    expect(observation.count).toBe(1);
    expect(terminate).not.toHaveBeenCalled();
    const narrowReads = calls.filter(([, prologueOnly]) => prologueOnly);
    expect(narrowReads.length).toBeGreaterThan(0);
    expect(narrowReads.every(([age]) => age >= 300_000)).toBe(true);
  });

  it('does not terminate a backend that moved between the two confirming snapshots', async () => {
    let reads = 0;
    const scan = vi.fn(async () => {
      reads += 1;
      // Third read = second confirming snapshot: query_start advanced.
      return [reads === 3 ? wedged(9, { queryStart: '2026-09-22 16:11:00.000+00' }) : wedged(9)];
    });
    const terminate = vi.fn(async (pids: number[]) => pids);

    const observation = await runWedgedBackendScan({
      scan,
      minAgeMs: 300_000,
      now: 1_000,
      throttleMs: 0,
      reclaim: { terminate, confirmDelayMs: 0 },
    });

    expect(terminate).not.toHaveBeenCalled();
    expect(observation.reclaim?.confirmed).toBe(0);
  });

  it('keeps the per-pass cap', async () => {
    const { scan } = fakeActivity([1, 2, 3, 4, 5, 6].map((pid) => wedged(pid)));
    const terminate = vi.fn(async (pids: number[]) => pids);

    const observation = await runWedgedBackendScan({
      scan,
      minAgeMs: 300_000,
      now: 1_000,
      throttleMs: 0,
      reclaim: { terminate, confirmDelayMs: 0, maxPerPass: 4 },
    });

    expect(terminate).toHaveBeenCalledWith([1, 2, 3, 4]);
    expect(observation.reclaim?.cappedAt).toBe(4);
  });

  it('keeps the reclaim rate limit across scanner ticks', async () => {
    const { scan } = fakeActivity([wedged(11)]);
    const terminate = vi.fn(async (pids: number[]) => pids);
    let clock = 1_000_000;
    const reclaim = { terminate, confirmDelayMs: 0, minIntervalMs: 60_000, now: () => clock };

    await runWedgedBackendScan({ scan, minAgeMs: 300_000, now: clock, throttleMs: 0, reclaim });
    clock += 10_000;
    const second = await runWedgedBackendScan({ scan, minAgeMs: 300_000, now: clock, throttleMs: 0, reclaim });

    expect(terminate).toHaveBeenCalledTimes(1);
    expect(second.reclaimStatus).toBe('declined');
  });

  it('does not reclaim when DB_WEDGED_BACKEND_SCANNER_RECLAIM_DISABLED is set', async () => {
    vi.stubEnv('DB_WEDGED_BACKEND_SCANNER_RECLAIM_DISABLED', 'true');
    const { scan, calls } = fakeActivity([wedged(12)]);
    const terminate = vi.fn(async (pids: number[]) => pids);

    const observation = await runWedgedBackendScan({
      scan,
      minAgeMs: 300_000,
      now: 1_000,
      throttleMs: 0,
      reclaim: { terminate, confirmDelayMs: 0 },
    });

    expect(observation.count).toBe(1);
    expect(observation.reclaimStatus).toBe('disabled');
    expect(terminate).not.toHaveBeenCalled();
    expect(calls).toEqual([[300_000, false]]);
  });

  it('honours the global DB_WEDGED_BACKEND_RECLAIM_DISABLED kill-switch too', async () => {
    vi.stubEnv('DB_WEDGED_BACKEND_RECLAIM_DISABLED', 'true');
    const { scan } = fakeActivity([wedged(13)]);
    const terminate = vi.fn(async (pids: number[]) => pids);

    const observation = await runWedgedBackendScan({
      scan,
      minAgeMs: 300_000,
      now: 1_000,
      throttleMs: 0,
      reclaim: { terminate, confirmDelayMs: 0 },
    });

    expect(terminate).not.toHaveBeenCalled();
    expect(observation.reclaimStatus).toBe('disabled');
  });

  it('opens no reclaim connection when nothing wedged matches the prologue shape', async () => {
    const { scan, calls } = fakeActivity([wedged(14, { query: 'select 1' })]);
    const terminate = vi.fn(async (pids: number[]) => pids);

    const observation = await runWedgedBackendScan({
      scan,
      minAgeMs: 300_000,
      now: 1_000,
      throttleMs: 0,
      reclaim: { terminate, confirmDelayMs: 0 },
    });

    expect(calls).toEqual([[300_000, false]]);
    expect(observation.reclaimStatus).toBe('not-needed');
  });

  it('joins a prologue-deadline pass already in flight instead of starting a second one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const terminate = vi.fn(async (pids: number[]) => {
      await gate;
      return pids;
    });
    const { scan } = fakeActivity([wedged(21)]);
    // The deadline path's pass, started first and still running.
    const deadlinePass = requestWedgedBackendReclaim({ scan, terminate, confirmDelayMs: 0, minAgeMs: 15_000 });
    expect(deadlinePass).not.toBeNull();

    const scanPromise = runWedgedBackendScan({
      scan,
      minAgeMs: 300_000,
      now: 1_000,
      throttleMs: 0,
      reclaim: { terminate, confirmDelayMs: 0 },
    });
    release();
    const [observation, deadlineOutcome] = await Promise.all([scanPromise, deadlinePass]);

    expect(terminate).toHaveBeenCalledTimes(1);
    expect(observation.reclaimStatus).toBe('ran');
    expect(observation.reclaim).toBe(deadlineOutcome);
    expect(getWedgedBackendReclaimTerminatedTotal()).toBe(1);
  });

  it('a failing reclaim pass never breaks the scan', async () => {
    const { scan } = fakeActivity([wedged(15)]);
    const terminate = vi.fn(async (): Promise<number[]> => {
      throw new Error('too many clients already');
    });

    const observation = await runWedgedBackendScan({
      scan,
      minAgeMs: 300_000,
      now: 1_000,
      throttleMs: 0,
      reclaim: { terminate, confirmDelayMs: 0 },
    });

    expect(observation.count).toBe(1);
    expect(observation.reclaim?.error).toBe('too many clients already');
    expect(observation.reclaimStatus).toBe('ran');
  });
});
