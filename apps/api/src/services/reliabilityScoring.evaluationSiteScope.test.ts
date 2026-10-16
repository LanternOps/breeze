import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const mocks = vi.hoisted(() => ({
  whereArgs: [] as unknown[],
  select: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { select: mocks.select },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('./mlFeatureFlags', () => ({ shouldProduceMlOutput: vi.fn() }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { evaluateReliabilityScores } from './reliabilityScoring';

describe('evaluateReliabilityScores site boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.whereArgs.length = 0;
    mocks.select.mockImplementation(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn((where: unknown) => {
            mocks.whereArgs.push(where);
            return Promise.resolve([]);
          }),
        })),
      })),
    }));
  });

  it('uses a deny-all SQL predicate for a defined-empty site allowlist', async () => {
    const summary = await evaluateReliabilityScores({
      orgIds: ['00000000-0000-0000-0000-000000000001'],
      siteIds: [],
    });

    expect(summary.evaluatedDevices).toBe(0);
    expect(mocks.whereArgs).toHaveLength(1);
    const rendered = new PgDialect().sqlToQuery(mocks.whereArgs[0] as SQL);
    expect(rendered.sql).toContain('false');
  });
});

describe('evaluateReliabilityScores baseline marker (#5876)', () => {
  const ORG = '00000000-0000-0000-0000-000000000001';
  const DEVICE = '00000000-0000-0000-0000-0000000000d1';
  const baselineAt = '2026-03-10T00:00:00.000Z';

  function mockQueries(labelRows: unknown[]) {
    let call = 0;
    mocks.select.mockImplementation(() => {
      const idx = call++;
      if (idx === 0) {
        return {
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              where: vi.fn(() => Promise.resolve([{
                deviceId: DEVICE, orgId: ORG, siteId: 's', hostname: 'h', reliabilityScore: 40,
                computedAt: new Date('2026-03-30T00:00:00.000Z'), baselineAt,
              }])),
            })),
          })),
        };
      }
      return { from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve(labelRows)) })) };
    });
  }

  it('ignores failure labels dated before the active marker and keeps later ones', async () => {
    mockQueries([
      { deviceId: DEVICE, outcome: 'failure_confirmed', occurredAt: new Date('2026-03-05T00:00:00.000Z') },
    ]);
    const before = await evaluateReliabilityScores({ orgId: ORG });
    expect(before.confirmedFailureLabels).toBe(0);

    vi.clearAllMocks();
    mockQueries([
      { deviceId: DEVICE, outcome: 'failure_confirmed', occurredAt: new Date('2026-03-15T00:00:00.000Z') },
    ]);
    const after = await evaluateReliabilityScores({ orgId: ORG });
    expect(after.confirmedFailureLabels).toBe(1);
  });
});
