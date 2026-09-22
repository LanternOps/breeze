import { describe, it, expect } from 'vitest';
import {
  BACKUP_CRITICAL_AFTER_HOURS,
  BACKUP_STATUS_BUCKET_IDS,
  BACKUP_STATUS_BUCKET_MEMBERS,
  BACKUP_WARNING_AFTER_HOURS,
  EXTERNAL_BACKUP_STATUS_SEVERITY,
  bucketForBackupStatus,
  deriveBackupHealth,
  mapBackupJobStatus,
  worstBackupStatus,
} from './backupHealth';
import { EXTERNAL_BACKUP_STATUSES, type ExternalBackupStatus } from '../types/backupHealth';

const NOW = new Date('2026-09-15T12:00:00.000Z');
/** `hours` ago relative to NOW, as an ISO string (the shape the API serves). */
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

describe('EXTERNAL_BACKUP_STATUSES', () => {
  it('carries exactly the ten pg enum labels, in the enum order', () => {
    // The order is the contract with the `external_backup_status` pg type
    // (migration 2026-10-17-120000). backupProviderRls.integration.test.ts
    // compares this tuple against live pg_enum; keep them in step.
    expect(EXTERNAL_BACKUP_STATUSES).toEqual([
      'completed',
      'completed_with_errors',
      'failed',
      'in_progress',
      'interrupted',
      'over_quota',
      'no_selection',
      'not_started',
      'no_backups',
      'unknown',
    ]);
  });

  it('assigns every status a severity, with no ties', () => {
    const severities = EXTERNAL_BACKUP_STATUSES.map((s) => EXTERNAL_BACKUP_STATUS_SEVERITY[s]);
    expect(severities.every((n) => Number.isInteger(n))).toBe(true);
    expect(new Set(severities).size).toBe(EXTERNAL_BACKUP_STATUSES.length);
  });
});

describe('worstBackupStatus', () => {
  it('orders failed > over_quota > no_selection > no_backups > interrupted > completed_with_errors > not_started > unknown > in_progress > completed', () => {
    const descending: ExternalBackupStatus[] = [
      'failed', 'over_quota', 'no_selection', 'no_backups', 'interrupted',
      'completed_with_errors', 'not_started', 'unknown', 'in_progress', 'completed',
    ];
    for (let i = 0; i < descending.length - 1; i++) {
      const worse = descending[i]!;
      const better = descending[i + 1]!;
      expect(worstBackupStatus(worse, better)).toBe(worse);
      expect(worstBackupStatus(better, worse)).toBe(worse);
    }
  });

  it('is idempotent and total over the whole enum', () => {
    for (const a of EXTERNAL_BACKUP_STATUSES) {
      expect(worstBackupStatus(a, a)).toBe(a);
      for (const b of EXTERNAL_BACKUP_STATUSES) {
        expect(EXTERNAL_BACKUP_STATUSES).toContain(worstBackupStatus(a, b));
      }
    }
  });
});

