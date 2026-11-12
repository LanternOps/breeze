import { describe, expect, it } from 'vitest';
import {
  DESTINATION_LOOKBACK_MS,
  classifyDestinationOutcome,
  currentDestinationIdentity,
  evaluateBackupDestination,
  type DestinationJobOutcome,
} from './backupDestinationHealth';

const NOW = new Date('2026-11-11T12:00:00.000Z');
const ID = 's3::s3.example.test::bucket-a';
const OTHER_ID = 's3::s3.example.test::bucket-old';
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const DENIED = 'storage session: storage answered status 403 (AccessDenied)';
const NOT_FOUND = 'file upload failed: storage session: storage answered status 404';
const STORE_5XX = 'storage session: storage answered status 503';
const CLOCK = 'storage session: storage answered status 403 (RequestTimeTooSkewed)';
// Storage category, but nothing ties it to the customer's bucket: a Breeze API refusal.
const BREEZE_REFUSAL = 'storage session: create refused with status 403';
const OFFLINE = '[stale-backup-reaper] Device went offline during backup';

let seq = 0;
function job(deviceId: string, h: number, status: string, errorLog: string | null = null, extra: Partial<DestinationJobOutcome> = {}): DestinationJobOutcome {
  seq += 1;
  // Each call is its own run unless the caller passes the same createdAt (the fan-out shape).
  const createdAt = extra.createdAt ?? new Date(hoursAgo(h).getTime() - 60_000 - seq);
  return { deviceId, status, errorLog, createdAt, completedAt: hoursAgo(h), storageIdentity: ID, ...extra };
}
const evaluate = (jobs: DestinationJobOutcome[], identity: string | null = ID) =>
  evaluateBackupDestination({ currentStorageIdentity: identity, jobs, now: NOW });

describe('classifyDestinationOutcome', () => {
  it('completed is good; a destination-attributable storage failure is bad with its cause', () => {
    expect(classifyDestinationOutcome({ status: 'completed', errorLog: null })).toEqual({ outcome: 'good', cause: null });
    expect(classifyDestinationOutcome({ status: 'failed', errorLog: DENIED })).toEqual({ outcome: 'bad', cause: 'storage_access_denied' });
    expect(classifyDestinationOutcome({ status: 'partial', errorLog: STORE_5XX })).toEqual({ outcome: 'bad', cause: 'storage_operation_failed' });
    expect(classifyDestinationOutcome({ status: 'completed_with_errors', errorLog: NOT_FOUND })).toEqual({ outcome: 'bad', cause: 'storage_not_found' });
    expect(classifyDestinationOutcome({ status: 'failed', errorLog: CLOCK })).toEqual({ outcome: 'bad', cause: 'storage_clock_skew' });
  });

  it('offline, cancelled, in-flight, non-storage and unattributable storage failures are unknown', () => {
    for (const [status, errorLog] of [
      ['failed', OFFLINE],
      ['cancelled', null],
      ['running', null],
      ['pending', null],
      ['failed', 'VSS shadow copy failed'],
      ['completed_with_errors', 'failed to open source file C:\\x: Access is denied'],
      ['failed', BREEZE_REFUSAL],
      ['failed', null],
    ] as const) {
      expect(classifyDestinationOutcome({ status, errorLog }).outcome, `${status}: ${errorLog}`).toBe('unknown');
    }
  });
});

describe('currentDestinationIdentity', () => {
  it('reads only the identity fields, so it matches the dispatch stamp', () => {
    expect(currentDestinationIdentity('s3', { endpoint: 'https://S3.Example.test/', bucket: 'bucket-a' })).toBe(ID);
    expect(currentDestinationIdentity('s3', { endpoint: 'https://s3.example.test', bucket: 'bucket-a', prefix: 'tenant/' })).toBe(ID);
  });
});

