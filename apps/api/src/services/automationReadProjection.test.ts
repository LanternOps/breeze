import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));

import { db } from '../db';
import { projectAutomationRunsToSites, scanProjectedAutomationRuns } from './automationReadProjection';

const RUN_A = '11111111-1111-4111-8111-111111111111';
const RUN_B = '22222222-2222-4222-8222-222222222222';
const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function run(id: string) {
  return {
    id,
    automationId: '33333333-3333-4333-8333-333333333333',
    configPolicyId: null,
    configItemName: null,
    triggeredBy: 'manual:user',
    status: 'failed' as const,
    devicesTargeted: 99,
    devicesSucceeded: 0,
    devicesFailed: 99,
    devicesCancelled: 0,
    startedAt: new Date('2026-09-05T00:00:00Z'),
    completedAt: new Date('2026-09-05T00:01:00Z'),
    logs: [
      { level: 'error', message: 'allowed output', deviceId: 'device-a' },
      { level: 'error', message: 'hidden output', deviceId: 'device-b' },
      { level: 'warning', message: 'org-wide aggregate without a device' },
    ],
    createdAt: new Date('2026-09-05T00:00:00Z'),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('projectAutomationRunsToSites', () => {
  it('keeps the legacy projection and avoids a device query for unrestricted readers', async () => {
    const original = run(RUN_A);
    await expect(projectAutomationRunsToSites([original], undefined)).resolves.toEqual([original]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('binds run and site ids, omits hidden-only runs, and recomputes every aggregate', async () => {
    let whereClause: unknown;
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn((condition) => {
            whereClause = condition;
            return Promise.resolve([
              {
                runId: RUN_A, deviceId: 'device-a', status: 'success',
                startedAt: new Date('2026-09-05T00:00:10Z'),
                completedAt: new Date('2026-09-05T00:00:20Z'),
              },
            ]);
          }),
        }),
      }),
    } as any);

    const projected = await projectAutomationRunsToSites([run(RUN_A), run(RUN_B)], [SITE_A]);
    const query = new PgDialect().sqlToQuery(whereClause as any);

    expect(query.params).toEqual(expect.arrayContaining([RUN_A, RUN_B, SITE_A]));
    expect(query.sql).toContain('automation_run_device_results');
    expect(query.sql).toContain('site_id');
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      id: RUN_A,
      status: 'completed',
      devicesTargeted: 1,
      devicesSucceeded: 1,
      devicesFailed: 0,
      devicesCancelled: 0,
      startedAt: new Date('2026-09-05T00:00:10Z'),
      completedAt: new Date('2026-09-05T00:00:20Z'),
      logs: [{ level: 'error', message: 'allowed output', deviceId: 'device-a' }],
    });
    expect(JSON.stringify(projected)).not.toContain('hidden output');
    expect(JSON.stringify(projected)).not.toContain('org-wide aggregate');
  });

  it('fails closed for an empty site grant', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      }),
    } as any);
    await expect(projectAutomationRunsToSites([run(RUN_A)], [])).resolves.toEqual([]);
  });

  it('keeps live projected completion null and never borrows hidden timing', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{
            runId: RUN_A, deviceId: 'device-a', status: 'running',
            startedAt: new Date('2026-09-05T00:00:30Z'), completedAt: null,
          }]),
        }),
      }),
    } as any);
    const [projected] = await projectAutomationRunsToSites([run(RUN_A)], [SITE_A]);
    expect(projected).toMatchObject({
      status: 'running', startedAt: new Date('2026-09-05T00:00:30Z'), completedAt: null,
    });
  });

  it('scans beyond a hidden first batch without retaining or binding an unbounded history', async () => {
    const hidden = Array.from({ length: 250 }, (_, index) => run(`${index}`.padStart(8, '0') + '-0000-4000-8000-000000000000'));
    const visible = run(RUN_A);
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({ offset: vi.fn().mockResolvedValue(hidden) }),
            }),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({ offset: vi.fn().mockResolvedValue([visible]) }),
            }),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{
            runId: RUN_A, deviceId: 'device-a', status: 'success',
            startedAt: new Date('2026-09-05T00:00:10Z'), completedAt: new Date('2026-09-05T00:00:20Z'),
          }]) }),
        }),
      } as any);

    const result = await scanProjectedAutomationRuns({
      automationId: '33333333-3333-4333-8333-333333333333',
      allowedSiteIds: [SITE_A],
      limit: 10,
    });
    expect(result.total).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.id).toBe(RUN_A);
  });
});