describe('BACKUP_STATUS_BUCKET_MEMBERS', () => {
  it('declares the six bucket ids in the order the Cove-email layout renders them', () => {
    expect(BACKUP_STATUS_BUCKET_IDS).toEqual([
      'no_backups', 'completed', 'completed_with_errors', 'in_progress', 'unsuccessful', 'other',
    ]);
    expect(Object.keys(BACKUP_STATUS_BUCKET_MEMBERS)).toEqual([...BACKUP_STATUS_BUCKET_IDS]);
  });

  it('defines Unsuccessful as failed + over_quota + no_selection + interrupted', () => {
    // The product rule the spec names. A second copy of it in the web overview
    // and a third in the W05 report is how two surfaces come to disagree about
    // how many devices are failing.
    expect([...BACKUP_STATUS_BUCKET_MEMBERS.unsuccessful].sort()).toEqual(
      ['failed', 'interrupted', 'no_selection', 'over_quota'],
    );
  });

  it('puts every ExternalBackupStatus in EXACTLY ONE bucket', () => {
    for (const status of EXTERNAL_BACKUP_STATUSES) {
      const owning = BACKUP_STATUS_BUCKET_IDS.filter(
        (bucket) => BACKUP_STATUS_BUCKET_MEMBERS[bucket].includes(status),
      );
      expect(owning, `${status} is in ${owning.length} buckets`).toHaveLength(1);
    }
  });

  it('covers the enum exactly — no extra member, no missing one', () => {
    // A status with no bucket would silently vanish from a chart whose
    // percentages still summed to 100%; a member that is not a live enum label
    // would be a bucket nothing can ever land in.
    const members = BACKUP_STATUS_BUCKET_IDS.flatMap((b) => [...BACKUP_STATUS_BUCKET_MEMBERS[b]]);
    expect(new Set(members)).toEqual(new Set(EXTERNAL_BACKUP_STATUSES));
    expect(members).toHaveLength(EXTERNAL_BACKUP_STATUSES.length);
  });

  it('collects not_started and unknown into `other`', () => {
    expect([...BACKUP_STATUS_BUCKET_MEMBERS.other].sort()).toEqual(['not_started', 'unknown']);
  });
});

describe('bucketForBackupStatus', () => {
  it('round-trips every status against its members list', () => {
    for (const bucket of BACKUP_STATUS_BUCKET_IDS) {
      for (const status of BACKUP_STATUS_BUCKET_MEMBERS[bucket]) {
        expect(bucketForBackupStatus(status), `${status} -> ${bucket}`).toBe(bucket);
      }
    }
  });

  it('is total over the enum and never returns undefined', () => {
    for (const status of EXTERNAL_BACKUP_STATUSES) {
      expect(BACKUP_STATUS_BUCKET_IDS).toContain(bucketForBackupStatus(status));
    }
  });

  it.each([
    ['failed', 'unsuccessful'],
    ['over_quota', 'unsuccessful'],
    ['no_selection', 'unsuccessful'],
    ['interrupted', 'unsuccessful'],
    ['completed', 'completed'],
    ['completed_with_errors', 'completed_with_errors'],
    ['in_progress', 'in_progress'],
    ['no_backups', 'no_backups'],
    ['not_started', 'other'],
    ['unknown', 'other'],
  ] as const)('maps %s to the %s bucket', (status, bucket) => {
    expect(bucketForBackupStatus(status)).toBe(bucket);
  });

  it('falls back to `other` for a label outside the enum instead of throwing', () => {
    // A future ALTER TYPE ... ADD VALUE reaches the read model before this file
    // is updated; a throw there would 500 the whole overview.
    expect(bucketForBackupStatus('brand_new_vendor_status' as ExternalBackupStatus)).toBe('other');
  });
});

describe('mapBackupJobStatus', () => {
  it.each([
    ['completed', 'completed'],
    ['partial', 'completed_with_errors'],
    ['failed', 'failed'],
    ['running', 'in_progress'],
    ['pending', 'in_progress'],
    ['cancelled', 'interrupted'],
    [null, 'no_backups'],
  ] as const)('maps backup_jobs.status %s to %s', (jobStatus, expected) => {
    expect(mapBackupJobStatus(jobStatus)).toBe(expected);
  });

  it('maps partial to completed_with_errors, never to failed', () => {
    // RESTORABLE_BACKUP_JOB_STATUSES (apps/api/src/db/schema/backup.ts:82)
    // counts `partial` as a usable restore point; mapping it to `failed` would
    // contradict the SLA worker and make a device with a real snapshot read as
    // never backed up.
    expect(mapBackupJobStatus('partial')).toBe('completed_with_errors');
  });
});

