import { describe, expect, it } from 'vitest';

import { MAX_ANOMALY_BACKFILL_DAYS, parseMetricAnomalyBackfillArgs } from './metric-anomaly-backfill.lib';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

describe('parseMetricAnomalyBackfillArgs', () => {
  it('parses a bounded org/time-range backfill request', () => {
    const options = parseMetricAnomalyBackfillArgs([
      '--org-id',
      ORG_ID,
      '--from',
      '2026-06-18T00:00:00.000Z',
      '--to',
      '2026-06-19T00:00:00.000Z',
      '--dry-run',
    ]);

    expect(options).toEqual({
      orgId: ORG_ID,
      from: new Date('2026-06-18T00:00:00.000Z'),
      to: new Date('2026-06-19T00:00:00.000Z'),
      dryRun: true,
    });
  });

  it('accepts equals-style arguments for shell-friendly use', () => {
    const options = parseMetricAnomalyBackfillArgs([
      `--org-id=${ORG_ID}`,
      '--from=2026-06-18T00:00:00.000Z',
      '--to=2026-06-18T01:00:00.000Z',
    ]);

    expect(options.orgId).toBe(ORG_ID);
    expect(options.from.toISOString()).toBe('2026-06-18T00:00:00.000Z');
    expect(options.to.toISOString()).toBe('2026-06-18T01:00:00.000Z');
    expect(options.dryRun).toBe(false);
  });

  it('rejects ranges longer than the bounded backfill limit', () => {
    expect(() =>
      parseMetricAnomalyBackfillArgs([
        '--org-id',
        ORG_ID,
        '--from',
        '2026-06-01T00:00:00.000Z',
        '--to',
        new Date(Date.UTC(2026, 5, 1 + MAX_ANOMALY_BACKFILL_DAYS, 0, 0, 1)).toISOString(),
      ])
    ).toThrow(`${MAX_ANOMALY_BACKFILL_DAYS} days or less`);
  });

  it('rejects invalid and inverted ranges before any database work', () => {
    expect(() =>
      parseMetricAnomalyBackfillArgs([
        '--org-id',
        ORG_ID,
        '--from',
        'not-a-date',
        '--to',
        '2026-06-18T01:00:00.000Z',
      ])
    ).toThrow('--from must be a valid ISO timestamp');

    expect(() =>
      parseMetricAnomalyBackfillArgs([
        '--org-id',
        ORG_ID,
        '--from',
        '2026-06-18T02:00:00.000Z',
        '--to',
        '2026-06-18T01:00:00.000Z',
      ])
    ).toThrow('--from must be before --to');
  });

  it('requires org and timestamps', () => {
    expect(() => parseMetricAnomalyBackfillArgs([])).toThrow('--org-id is required');
    expect(() => parseMetricAnomalyBackfillArgs(['--org-id', ORG_ID])).toThrow('--from is required');
  });
});
