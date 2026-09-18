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
import type { WedgedBackendRow } from './wedgedBackends';

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
    __resetDbPoolHealthMonitorForTests();
    vi.mocked(captureMessage).mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    __resetDbPoolHealthMonitorForTests();
    vi.restoreAllMocks();
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