describe('deriveBackupHealth — status-driven verdicts', () => {
  it.each(['failed', 'over_quota', 'no_selection', 'no_backups'] as const)(
    '%s is critical regardless of recency',
    (status) => {
      for (const lastSuccessAt of [null, ago(1), ago(30), ago(100)]) {
        expect(deriveBackupHealth({ status, lastSuccessAt, errorsCount: 0, now: NOW }).health)
          .toBe('critical');
      }
    },
  );

  it.each(['completed_with_errors', 'interrupted'] as const)(
    '%s is warning regardless of recency',
    (status) => {
      for (const lastSuccessAt of [null, ago(1), ago(30), ago(100)]) {
        expect(deriveBackupHealth({ status, lastSuccessAt, errorsCount: 0, now: NOW }).health)
          .toBe('warning');
      }
    },
  );

  it('unknown is unknown regardless of recency or errors', () => {
    for (const lastSuccessAt of [null, ago(1), ago(100)]) {
      expect(deriveBackupHealth({ status: 'unknown', lastSuccessAt, errorsCount: 7, now: NOW }).health)
        .toBe('unknown');
    }
  });

  it('in_progress with errorsCount > 0 is warning, not recency-driven', () => {
    // A run that is still going but already reporting faults (Cove F00 = 9)
    // must not read as healthy just because yesterday's run succeeded.
    expect(deriveBackupHealth({ status: 'in_progress', lastSuccessAt: ago(1), errorsCount: 3, now: NOW }).health)
      .toBe('warning');
    expect(deriveBackupHealth({ status: 'in_progress', lastSuccessAt: null, errorsCount: 3, now: NOW }).health)
      .toBe('warning');
  });

  it('errorsCount > 0 does NOT change the verdict for any other status', () => {
    expect(deriveBackupHealth({ status: 'completed', lastSuccessAt: ago(1), errorsCount: 9, now: NOW }).health)
      .toBe('healthy');
    expect(deriveBackupHealth({ status: 'failed', lastSuccessAt: ago(1), errorsCount: 0, now: NOW }).health)
      .toBe('critical');
  });
});

describe('deriveBackupHealth — recency-driven verdicts', () => {
  const RECENCY_DRIVEN = ['completed', 'in_progress', 'not_started'] as const;

  it.each(RECENCY_DRIVEN)('%s: a success under 24h is healthy/under_24h/covered', (status) => {
    const r = deriveBackupHealth({ status, lastSuccessAt: ago(23), errorsCount: 0, now: NOW });
    expect(r).toEqual({ health: 'healthy', recency: 'under_24h', covered: true });
  });

  it.each(RECENCY_DRIVEN)('%s: a success between 24h and 48h is warning/under_48h/covered', (status) => {
    const r = deriveBackupHealth({ status, lastSuccessAt: ago(30), errorsCount: 0, now: NOW });
    expect(r).toEqual({ health: 'warning', recency: 'under_48h', covered: true });
  });

  it.each(RECENCY_DRIVEN)('%s: a success older than 48h is critical/over_48h/uncovered', (status) => {
    const r = deriveBackupHealth({ status, lastSuccessAt: ago(49), errorsCount: 0, now: NOW });
    expect(r).toEqual({ health: 'critical', recency: 'over_48h', covered: false });
  });

  it.each(RECENCY_DRIVEN)('%s: no success ever is critical/never/uncovered', (status) => {
    const r = deriveBackupHealth({ status, lastSuccessAt: null, errorsCount: 0, now: NOW });
    expect(r).toEqual({ health: 'critical', recency: 'never', covered: false });
  });

  it('boundaries are inclusive at exactly 24h and 48h', () => {
    expect(deriveBackupHealth({ status: 'completed', lastSuccessAt: ago(BACKUP_WARNING_AFTER_HOURS), errorsCount: 0, now: NOW }).recency)
      .toBe('under_48h');
    expect(deriveBackupHealth({ status: 'completed', lastSuccessAt: ago(BACKUP_CRITICAL_AFTER_HOURS), errorsCount: 0, now: NOW }).recency)
      .toBe('over_48h');
  });

  it('a future lastSuccessAt (vendor clock skew) is treated as under_24h, never negative', () => {
    const future = new Date(NOW.getTime() + 3_600_000).toISOString();
    expect(deriveBackupHealth({ status: 'completed', lastSuccessAt: future, errorsCount: 0, now: NOW }).recency)
      .toBe('under_24h');
  });

  it('accepts a Date as well as an ISO string, and ignores an unparseable one', () => {
    expect(deriveBackupHealth({ status: 'completed', lastSuccessAt: new Date(ago(2)), errorsCount: 0, now: NOW }).recency)
      .toBe('under_24h');
    expect(deriveBackupHealth({ status: 'completed', lastSuccessAt: 'not-a-date', errorsCount: 0, now: NOW }))
      .toEqual({ health: 'critical', recency: 'never', covered: false });
  });
});

