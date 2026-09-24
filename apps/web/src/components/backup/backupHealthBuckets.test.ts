// apps/web/src/components/backup/backupHealthBuckets.test.ts
//
// SCOPE: this suite owns the WEB half only — counts, percentages, the
// `other`-when-non-zero filter, and that every bucket carries a class. The
// exhaustiveness proof ("every ExternalBackupStatus is in exactly one bucket")
// lives with the grouping itself, in @breeze/shared (W01), so it is asserted
// once for the overview AND the W05 report rather than once per consumer.
import { describe, expect, it } from 'vitest';
import { BACKUP_STATUS_BUCKET_IDS, EXTERNAL_BACKUP_STATUSES } from '@breeze/shared';

import { STATUS_BUCKETS, STATUS_CLASS, recencyBuckets, statusBuckets } from './backupHealthBuckets';

const zeroStatus = () => Object.fromEntries(EXTERNAL_BACKUP_STATUSES.map((s) => [s, 0])) as Record<string, number>;

describe('STATUS_BUCKETS', () => {
  it('is the shared bucket list, in the shared order, with nothing added or dropped', () => {
    expect(STATUS_BUCKETS.map((b) => b.id)).toEqual([...BACKUP_STATUS_BUCKET_IDS]);
  });

  it('gives every shared bucket a class — a new bucket in W01 must not render invisible', () => {
    for (const id of BACKUP_STATUS_BUCKET_IDS) {
      expect(STATUS_CLASS[id], `no class for bucket ${id}`).toBeTruthy();
    }
    expect(Object.keys(STATUS_CLASS).sort()).toEqual([...BACKUP_STATUS_BUCKET_IDS].sort());
  });
});

describe('statusBuckets', () => {
  it('sums each bucket and reports whole-number percentages of the total', () => {
    const buckets = statusBuckets({
      ...zeroStatus(),
      completed: 6, failed: 2, over_quota: 1, no_backups: 1,
    } as never);
    const byId = Object.fromEntries(buckets.map((b) => [b.id, b]));
    expect(byId.completed!.count).toBe(6);
    expect(byId.completed!.percent).toBe(60);
    expect(byId.unsuccessful!.count).toBe(3);
    expect(byId.unsuccessful!.percent).toBe(30);
    expect(byId.no_backups!.percent).toBe(10);
  });

  it('omits the `other` bucket when it is empty, and includes it when it is not', () => {
    expect(statusBuckets(zeroStatus() as never).some((b) => b.id === 'other')).toBe(false);
    expect(statusBuckets({ ...zeroStatus(), unknown: 1 } as never).some((b) => b.id === 'other')).toBe(true);
  });

  it('never divides by zero', () => {
    for (const bucket of statusBuckets(zeroStatus() as never)) expect(bucket.percent).toBe(0);
  });

  it('keeps the five named buckets even at zero, so the bar group never reflows', () => {
    expect(statusBuckets(zeroStatus() as never).map((b) => b.id)).toEqual([
      'no_backups', 'completed', 'completed_with_errors', 'in_progress', 'unsuccessful',
    ]);
  });
});

describe('recencyBuckets', () => {
  it('reports the four recency states in worst-first order', () => {
    const buckets = recencyBuckets({ never: 1, over_48h: 2, under_48h: 3, under_24h: 4 });
    expect(buckets.map((b) => b.id)).toEqual(['never', 'over_48h', 'under_48h', 'under_24h']);
    expect(buckets.map((b) => b.percent)).toEqual([10, 20, 30, 40]);
  });
});
