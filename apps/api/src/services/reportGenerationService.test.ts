import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
  },
}));

import { db } from '../db';
import type { ReportExecutionAuthority } from './siteScope';
import {
  generateReport,
  type ReportType,
} from './reportGenerationService';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REPORT_TYPES: readonly ReportType[] = [
  'device_inventory',
  'software_inventory',
  'alert_summary',
  'compliance',
  'performance',
  'executive_summary',
  'security_compliance_posture',
];

const capturedWhere: SQL[] = [];

function selectChain(rows: unknown[] = []) {
  const chain: any = Promise.resolve(rows);
  for (const method of [
    'from',
    'innerJoin',
    'leftJoin',
    'orderBy',
    'groupBy',
    'limit',
  ]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.where = vi.fn((condition: SQL) => {
    capturedWhere.push(condition);
    return chain;
  });
  return chain;
}

function authority(
  kind: 'unrestricted' | 'restricted',
  siteIds: string[] = [],
  orgId = ORG_ID,
): ReportExecutionAuthority {
  return {
    scope: kind === 'restricted'
      ? { version: 1, kind, orgId, siteIds }
      : { version: 1, kind, orgId },
    principalUserId: USER_ID,
    capturedAt: new Date('2026-07-25T12:00:00.000Z'),
    fingerprint: kind === 'restricted' ? 'a'.repeat(64) : 'f'.repeat(64),
  };
}

function renderedParams(): unknown[] {
  const dialect = new PgDialect();
  return capturedWhere.flatMap((condition) =>
    dialect.sqlToQuery(condition).params
  );
}

describe('generateReport mandatory execution authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedWhere.length = 0;
    vi.mocked(db.select).mockReturnValue(selectChain([]));
  });

  it('rejects a missing authority before the first report query', async () => {
    await expect(
      generateReport(
        'device_inventory',
        ORG_ID,
        {},
        undefined as never,
      ),
    ).rejects.toThrow(/authority|scope/i);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rejects an authority for another organization before querying', async () => {
    await expect(
      generateReport(
        'device_inventory',
        ORG_ID,
        {},
        authority('unrestricted', [], OTHER_ORG_ID),
      ),
    ).rejects.toThrow(/organization|scope/i);
    expect(db.select).not.toHaveBeenCalled();
  });

  it.each(REPORT_TYPES)(
    '%s returns its zero-safe shape for restricted-empty without querying',
    async (type) => {
      const result = await generateReport(
        type,
        ORG_ID,
        {},
        authority('restricted', []),
      );

      expect(db.select).not.toHaveBeenCalled();
      if (type === 'executive_summary') {
        expect(result.summary).toMatchObject({
          devices: { total: 0 },
          alerts: { total: 0 },
        });
      } else {
        expect(result.rows).toEqual([]);
        expect(result.rowCount).toBe(0);
      }
    },
  );

  it.each(REPORT_TYPES)(
    '%s binds the exact restricted site scope and never Site B',
    async (type) => {
      await generateReport(
        type,
        ORG_ID,
        {},
        authority('restricted', [SITE_A]),
      );

      const params = renderedParams();
      expect(params).toContain(SITE_A);
      expect(params).not.toContain(SITE_B);
    },
  );

  it.each(REPORT_TYPES)(
    '%s preserves unrestricted generation without a site predicate',
    async (type) => {
      await generateReport(
        type,
        ORG_ID,
        {},
        authority('unrestricted'),
      );

      expect(renderedParams()).not.toContain(SITE_A);
      expect(renderedParams()).not.toContain(SITE_B);
    },
  );
});