describe('deriveBackupHealth — covered semantics (D4)', () => {
  it('covered is positive, fresh success evidence and is independent of health', () => {
    // The refined D4: a device whose last run FAILED but which has a 20-hour-old
    // restore point is covered AND critical. Coverage says "it has a backup";
    // health says "look at it". The posture report reads `covered`; the alert
    // center reads `health`.
    const r = deriveBackupHealth({ status: 'failed', lastSuccessAt: ago(20), errorsCount: 2, now: NOW });
    expect(r).toEqual({ health: 'critical', recency: 'under_24h', covered: true });
  });

  it('covered is true for exactly {under_24h, under_48h} across every status', () => {
    for (const status of EXTERNAL_BACKUP_STATUSES) {
      expect(deriveBackupHealth({ status, lastSuccessAt: ago(1), errorsCount: 0, now: NOW }).covered).toBe(true);
      expect(deriveBackupHealth({ status, lastSuccessAt: ago(40), errorsCount: 0, now: NOW }).covered).toBe(true);
      expect(deriveBackupHealth({ status, lastSuccessAt: ago(72), errorsCount: 0, now: NOW }).covered).toBe(false);
      expect(deriveBackupHealth({ status, lastSuccessAt: null, errorsCount: 0, now: NOW }).covered).toBe(false);
    }
  });

  it('an unknown status with a fresh success is still covered but never healthy', () => {
    const r = deriveBackupHealth({ status: 'unknown', lastSuccessAt: ago(2), errorsCount: 0, now: NOW });
    expect(r).toEqual({ health: 'unknown', recency: 'under_24h', covered: true });
  });
});

describe('deriveBackupHealth — exhaustive status x recency matrix', () => {
  const RECENCIES = [
    ['under_24h', ago(2)],
    ['under_48h', ago(36)],
    ['over_48h', ago(72)],
    ['never', null],
  ] as const;

  it('produces the documented health for all 40 cells', () => {
    const CRITICAL_STATUSES = new Set(['failed', 'over_quota', 'no_selection', 'no_backups']);
    const WARNING_STATUSES = new Set(['completed_with_errors', 'interrupted']);
    const RECENCY_STATUSES = new Set(['completed', 'in_progress', 'not_started']);

    for (const status of EXTERNAL_BACKUP_STATUSES) {
      for (const [recency, lastSuccessAt] of RECENCIES) {
        const r = deriveBackupHealth({ status, lastSuccessAt, errorsCount: 0, now: NOW });
        expect(r.recency, `${status} @ ${recency}`).toBe(recency);
        const expected =
          CRITICAL_STATUSES.has(status) ? 'critical'
          : WARNING_STATUSES.has(status) ? 'warning'
          : status === 'unknown' ? 'unknown'
          : RECENCY_STATUSES.has(status)
            ? (recency === 'under_24h' ? 'healthy' : recency === 'under_48h' ? 'warning' : 'critical')
            : (() => { throw new Error(`unclassified status ${status}`); })();
        expect(r.health, `${status} @ ${recency}`).toBe(expected);
        expect(r.covered, `${status} @ ${recency}`).toBe(recency === 'under_24h' || recency === 'under_48h');
      }
    }
  });
});
