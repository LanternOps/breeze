import { describe, expect, it } from 'vitest';
import {
  mergeBootRecords,
  parseCollectorBootMetricsFromCommandResult,
} from './bootPerformance';

describe('bootPerformance helpers', () => {
  it('parses collector output from command stdout', () => {
    const parsed = parseCollectorBootMetricsFromCommandResult({
      status: 'completed',
      stdout: JSON.stringify({
        bootTimestamp: '2026-02-20T10:00:00.000Z',
        totalBootSeconds: 42.5,
        startupItems: [
          {
            name: 'svc',
            type: 'service',
            path: '/usr/bin/svc',
            enabled: true,
            cpuTimeMs: 12,
            diskIoBytes: 1000,
            impactScore: 1.2,
          },
        ],
      }),
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.totalBootSeconds).toBe(42.5);
    expect(parsed?.startupItems).toHaveLength(1);
    expect((parsed?.startupItems[0] as { itemId?: string }).itemId).toBe('service|/usr/bin/svc');
  });

  it('merges fresh metrics ahead of stale db history', () => {
    const merged = mergeBootRecords(
      [
        {
          bootTimestamp: new Date('2026-02-19T10:00:00.000Z'),
          biosSeconds: 1,
          osLoaderSeconds: 2,
          desktopReadySeconds: 3,
          totalBootSeconds: 60,
          startupItemCount: 0,
          startupItems: [],
        },
      ],
      {
        bootTimestamp: new Date('2026-02-20T10:00:00.000Z'),
        biosSeconds: 1,
        osLoaderSeconds: 2,
        desktopReadySeconds: 3,
        totalBootSeconds: 45,
        startupItemCount: 0,
        startupItems: [],
      },
      10
    );

    expect(merged).toHaveLength(2);
    expect(new Date(merged[0]!.bootTimestamp).toISOString()).toBe('2026-02-20T10:00:00.000Z');
    expect(merged[0]!.totalBootSeconds).toBe(45);
  });

  it('deduplicates by boot timestamp when fresh and db entries overlap', () => {
    const merged = mergeBootRecords(
      [
        {
          bootTimestamp: new Date('2026-02-20T10:00:00.000Z'),
          biosSeconds: 0,
          osLoaderSeconds: 0,
          desktopReadySeconds: 0,
          totalBootSeconds: 99,
          startupItemCount: 1,
          startupItems: [],
        },
      ],
      {
        bootTimestamp: new Date('2026-02-20T10:00:00.000Z'),
        biosSeconds: 1,
        osLoaderSeconds: 2,
        desktopReadySeconds: 3,
        totalBootSeconds: 40,
        startupItemCount: 0,
        startupItems: [],
      },
      10
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]!.totalBootSeconds).toBe(40);
  });
});

