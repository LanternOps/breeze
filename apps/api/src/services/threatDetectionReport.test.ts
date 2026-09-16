import { beforeEach, describe, expect, it, vi } from 'vitest';

// Drizzle mock pattern copied verbatim from hardwareLifecycleReport.test.ts:
// every `db.select()` call resolves the next queued row set, in call order.
vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
  },
}));

import { db } from '../db';
import type { ReportGenerationAuthority } from './siteScope';
import { generateThreatDetectionReport } from './threatDetectionReport';
import type { ThreatDetectionSummary, ThreatIncidentRow } from '@breeze/shared';
import type { EvidenceRunContext, ReportResult } from './reportGenerationService';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const PARTNER_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function summaryOf(result: ReportResult): ThreatDetectionSummary {
  return result.summary as ThreatDetectionSummary;
}

/** Records the WHERE fragments each select chain received so a test can prove a
 *  branch pushed its own site filter rather than relying on a sibling's. */
const whereCalls: unknown[][] = [];

function queueSelects(...resultSets: unknown[][]) {
  const queue = [...resultSets];
  whereCalls.length = 0;
  vi.mocked(db.select).mockImplementation((() => {
    const rows = queue.shift() ?? [];
    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'leftJoin', 'innerJoin', 'orderBy', 'limit', 'groupBy']) {
      chain[method] = () => chain;
    }
    chain.where = (...args: unknown[]) => {
      whereCalls.push(args);
      return chain;
    };
    (chain as { then?: unknown }).then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve);
    return chain;
  }) as never);
}

function authority(
  kind: 'unrestricted' | 'restricted' = 'unrestricted',
  siteIds: string[] = [],
): ReportGenerationAuthority {
  return {
    principalKind: 'user',
    scope: kind === 'restricted'
      ? { version: 1, kind, orgId: ORG_ID, siteIds }
      : { version: 1, kind, orgId: ORG_ID },
    principalUserId: USER_ID,
    capturedAt: new Date('2026-09-30T05:18:00.000Z'),
    fingerprint: kind === 'restricted' ? 'a'.repeat(64) : 'f'.repeat(64),
  };
}

const ORG_ROW = [{ id: ORG_ID, name: 'Acme Legal', partnerId: PARTNER_ID }];
const ACTIVE_INTEGRATION = [{
  id: '44444444-4444-4444-8444-444444444444',
  lastSyncAt: new Date('2026-09-30T05:00:00.000Z'),
  lastSyncStatus: 'ok',
}];

const PERIOD_SEP: EvidenceRunContext = {
  periodStart: '2026-09-01',
  periodEnd: '2026-09-30',
  generatedAt: '2026-09-30T05:18:00.000Z',
  deliverableId: 'd0000000-0000-4000-8000-0000000000d1',
};

function incidentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e0000000-0000-4000-8000-000000000001',
    deviceId: 'd0000000-0000-4000-8000-000000000001',
    hostname: 'host-1',
    severity: 'high',
    category: 'malware',
    title: 'Suspicious process',
    status: 'open',
    reportedAt: new Date('2026-09-10T00:00:00.000Z'),
    resolvedAt: null,
    recommendation: 'Isolate the host',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateThreatDetectionReport', () => {
  it('renders a whole-report data gap when no active Huntress integration exists', async () => {
    queueSelects(ORG_ROW, /* devices */ [], /* integration */ []);
    const res = await generateThreatDetectionReport(ORG_ID, {}, authority());
    const s = summaryOf(res);
    expect(s.coverage?.sourceStatus).toBe('not_connected');
    // The load-bearing assertion: unmeasured, NOT zero.
    expect(s.incidents?.opened).toBeNull();
    expect(s.incidents?.resolved).toBeNull();
    expect(s.agentCoverage?.huntressAgents).toBeNull();
    // Breeze's own fleet count IS measured and stays a number: the reader
    // learns the size of the unmonitored fleet rather than seeing nothing.
    expect(s.agentCoverage?.breezeDevices).toBe(0);
    expect(res.rows).toEqual([]);
    expect(s.dataGaps?.join(' ')).toMatch(/not connected/i);
    expect(s.dataGaps?.join(' ')).not.toMatch(/\bno incidents\b/i);
  });

  it('reports never_synced rather than zero when the integration has never run', async () => {
    queueSelects(
      ORG_ROW,
      [],
      [{ id: ACTIVE_INTEGRATION[0]!.id, lastSyncAt: null, lastSyncStatus: null }],
    );
    const s = summaryOf(await generateThreatDetectionReport(ORG_ID, {}, authority()));
    expect(s.coverage?.sourceStatus).toBe('never_synced');
    expect(s.incidents?.opened).toBeNull();
  });

  it('uses the occurrence period, not now(), when an evidence context is given', async () => {
    queueSelects(ORG_ROW, [], ACTIVE_INTEGRATION, [], [], [], [], [], []);
    const s = summaryOf(
      await generateThreatDetectionReport(ORG_ID, {}, authority(), PERIOD_SEP),
    );
    expect(s.coverage?.periodStart).toBe('2026-09-01');
    expect(s.coverage?.periodEnd).toBe('2026-09-30');
    // Generation is on the DUE DAY, so it precedes the period end.
    expect(s.coverage?.generatedAt).toBe('2026-09-30T05:18:00.000Z');
    expect(res0Generated(s)).toBe('2026-09-30T05:18:00.000Z');
  });

  it('states the actual coverage window when the integration synced mid-period', async () => {
    queueSelects(
      ORG_ROW,
      [],
      ACTIVE_INTEGRATION,
      [], // agents
      [], // window metrics
      [], // rows
      [], // carried in
      [{ earliest: new Date('2026-09-14T00:00:00.000Z') }],
    );
    const s = summaryOf(
      await generateThreatDetectionReport(ORG_ID, {}, authority(), PERIOD_SEP),
    );
    expect(s.coverage?.coveredFrom).toBe('2026-09-14T00:00:00.000Z');
    expect(s.dataGaps?.join(' ')).toMatch(/does not cover/i);
  });

  it('excludes unattributable incidents under a restricted authority and discloses the count', async () => {
    queueSelects(
      ORG_ROW,
      [],
      ACTIVE_INTEGRATION,
      [],
      [
        incidentRow({ id: 'i1', deviceId: null }),
        incidentRow({ id: 'i2', deviceId: 'd0000000-0000-4000-8000-000000000001' }),
      ],
      [incidentRow({ id: 'i2' })],
      [],
      [],
    );
    const res = await generateThreatDetectionReport(ORG_ID, {}, authority('restricted', [SITE_A]));
    expect((res.rows as ThreatIncidentRow[]).map((r) => r.id)).toEqual(['i2']);
    expect(summaryOf(res).coverage?.unattributableExcluded).toBe(1);
    expect(summaryOf(res).incidents?.opened).toBe(1);
  });

  it('includes unattributable incidents under an unrestricted authority', async () => {
    queueSelects(
      ORG_ROW,
      [],
      ACTIVE_INTEGRATION,
      [],
      [incidentRow({ id: 'i1', deviceId: null }), incidentRow({ id: 'i2' })],
      [incidentRow({ id: 'i1', deviceId: null, hostname: null }), incidentRow({ id: 'i2' })],
      [],
      [],
    );
    const res = await generateThreatDetectionReport(ORG_ID, {}, authority());
    expect((res.rows as ThreatIncidentRow[]).map((r) => r.id)).toEqual(['i1', 'i2']);
    expect(summaryOf(res).coverage?.unattributableExcluded).toBe(0);
  });

  it('pushes a site predicate in every query branch under a restricted authority', async () => {
    queueSelects(ORG_ROW, [], ACTIVE_INTEGRATION, [], [], [], [], [], []);
    await generateThreatDetectionReport(ORG_ID, {}, authority('restricted', [SITE_A]), PERIOD_SEP);
    // org, devices, integration, agents, window metrics, rows, carried-in, earliest
    expect(whereCalls).toHaveLength(8);
    // Every branch except the org and integration lookups filters by site
    // itself — including the device count that runs before the source check.
    const siteScopedBranches = whereCalls.filter((_, i) => i !== 0 && i !== 2);
    expect(siteScopedBranches).toHaveLength(6);
    siteScopedBranches.forEach((call, index) => {
      expect(containsValue(call, SITE_A), `site-scoped branch ${index + 1} lost its filter`).toBe(true);
    });
  });

  it('returns an empty-but-shaped result for a restricted authority with zero sites', async () => {
    queueSelects();
    const res = await generateThreatDetectionReport(ORG_ID, {}, authority('restricted', []));
    expect(res.rows).toEqual([]);
    expect(res.rowCount).toBe(0);
    expect(res.summary).toBeTruthy();
    expect(summaryOf(res).incidents?.opened).toBeNull();
  });

  it('never renders the raw details jsonb', async () => {
    const withDetails = incidentRow({ recommendation: 'Isolate the host' });
    queueSelects(
      ORG_ROW,
      [],
      ACTIVE_INTEGRATION,
      [],
      [withDetails],
      [{ ...withDetails, details: { secret: 'do-not-render' } }],
      [],
      [],
    );
    const res = await generateThreatDetectionReport(ORG_ID, {}, authority());
    expect(JSON.stringify(res)).not.toMatch(/do-not-render/);
    expect((res.rows as ThreatIncidentRow[])[0]?.recommendation).toBe('Isolate the host');
  });

  it('caps the incident table at topIncidents and discloses the number withheld', async () => {
    const metrics = Array.from({ length: 150 }, (_, i) => incidentRow({ id: `i${i}` }));
    const rows = metrics.slice(0, 100);
    queueSelects(ORG_ROW, [], ACTIVE_INTEGRATION, [], metrics, rows, [], []);
    const res = await generateThreatDetectionReport(ORG_ID, { topIncidents: 100 }, authority());
    expect(res.rows).toHaveLength(100);
    expect(summaryOf(res).coverage?.withheld).toBe(50);
  });

  it('counts severity and resolution from the window set, not the capped table', async () => {
    queueSelects(
      ORG_ROW,
      [],
      ACTIVE_INTEGRATION,
      [],
      [
        incidentRow({ id: 'i1', severity: 'critical', status: 'resolved', resolvedAt: new Date('2026-09-10T02:00:00.000Z') }),
        incidentRow({ id: 'i2', severity: 'low', status: 'open' }),
      ],
      [incidentRow({ id: 'i1' })],
      [],
      [],
    );
    const s = summaryOf(await generateThreatDetectionReport(ORG_ID, { topIncidents: 1 }, authority()));
    expect(s.incidents?.opened).toBe(2);
    expect(s.incidents?.resolved).toBe(1);
    expect(s.incidents?.bySeverity).toEqual({ critical: 1, low: 1 });
    expect(s.incidents?.meanResolveHours).toBe(2);
  });

  it('reports mean resolution as null, not zero, when nothing was resolved in the period', async () => {
    queueSelects(ORG_ROW, [], ACTIVE_INTEGRATION, [], [incidentRow()], [incidentRow()], [], []);
    const s = summaryOf(await generateThreatDetectionReport(ORG_ID, {}, authority()));
    expect(s.incidents?.resolved).toBe(0);
    expect(s.incidents?.meanResolveHours).toBeNull();
  });

  it('skips the carried-in query when the config turns it off', async () => {
    queueSelects(ORG_ROW, [], ACTIVE_INTEGRATION, [], [], [], [], []);
    const s = summaryOf(
      await generateThreatDetectionReport(ORG_ID, { includeCarriedIn: false }, authority(), PERIOD_SEP),
    );
    expect(s.incidents?.carriedIn).toBeNull();
    expect(whereCalls).toHaveLength(7);
  });

  it('counts Huntress agent coverage against Breeze devices', async () => {
    queueSelects(
      ORG_ROW,
      [
        { id: 'd0000000-0000-4000-8000-000000000001' },
        { id: 'd0000000-0000-4000-8000-000000000002' },
        { id: 'd0000000-0000-4000-8000-000000000003' },
      ],
      ACTIVE_INTEGRATION,
      [
        { deviceId: 'd0000000-0000-4000-8000-000000000001', status: 'online' },
        { deviceId: 'd0000000-0000-4000-8000-000000000002', status: 'offline' },
      ],
      [], [], [], [],
    );
    const s = summaryOf(await generateThreatDetectionReport(ORG_ID, {}, authority()));
    expect(s.agentCoverage).toEqual({
      huntressAgents: 2,
      breezeDevices: 3,
      agentsOffline: 1,
      devicesWithoutAgent: 1,
    });
  });
});

function res0Generated(s: ThreatDetectionSummary): string | undefined {
  return s.generatedAt;
}

/** Drizzle SQL fragments are cyclic (a column points back at its table), so the
 *  bound site id has to be found by a guarded walk rather than JSON.stringify. */
function containsValue(node: unknown, needle: string, seen = new Set<unknown>()): boolean {
  if (node === needle) return true;
  if (node === null || typeof node !== 'object') return false;
  if (seen.has(node)) return false;
  seen.add(node);
  for (const value of Object.values(node as Record<string, unknown>)) {
    if (containsValue(value, needle, seen)) return true;
  }
  return false;
}
