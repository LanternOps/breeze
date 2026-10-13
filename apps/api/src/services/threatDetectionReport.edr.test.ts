/**
 * EDR provider framework (#8164 W02 / A11): the threat detection report gains
 * ADDITIVE EDR fields. The pre-change literals below were captured from the
 * generator's output BEFORE the EDR change, so a no-EDR org's persisted
 * snapshot must stay byte-for-byte what it was.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));

import { db } from '../db';
import type { OrgReportGenerationAuthority } from './siteScope';
import { generateThreatDetectionReport } from './threatDetectionReport';
import type { ThreatDetectionSummary } from '@breeze/shared';
import type { EvidenceRunContext, ReportResult } from './reportGenerationService';

const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
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
): OrgReportGenerationAuthority {
  return {
    principalKind: 'user',
    scope: kind === 'restricted'
      ? { version: 1, kind, orgId: 'o', siteIds }
      : { version: 1, kind, orgId: 'o' },
    principalUserId: 'u',
    capturedAt: new Date('2026-09-30T05:18:00.000Z'),
    fingerprint: kind === 'restricted' ? 'a'.repeat(64) : 'f'.repeat(64),
  };
}

const summaryOf = (r: ReportResult) => r.summary as ThreatDetectionSummary;
const PG = new PgDialect();
const render = (sql: unknown) => PG.sqlToQuery(sql as never);

const EV: EvidenceRunContext = {
  periodStart: '2026-09-01',
  periodEnd: '2026-09-30',
  generatedAt: '2026-09-30T05:18:00.000Z',
  deliverableId: 'x',
};
const ORG = [{ id: 'o', name: 'Acme', partnerId: 'p' }];
const SYNCED = [{
  id: 'g',
  lastSyncAt: new Date('2026-09-30T05:00:00.000Z'),
  lastSyncStatus: 'ok',
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
}];
const INC = {
  id: 'i1', deviceId: 'd1', hostname: 'host-1', severity: 'high', category: 'malware',
  title: 'T', status: 'open', reportedAt: new Date('2026-09-10T00:00:00.000Z'),
  resolvedAt: null, recommendation: 'Isolate',
};

const PRE_CHANGE_CONNECTED = {
  orgId: 'o', orgName: 'Acme', generatedAt: '2026-09-30T05:18:00.000Z',
  coverage: {
    periodStart: '2026-09-01', periodEnd: '2026-09-30', generatedAt: '2026-09-30T05:18:00.000Z',
    coveredFrom: '2026-08-01T00:00:00.000Z', coveredTo: '2026-09-30T05:00:00.000Z',
    sourceStatus: 'ok', lastSyncAt: '2026-09-30T05:00:00.000Z', lastSyncStatus: 'ok',
    unattributableExcluded: 0, withheld: 0, carriedInIncluded: true, note: '',
  },
  agentCoverage: { huntressAgents: 1, breezeDevices: 2, agentsOffline: 0, devicesWithoutAgent: 1 },
  incidents: {
    opened: 1, resolved: 0, bySeverity: { high: 1 }, byStatus: { open: 1 },
    meanResolveHours: null, medianResolveHours: null, carriedIn: 0,
  },
  rows: [{
    id: 'i1', reportedAt: '2026-09-10T00:00:00.000Z', hostname: 'host-1', severity: 'high',
    category: 'malware', title: 'T', status: 'open', resolvedAt: null, recommendation: 'Isolate',
  }],
  dataGaps: [],
};
const NOT_CONNECTED_NOTE = 'Huntress is not connected for this partner, so threat detection was not measured for this period.';
const PRE_CHANGE_NOT_CONNECTED = {
  orgId: 'o', orgName: 'Acme', generatedAt: '2026-09-30T05:18:00.000Z',
  coverage: {
    periodStart: '2026-09-01', periodEnd: '2026-09-30', generatedAt: '2026-09-30T05:18:00.000Z',
    sourceStatus: 'not_connected', lastSyncAt: null, lastSyncStatus: null,
    unattributableExcluded: 0, withheld: 0, note: NOT_CONNECTED_NOTE,
  },
  agentCoverage: { huntressAgents: null, breezeDevices: 1, agentsOffline: null, devicesWithoutAgent: null },
  incidents: {
    opened: null, resolved: null, bySeverity: null, byStatus: null,
    meanResolveHours: null, medianResolveHours: null, carriedIn: null,
  },
  rows: [],
  dataGaps: [NOT_CONNECTED_NOTE],
};
const NEVER_SYNCED_NOTE = 'Huntress is connected but has never completed a sync, so threat detection was not measured for this period.';
const PRE_CHANGE_NEVER_SYNCED = {
  ...PRE_CHANGE_NOT_CONNECTED,
  coverage: { ...PRE_CHANGE_NOT_CONNECTED.coverage, sourceStatus: 'never_synced', note: NEVER_SYNCED_NOTE },
  dataGaps: [NEVER_SYNCED_NOTE],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateThreatDetectionReport: EDR coverage (additive)', () => {
  it('a no-EDR org (connected Huntress) is deep-equal to the pre-change output', async () => {
    queueSelects(ORG, [{ id: 'd1' }, { id: 'd2' }], SYNCED, [{ deviceId: 'd1', status: 'online' }], [INC], [INC], [], [{ earliest: null }]);
    const res = await generateThreatDetectionReport('o', {}, authority(), EV);
    expect(JSON.parse(JSON.stringify(res.summary))).toEqual(PRE_CHANGE_CONNECTED);
    // Absent, not merely undefined: the persisted JSON must not gain keys.
    expect(Object.keys((res.summary as { agentCoverage: object }).agentCoverage)).not.toContain('edrEndpoints');
    expect(Object.keys(res.summary ?? {})).not.toContain('edrDetections');
  });

  it('a no-EDR org with no Huntress is deep-equal to the pre-change data-gap output', async () => {
    queueSelects(ORG, [{ id: 'd1' }], []);
    const res = await generateThreatDetectionReport('o', {}, authority(), EV);
    expect(JSON.parse(JSON.stringify(res.summary))).toEqual(PRE_CHANGE_NOT_CONNECTED);
  });

  it('a no-EDR org whose Huntress never synced is deep-equal to the pre-change output', async () => {
    queueSelects(ORG, [{ id: 'd1' }], [{ id: 'g', lastSyncAt: null, lastSyncStatus: null }]);
    const res = await generateThreatDetectionReport('o', {}, authority(), EV);
    expect(JSON.parse(JSON.stringify(res.summary))).toEqual(PRE_CHANGE_NEVER_SYNCED);
  });

  it('an EDR-only org (no Huntress integration) is not short-circuited to the data gap', async () => {
    queueSelects(
      ORG, [{ id: 'd1' }, { id: 'd2' }], [],
      /* edr endpoints */ [{ total: 2 }],
      /* edr open detections by severity */ [{ severity: 'high', total: 2 }, { severity: 'low', total: 1 }],
    );
    const s = summaryOf(await generateThreatDetectionReport('o', {}, authority(), EV));
    expect(s.agentCoverage?.edrEndpoints).toBe(2);
    expect(s.edrDetections).toEqual({ open: 3, bySeverity: { high: 2, low: 1 } });
    // Huntress-derived values stay unmeasured, never zero.
    expect(s.incidents?.opened).toBeNull();
    expect(s.agentCoverage?.huntressAgents).toBeNull();
    expect(s.coverage?.sourceStatus).toBe('not_connected');
  });

  it('an EDR-only org whose Huntress never synced also gets the EDR fields', async () => {
    queueSelects(
      ORG, [{ id: 'd1' }], [{ id: 'g', lastSyncAt: null, lastSyncStatus: null }],
      [{ total: 1 }], [],
    );
    const s = summaryOf(await generateThreatDetectionReport('o', {}, authority(), EV));
    expect(s.coverage?.sourceStatus).toBe('never_synced');
    expect(s.agentCoverage?.edrEndpoints).toBe(1);
    expect(s.edrDetections).toEqual({ open: 0, bySeverity: {} });
  });

  it('an EDR org with endpoints and no open detections reports a measured zero', async () => {
    queueSelects(ORG, [{ id: 'd1' }], SYNCED, [], [], [], [], [{ earliest: null }], [{ total: 4 }], []);
    const s = summaryOf(await generateThreatDetectionReport('o', {}, authority(), EV));
    expect(s.agentCoverage?.edrEndpoints).toBe(4);
    expect(s.edrDetections).toEqual({ open: 0, bySeverity: {} });
  });

  it('adds EDR fields alongside a connected Huntress org', async () => {
    queueSelects(
      ORG, [{ id: 'd1' }], SYNCED, [], [], [], [], [{ earliest: null }],
      [{ total: 1 }], [{ severity: 'critical', total: 1 }],
    );
    const s = summaryOf(await generateThreatDetectionReport('o', {}, authority(), EV));
    expect(s.incidents?.opened).toBe(0);
    expect(s.agentCoverage?.edrEndpoints).toBe(1);
    expect(s.edrDetections).toEqual({ open: 1, bySeverity: { critical: 1 } });
  });

  it('excludes tombstoned detections and only counts open statuses, scoped to the org', async () => {
    queueSelects(ORG, [{ id: 'd1' }], [], [{ total: 1 }], []);
    await generateThreatDetectionReport('o', {}, authority(), EV);
    // where #0 org, #1 devices, #2 integration, #3 edr endpoints, #4 edr detections
    const detectionWhere = render(whereCalls[4]![0]);
    expect(detectionWhere.sql).toMatch(/"edr_detections"\."detached_at" is null/i);
    expect(detectionWhere.sql).toMatch(/"edr_detections"\."status" in/i);
    expect(detectionWhere.sql).toMatch(/"edr_detections"\."org_id" = /i);
    expect(detectionWhere.params).toEqual(expect.arrayContaining(['open', 'in_progress', 'unknown', 'o']));
    const endpointWhere = render(whereCalls[3]![0]);
    expect(endpointWhere.sql).toMatch(/"edr_endpoints"\."org_id" = /i);
  });

  it('pushes the site predicate into both EDR queries under a restricted authority', async () => {
    queueSelects(ORG, [{ id: 'd1' }], [], [{ total: 1 }], []);
    await generateThreatDetectionReport('o', {}, authority('restricted', [SITE_A]));
    expect(render(whereCalls[3]![0]).params).toContain(SITE_A);
    expect(render(whereCalls[4]![0]).params).toContain(SITE_A);
  });
});
