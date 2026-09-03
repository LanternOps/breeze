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
  StoredArtifactOnlyReportError,
  type ReportType,
} from './reportGenerationService';
import { reportTypeEnum } from '../db/schema/reports';

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
/** Every `ReportType` that is NOT generated on demand. P2-3 added the first
 *  one: a weekly AI narrative's artifact is written once by the agent run and
 *  only ever read back — there is no query that could reproduce it. */
const STORED_ARTIFACT_ONLY_TYPES: readonly ReportType[] = ['ai_org_narrative'];

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
    principalKind: 'user',
    scope: kind === 'restricted'
      ? { version: 1, kind, orgId, siteIds }
      : { version: 1, kind, orgId },
    principalUserId: USER_ID,
    capturedAt: new Date('2026-07-25T12:00:00.000Z'),
    fingerprint: kind === 'restricted' ? 'a'.repeat(64) : 'f'.repeat(64),
  };
}

function portalAuthority(): ReportExecutionAuthority {
  return {
    principalKind: 'portal_user',
    scope: { version: 1, kind: 'unrestricted', orgId: ORG_ID },
    capturedAt: new Date('2026-07-25T12:00:00.000Z'),
    fingerprint: 'f'.repeat(64),
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

  it.each(['executive_summary', 'security_compliance_posture'] as const)(
    'allows portal-user authority for %s',
    async (type) => {
      await expect(generateReport(type, ORG_ID, {}, portalAuthority()))
        .resolves.toBeDefined();
    },
  );

  it.each([
    'device_inventory',
    'software_inventory',
    'alert_summary',
    'compliance',
    'performance',
    'ai_org_narrative',
  ] as const)('rejects portal-user authority for %s before querying', async (type) => {
    await expect(generateReport(type, ORG_ID, {}, portalAuthority()))
      .rejects.toThrow(/portal|authority|report type/i);
    expect(db.select).not.toHaveBeenCalled();
  });

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

/**
 * P2-3 (#4190) — `ai_org_narrative` is a STORED artifact, not a generated one.
 * Its `report_runs` row is written once, inside the agent run's transaction
 * (`persistNarrativeReport`), from a model-authored narrative that no query
 * could reproduce. Every generation entry point must therefore refuse it
 * rather than fall through to a `never` check whose message ("Invalid report
 * type") would read as a bug in the type union.
 */
describe('stored-artifact-only report types (P2-3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedWhere.length = 0;
    vi.mocked(db.select).mockReturnValue(selectChain([]));
  });

  it.each(STORED_ARTIFACT_ONLY_TYPES)(
    '%s is refused by the dispatch switch before any query runs',
    async (type) => {
      await expect(
        generateReport(type, ORG_ID, {}, authority('unrestricted')),
      ).rejects.toBeInstanceOf(StoredArtifactOnlyReportError);
      expect(db.select).not.toHaveBeenCalled();
    },
  );

  it.each(STORED_ARTIFACT_ONLY_TYPES)(
    '%s is refused by the ZERO-SAFE branch too, which the dispatch switch never reaches',
    async (type) => {
      // A restricted-empty authority short-circuits into `zeroSafeReport`
      // before the dispatch switch — a second exhaustive switch, and the one
      // that would otherwise hand back a plausible-looking empty report for a
      // document that exists.
      await expect(
        generateReport(type, ORG_ID, {}, authority('restricted', [])),
      ).rejects.toBeInstanceOf(StoredArtifactOnlyReportError);
      expect(db.select).not.toHaveBeenCalled();
    },
  );

  it('carries the stable code routes map to 409', async () => {
    const error = await generateReport('ai_org_narrative', ORG_ID, {}, authority('unrestricted'))
      .catch((e: unknown) => e as StoredArtifactOnlyReportError);

    expect(error).toBeInstanceOf(StoredArtifactOnlyReportError);
    expect((error as StoredArtifactOnlyReportError).code).toBe('stored_artifact_only');
  });

  it('the API-local ReportType union covers exactly the DB enum, with no type unaccounted for', () => {
    // Drift guard: `reportGenerationService.ts` keeps its own union rather than
    // deriving from the pgEnum, and a value added to one and not the other is
    // a `never`-check failure at a call site far from either file.
    expect([...REPORT_TYPES, ...STORED_ARTIFACT_ONLY_TYPES].sort())
      .toEqual([...reportTypeEnum.enumValues].sort());
  });
});
