/**
 * Site ceiling on the fleet posture reads.
 *
 * `siteIds` follows the site-allowlist rule: `undefined` = unrestricted, `[]`
 * (or a malformed value) = nothing in scope, and a non-empty list admits only
 * devices whose current site is in it. The predicate is part of the query, so
 * `limit` and every aggregate are computed over the visible devices only.
 *
 * Organization snapshots carry no device or site lineage, so a restricted
 * trend is rebuilt from the per-device snapshots of visible devices.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const state: {
  wheres: unknown[];
  froms: unknown[];
  joins: unknown[];
  groupBys: unknown[][];
  limit?: number;
  rows: unknown[];
} = { wheres: [], froms: [], joins: [], groupBys: [], rows: [] };

vi.mock('../db', async () => {
  const { sql } = await import('drizzle-orm');
  const builder = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {
      from: (table: unknown) => { state.froms.push(table); return b; },
      innerJoin: (table: unknown) => { state.joins.push(table); return b; },
      leftJoin: (table: unknown) => { state.joins.push(table); return b; },
      where: (condition: unknown) => { state.wheres.push(condition); return b; },
      groupBy: (...columns: unknown[]) => { state.groupBys.push(columns); return b; },
      orderBy: () => b,
      limit: (n: number) => { state.limit = n; return b; },
      as: (name: string) => new Proxy({}, {
        get: (_target, prop) => sql.raw(`"${name}"."${String(prop)}"`),
      }),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(state.rows).then(resolve, reject),
    };
    return b;
  };
  return {
    db: { select: vi.fn(() => builder()) },
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    withDbAccessContext: vi.fn(async (_c: unknown, fn: () => Promise<unknown>) => fn()),
  };
});

import { db } from '../db';
import { devices, securityPostureOrgSnapshots, securityPostureSnapshots } from '../db/schema';
import {
  getSecurityPostureCounts,
  getSecurityPostureTrend,
  listLatestSecurityPosture,
} from './securityPosture';

const dialect = new PgDialect();
const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';

function compiledWheres(): Array<{ sql: string; params: unknown[] }> {
  return state.wheres.map((w) => dialect.sqlToQuery(w as never));
}

function hasSitePredicate(): boolean {
  return compiledWheres().some((q) => q.sql.includes('"devices"."site_id" in') && q.params.includes(SITE));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.wheres = [];
  state.froms = [];
  state.joins = [];
  state.groupBys = [];
  state.limit = undefined;
  state.rows = [];
});

describe('listLatestSecurityPosture — site ceiling', () => {
  it('filters on the current device site before the limit is applied', async () => {
    await listLatestSecurityPosture({ orgIds: [ORG], siteIds: [SITE], limit: 50 });
    expect(hasSitePredicate()).toBe(true);
    expect(state.limit).toBe(50);
  });

  it('adds no site predicate for an unrestricted caller', async () => {
    await listLatestSecurityPosture({ orgIds: [ORG], limit: 50 });
    expect(compiledWheres().some((q) => q.sql.includes('site_id'))).toBe(false);
  });

  it.each([
    ['empty', []],
    ['malformed', null],
  ])('returns nothing, without querying, for an %s allowlist', async (_label, siteIds) => {
    const rows = await listLatestSecurityPosture({ orgIds: [ORG], siteIds: siteIds as never });
    expect(rows).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('getSecurityPostureCounts — site ceiling', () => {
  it('counts only devices in the allowed sites', async () => {
    await getSecurityPostureCounts({ orgIds: [ORG], siteIds: [SITE] });
    expect(hasSitePredicate()).toBe(true);
  });

  it('returns zero counts, without querying, for an empty allowlist', async () => {
    const counts = await getSecurityPostureCounts({ orgIds: [ORG], siteIds: [] });
    expect(counts.total).toBe(0);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('getSecurityPostureTrend — site ceiling', () => {
  it('keeps reading organization snapshots for an unrestricted caller', async () => {
    await getSecurityPostureTrend({ orgIds: [ORG], days: 7 });
    expect(state.froms).toEqual([securityPostureOrgSnapshots]);
    expect(state.joins).toEqual([]);
  });

  it.each([
    ['empty', []],
    ['malformed', null],
  ])('returns no points, without querying, for an %s allowlist', async (_label, siteIds) => {
    const points = await getSecurityPostureTrend({ orgIds: [ORG], siteIds: siteIds as never, days: 7 });
    expect(points).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rebuilds each posture run from visible-device snapshots, then groups by day', async () => {
    const run = (iso: string, score: number) => ({
      capturedAt: new Date(iso),
      overallScore: score,
      patchComplianceScore: score,
      encryptionScore: score,
      avHealthScore: score,
      firewallScore: score,
      openPortsScore: score,
      passwordPolicyScore: score,
      osCurrencyScore: score,
      adminExposureScore: score,
    });
    state.rows = [
      run('2026-09-21T01:00:00.000Z', 60),
      run('2026-09-20T22:00:00.000Z', 80),
      run('2026-09-20T10:00:00.000Z', 100),
    ];

    const points = await getSecurityPostureTrend({ orgIds: [ORG], siteIds: [SITE], days: 7 });

    expect(state.froms).toEqual([securityPostureSnapshots]);
    expect(state.joins).toEqual([devices]);
    expect(hasSitePredicate()).toBe(true);
    expect(state.groupBys[0]).toEqual([securityPostureSnapshots.orgId, securityPostureSnapshots.capturedAt]);
    expect(points.map((p) => [p.timestamp, p.overall])).toEqual([
      ['2026-09-20', 90],
      ['2026-09-21', 60],
    ]);
  });
});