describe('evaluateBackupDestination', () => {
  it('opens when two distinct devices are failing on storage', () => {
    const r = evaluate([
      job('a', 2, 'failed', DENIED),
      job('b', 1, 'failed', DENIED),
      job('c', 1, 'completed'),
    ]);
    expect(r).toMatchObject({ state: 'broken', severity: 'permanent', cause: 'storage_access_denied', failingDevices: 2, totalDevices: 3 });
    expect(r.since).toEqual(hoursAgo(2));
    expect(r.lastFailureAt).toEqual(hoursAgo(1));
  });

  it("one device's storage failure among healthy devices does not open", () => {
    const r = evaluate([
      job('a', 1, 'failed', DENIED),
      job('a', 3, 'failed', DENIED),
      job('b', 1, 'completed'),
      job('c', 1, 'completed'),
    ]);
    expect(r.state).toBe('unknown');
    expect(r.failingDevices).toBe(1);
  });

  it('a non-access cause is transient; a split cause is reported as none', () => {
    expect(evaluate([job('a', 1, 'failed', STORE_5XX), job('b', 1, 'failed', STORE_5XX)]))
      .toMatchObject({ state: 'broken', severity: 'transient', cause: 'storage_operation_failed' });
    expect(evaluate([job('a', 1, 'failed', STORE_5XX), job('b', 1, 'failed', DENIED)]))
      .toMatchObject({ state: 'broken', severity: 'transient', cause: null });
  });

  it('the majority cause decides severity', () => {
    expect(evaluate([job('a', 1, 'failed', DENIED), job('b', 1, 'failed', DENIED), job('c', 1, 'failed', STORE_5XX)]))
      .toMatchObject({ state: 'broken', severity: 'permanent', cause: 'storage_access_denied', failingDevices: 3 });
  });

  describe('single-device destination', () => {
    it('opens on one explicit access-denied or not-found result', () => {
      expect(evaluate([job('a', 1, 'failed', DENIED)])).toMatchObject({ state: 'broken', severity: 'permanent', cause: 'storage_access_denied', failingDevices: 1, totalDevices: 1 });
      expect(evaluate([job('a', 1, 'failed', NOT_FOUND)])).toMatchObject({ state: 'broken', severity: 'permanent', cause: 'storage_not_found' });
    });

    it('any other storage failure needs two consecutive bad occurrences', () => {
      expect(evaluate([job('a', 1, 'failed', STORE_5XX)]).state).toBe('unknown');
      expect(evaluate([job('a', 1, 'failed', STORE_5XX), job('a', 5, 'completed')]).state).toBe('unknown');
      expect(evaluate([job('a', 1, 'failed', STORE_5XX), job('a', 5, 'failed', STORE_5XX)]))
        .toMatchObject({ state: 'broken', severity: 'transient', cause: 'storage_operation_failed', since: hoursAgo(5) });
    });

    it('an unknown occurrence between two bad ones does not break the streak', () => {
      expect(evaluate([job('a', 1, 'failed', STORE_5XX), job('a', 3, 'failed', OFFLINE), job('a', 5, 'failed', STORE_5XX)]).state).toBe('broken');
    });

    it('devices with only unknown outcomes do not make a destination multi-device', () => {
      const r = evaluate([job('a', 1, 'failed', DENIED), job('b', 1, 'failed', OFFLINE)]);
      expect(r).toMatchObject({ state: 'broken', failingDevices: 1, totalDevices: 2 });
    });
  });

  it('collapses the per-run fan-out to one occurrence per device; a storage failure wins', () => {
    const run = hoursAgo(2);
    // One run of device a: the file job completed, the system image job was refused.
    const fanOut = [
      job('a', 2, 'completed', null, { createdAt: run }),
      job('a', 2, 'failed', STORE_5XX, { createdAt: run }),
    ];
    // Without the collapse these would be two consecutive bad occurrences of one device.
    expect(evaluate([...fanOut, job('a', 1, 'failed', STORE_5XX, { createdAt: hoursAgo(1) })]))
      .toMatchObject({ state: 'broken', failingDevices: 1 });
    expect(evaluate([
      job('a', 1, 'failed', STORE_5XX, { createdAt: hoursAgo(1) }),
      job('a', 1, 'failed', STORE_5XX, { createdAt: hoursAgo(1) }),
    ]).state).toBe('unknown');
    // The completed half of a refused run is not a recovery.
    expect(evaluate([...fanOut, job('b', 1, 'failed', STORE_5XX)])).toMatchObject({ state: 'broken', failingDevices: 2 });
  });

  it('a re-pointed destination ignores failures on the old identity', () => {
    const r = evaluate([
      job('a', 5, 'failed', DENIED, { storageIdentity: OTHER_ID }),
      job('b', 5, 'failed', DENIED, { storageIdentity: OTHER_ID }),
      job('a', 1, 'completed'),
      job('b', 1, 'completed'),
    ]);
    expect(r).toMatchObject({ state: 'healthy', failingDevices: 0, totalDevices: 2, lastFailureAt: null });
    // A job never dispatched has no identity: not attributable to this destination.
    expect(evaluate([job('a', 1, 'failed', DENIED, { storageIdentity: null }), job('b', 1, 'failed', DENIED, { storageIdentity: null })]).state)
      .toBe('unknown');
  });

  it('ignores outcomes older than the lookback', () => {
    const old = DESTINATION_LOOKBACK_MS / 3_600_000 + 1;
    expect(evaluate([job('a', old, 'failed', DENIED), job('b', old, 'failed', DENIED)])).toMatchObject({ state: 'unknown', totalDevices: 0 });
  });

  describe('recovery', () => {
    it('needs clean occurrences from two devices after the latest storage failure', () => {
      const base = [job('a', 10, 'failed', DENIED), job('b', 9, 'failed', DENIED), job('c', 20, 'completed')];
      // Only a has come back; b's latest decisive outcome is still bad.
      expect(evaluate([...base, job('a', 2, 'completed')]).state).toBe('unknown');
      // b too: both clean after the latest failure (9 h ago).
      expect(evaluate([...base, job('a', 2, 'completed'), job('b', 1, 'completed')])).toMatchObject({ state: 'healthy', failingDevices: 0 });
    });

    it('a device whose clean run predates the latest failure is not evidence', () => {
      // a recovered after the failure; c last succeeded before it. min(2, 3) = 2 needed, 1 seen.
      const r = evaluate([job('a', 10, 'failed', DENIED), job('a', 2, 'completed'), job('c', 20, 'completed')]);
      expect(r.state).toBe('unknown');
    });

    it('offline devices do not resolve an incident', () => {
      const r = evaluate([
        job('a', 10, 'failed', DENIED),
        job('b', 10, 'failed', DENIED),
        job('a', 2, 'failed', OFFLINE),
        job('b', 1, 'failed', OFFLINE),
        job('b', 1, 'cancelled'),
      ]);
      expect(r).toMatchObject({ state: 'broken', failingDevices: 2 });
    });

    it('a single-device destination recovers on its own clean run', () => {
      expect(evaluate([job('a', 10, 'failed', DENIED), job('a', 1, 'completed')])).toMatchObject({ state: 'healthy' });
    });

    it('no evidence at all is unknown, never healthy', () => {
      expect(evaluate([])).toMatchObject({ state: 'unknown', failingDevices: 0, totalDevices: 0, since: null });
      expect(evaluate([job('a', 1, 'failed', OFFLINE)]).state).toBe('unknown');
    });

    it('healthy with no failure in the window when every decisive device is clean', () => {
      expect(evaluate([job('a', 1, 'completed'), job('b', 2, 'completed')]).state).toBe('healthy');
    });
  });

  it('an unattributable storage failure (a Breeze API refusal) never counts against the destination', () => {
    expect(evaluate([job('a', 1, 'failed', BREEZE_REFUSAL), job('b', 1, 'failed', BREEZE_REFUSAL)]).state).toBe('unknown');
  });

  describe('review gaps (#11777)', () => {
    it('inside one run a refusal outranks another destination fault, whatever the job order', () => {
      const run = hoursAgo(1);
      for (const jobs of [
        [job('a', 1, 'failed', STORE_5XX, { createdAt: run }), job('a', 1, 'failed', DENIED, { createdAt: run })],
        [job('a', 1, 'failed', DENIED, { createdAt: run }), job('a', 1, 'failed', STORE_5XX, { createdAt: run })],
      ]) {
        expect(evaluate(jobs)).toMatchObject({ state: 'broken', severity: 'permanent', cause: 'storage_access_denied', failingDevices: 1 });
      }
    });

    it('a run with a completed job and an unknown one is good', () => {
      const run = hoursAgo(1);
      expect(evaluate([job('a', 1, 'completed', null, { createdAt: run }), job('a', 1, 'failed', OFFLINE, { createdAt: run })]))
        .toMatchObject({ state: 'healthy', evidence: { decisiveDevices: 1 } });
    });

    it('the clean-device threshold counts devices with decisive evidence only', () => {
      expect(evaluate([job('a', 1, 'completed'), job('b', 1, 'failed', OFFLINE)]))
        .toMatchObject({ state: 'healthy', totalDevices: 2, evidence: { requiredCleanDevices: 1, decisiveDevices: 1 } });
      expect(evaluate([job('a', 10, 'failed', DENIED), job('a', 2, 'completed'), job('b', 1, 'failed', OFFLINE)]).state).toBe('healthy');
    });

    it('a failure streak stops at the last good run', () => {
      expect(evaluate([job('a', 20, 'completed'), job('a', 10, 'failed', STORE_5XX), job('a', 5, 'failed', STORE_5XX)]))
        .toMatchObject({ state: 'broken', since: hoursAgo(10) });
      expect(evaluate([job('a', 30, 'failed', STORE_5XX), job('a', 20, 'completed'), job('a', 5, 'failed', STORE_5XX), job('a', 3, 'failed', STORE_5XX)]))
        .toMatchObject({ state: 'broken', since: hoursAgo(5) });
      // since is the earliest streak start across failing devices.
      expect(evaluate([job('a', 6, 'failed', DENIED), job('b', 9, 'failed', DENIED), job('b', 4, 'failed', DENIED)]).since).toEqual(hoursAgo(9));
    });

    it('with no current identity nothing is evidence', () => {
      expect(evaluate([job('a', 1, 'failed', DENIED, { storageIdentity: null }), job('b', 1, 'failed', DENIED, { storageIdentity: null })], null))
        .toMatchObject({ state: 'unknown', totalDevices: 0 });
      expect(evaluate([job('a', 1, 'failed', DENIED), job('b', 1, 'failed', DENIED)], null)).toMatchObject({ state: 'unknown', totalDevices: 0 });
    });

    it('a recovered device among failing ones neither resolves nor counts as failing', () => {
      const r = evaluate([
        job('a', 10, 'failed', DENIED), job('a', 2, 'completed'),
        job('b', 9, 'failed', DENIED),
        job('c', 8, 'failed', DENIED),
      ]);
      expect(r).toMatchObject({ state: 'broken', failingDevices: 2, totalDevices: 3, since: hoursAgo(9) });
      // Two failing, one recovers: one bad among decisive others is not broken, and not healthy either.
      expect(evaluate([job('a', 10, 'failed', DENIED), job('a', 2, 'completed'), job('b', 9, 'failed', DENIED)]).state).toBe('unknown');
    });

    it('a 2-2 split names no cause', () => {
      expect(evaluate([job('a', 1, 'failed', DENIED), job('b', 1, 'failed', DENIED), job('c', 1, 'failed', STORE_5XX), job('d', 1, 'failed', STORE_5XX)]))
        .toMatchObject({ state: 'broken', cause: null, severity: 'transient', failingDevices: 4 });
    });
  });

  it('reports evidence counts', () => {
    const r = evaluate([job('a', 2, 'failed', DENIED), job('b', 1, 'failed', DENIED), job('c', 1, 'failed', OFFLINE)]);
    expect(r.evidence).toEqual({ decisiveDevices: 2, cleanDevicesSinceLastFailure: 0, requiredCleanDevices: 2, occurrences: 3 });
  });
});
