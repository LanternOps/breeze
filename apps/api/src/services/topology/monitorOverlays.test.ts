import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { graphNodeSchema } from '@breeze/shared';
import type { TopologyRequestContext } from './access';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), transaction: vi.fn() }));
vi.mock('../../db', () => ({ db: { execute: mocks.execute, transaction: mocks.transaction } }));

import { readTopologyMonitorOverlays, overlayHealthSummary, type MonitorBindingRow } from './monitorOverlays';

const ORG = '10000000-0000-4000-8000-000000000001';
const SITE = '20000000-0000-4000-8000-000000000001';
const OTHER_SITE = '20000000-0000-4000-8000-000000000002';
const NODE = '30000000-0000-4000-8000-000000000001';
const REL = '40000000-0000-4000-8000-000000000001';
const MONITOR = '60000000-0000-4000-8000-000000000001';
const SECOND_MONITOR = '60000000-0000-4000-8000-000000000002';
const RESULT = '70000000-0000-4000-8000-000000000001';
const DEVICE = '80000000-0000-4000-8000-000000000001';
const ORIGIN_NODE = '30000000-0000-4000-8000-000000000009';
const BINDING = '90000000-0000-4000-8000-000000000001';

const dialect = new PgDialect();
function sqlText(call: unknown[]) {
  return dialect.sqlToQuery(call[0] as Parameters<PgDialect['sqlToQuery']>[0]);
}

function context(overrides: {
  permissions?: { resource: string; action: string }[];
  allowedSiteIds?: string[];
} = {}): TopologyRequestContext {
  const permissions = overrides.permissions ?? [
    { resource: 'topology', action: 'read' },
    { resource: 'devices', action: 'read' },
    { resource: 'alerts', action: 'read' },
  ];
  return {
    auth: { orgId: ORG, allowedSiteIds: overrides.allowedSiteIds, canAccessOrg: () => true },
    permissions: { scope: 'organization', orgId: ORG, permissions },
    scope: { orgId: ORG, siteId: SITE },
  } as unknown as TopologyRequestContext;
}

const NOW = new Date('2026-09-17T12:00:00.000Z');
const RECENT = new Date(NOW.getTime() - 20_000).toISOString();
const OLD = new Date(NOW.getTime() - 3_600_000).toISOString();

function bindingRow(overrides: Partial<MonitorBindingRow> = {}): MonitorBindingRow {
  return {
    bindingId: BINDING,
    nodeId: NODE,
    relationshipId: null,
    contextKey: 'default',
    family: 'ipv4',
    metricRole: 'connectivity',
    originDeviceId: DEVICE,
    originNodeId: ORIGIN_NODE,
    originSiteId: SITE,
    monitorId: MONITOR,
    monitorName: 'Gateway ping',
    monitorType: 'icmp_ping',
    monitorTarget: '192.0.2.1',
    monitorActive: true,
    pollingInterval: 60,
    resultId: RESULT,
    resultStatus: 'online',
    resultDeviceId: DEVICE,
    resultAt: RECENT,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.execute.mockReset();
  mocks.execute.mockResolvedValue([]);
});

describe('readTopologyMonitorOverlays binding query', () => {
  it('binds org and site on both the binding and the monitor so a null-site legacy monitor cannot match', async () => {
    await readTopologyMonitorOverlays(context(), [{ kind: 'node', id: NODE }], { now: NOW });

    const query = sqlText(mocks.execute.mock.calls[0]!);
    expect(query.params).toContain(ORG);
    expect(query.params).toContain(SITE);
    expect(query.sql).toMatch(/m\.org_id\s*=/);
    expect(query.sql).toMatch(/m\.site_id\s*=/);
    expect(query.sql).toMatch(/m\.site_id is not null/i);
    // Reuse is only ever reached through the canonical binding table.
    expect(query.sql).toMatch(/topology_monitor_bindings/);
    expect(query.sql).not.toMatch(/ip_address|target\s*=\s*\$/i);
  });

  it('restricts the reused result to the binding origin device', async () => {
    await readTopologyMonitorOverlays(context(), [{ kind: 'node', id: NODE }], { now: NOW });

    const query = sqlText(mocks.execute.mock.calls[0]!);
    expect(query.sql).toMatch(/origin_policy->>'deviceId'/);
    expect(query.sql).toMatch(/network_monitor_results/);
  });

  it('makes no database call for an empty subject list', async () => {
    expect(await readTopologyMonitorOverlays(context(), [], { now: NOW })).toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe('readTopologyMonitorOverlays attribution', () => {
  it('reports a fresh online monitor as healthy and names the supplying monitor', async () => {
    mocks.execute.mockResolvedValueOnce([bindingRow()]).mockResolvedValueOnce([{ monitorId: MONITOR, count: '0' }]);

    const [overlay] = await readTopologyMonitorOverlays(context(), [{ kind: 'node', id: NODE }], { now: NOW });

    expect(overlay).toMatchObject({ status: 'healthy', coverage: 'monitored', freshness: 'fresh' });
    expect(overlay?.subject).toEqual({ kind: 'node', id: NODE });
    expect(overlay?.provenance).toMatchObject({
      monitorId: MONITOR, monitorName: 'Gateway ping', monitorType: 'icmp_ping',
      destination: '192.0.2.1', resultId: RESULT, originDeviceId: DEVICE, originNodeId: ORIGIN_NODE,
      observedAt: RECENT,
    });
    expect(overlay?.activeAlertCount).toBe(0);
    // M3-D10: the fresh result lapses max(3 × 60 s, 60 s) after observation, without a revision write.
    expect(overlay?.freshUntil).toBe(new Date(Date.parse(RECENT) + 180_000).toISOString());
  });

  it('downgrades an offline monitor to a failed check and a degraded monitor to degraded', async () => {
    mocks.execute.mockResolvedValueOnce([
      bindingRow({ resultStatus: 'offline' }),
      bindingRow({ bindingId: '90000000-0000-4000-8000-000000000002', relationshipId: REL, nodeId: null, monitorId: SECOND_MONITOR, resultStatus: 'degraded' }),
    ]).mockResolvedValueOnce([]);

    const overlays = await readTopologyMonitorOverlays(
      context(), [{ kind: 'node', id: NODE }, { kind: 'relationship', id: REL }], { now: NOW },
    );

    expect(overlays.map((overlay) => overlay.status)).toEqual(['failed_check', 'degraded']);
    expect(overlays[1]?.subject).toEqual({ kind: 'relationship', id: REL });
  });

  it('treats a result older than the monitor cadence window as stale, not as current health', async () => {
    mocks.execute.mockResolvedValueOnce([bindingRow({ resultAt: OLD })]).mockResolvedValueOnce([]);

    const [overlay] = await readTopologyMonitorOverlays(context(), [{ kind: 'node', id: NODE }], { now: NOW });

    expect(overlay).toMatchObject({ status: 'unknown', coverage: 'partial', freshness: 'stale' });
    expect(overlay?.reasons).toContain('stale_monitor_result');
  });

  it('reports a bound monitor that has never produced a result as unmonitored', async () => {
    mocks.execute.mockResolvedValueOnce([
      bindingRow({ resultId: null, resultStatus: null, resultDeviceId: null, resultAt: null }),
    ]).mockResolvedValueOnce([]);

    const [overlay] = await readTopologyMonitorOverlays(context(), [{ kind: 'node', id: NODE }], { now: NOW });

    expect(overlay).toMatchObject({ status: 'unknown', coverage: 'unmonitored', freshness: 'unknown' });
    expect(overlay?.reasons).toContain('no_monitor_result');
  });

  it('refuses to reuse a monitor whose protocol does not match the bound metric role', async () => {
    mocks.execute.mockResolvedValueOnce([bindingRow({ monitorType: 'http_check' })]).mockResolvedValueOnce([]);

    const [overlay] = await readTopologyMonitorOverlays(context(), [{ kind: 'node', id: NODE }], { now: NOW });

    expect(overlay).toMatchObject({ status: 'unknown', coverage: 'unmonitored' });
    expect(overlay?.reasons).toContain('protocol_mismatch');
    expect(overlay?.provenance.resultId).toBeNull();
  });

  it('refuses to reuse a monitor whose literal destination is the wrong address family', async () => {
    mocks.execute.mockResolvedValueOnce([bindingRow({ family: 'ipv6' })]).mockResolvedValueOnce([]);

    const [overlay] = await readTopologyMonitorOverlays(context(), [{ kind: 'node', id: NODE }], { now: NOW });

    expect(overlay?.reasons).toContain('family_mismatch');
    expect(overlay?.coverage).toBe('unmonitored');
  });

  it('reports a disabled monitor as unmonitored rather than healthy', async () => {
    mocks.execute.mockResolvedValueOnce([bindingRow({ monitorActive: false })]).mockResolvedValueOnce([]);

    const [overlay] = await readTopologyMonitorOverlays(context(), [{ kind: 'node', id: NODE }], { now: NOW });

    expect(overlay).toMatchObject({ status: 'unknown', coverage: 'unmonitored' });
    expect(overlay?.reasons).toContain('monitor_disabled');
  });

  it('keeps the freshest of duplicate compatible bindings for one subject and context', async () => {
    mocks.execute.mockResolvedValueOnce([
      bindingRow({ bindingId: '90000000-0000-4000-8000-00000000000a', resultAt: OLD, resultStatus: 'offline' }),
      bindingRow({ bindingId: '90000000-0000-4000-8000-00000000000b', monitorId: SECOND_MONITOR, resultAt: RECENT }),
    ]).mockResolvedValueOnce([]);

    const overlays = await readTopologyMonitorOverlays(context(), [{ kind: 'node', id: NODE }], { now: NOW });

    expect(overlays).toHaveLength(1);
    expect(overlays[0]?.provenance.monitorId).toBe(SECOND_MONITOR);
    expect(overlays[0]?.status).toBe('healthy');
  });
});

describe('readTopologyMonitorOverlays authorization', () => {
  it('filters alerts by the reader site scope before counting them', async () => {
    mocks.execute.mockResolvedValueOnce([bindingRow()]).mockResolvedValueOnce([{ monitorId: MONITOR, count: '2' }]);

    const [overlay] = await readTopologyMonitorOverlays(
      context({ allowedSiteIds: [SITE] }), [{ kind: 'node', id: NODE }], { now: NOW },
    );

    const alertQuery = sqlText(mocks.execute.mock.calls[1]!);
    expect(alertQuery.sql).toMatch(/"devices"\."site_id" in/);
    expect(alertQuery.params).toContain(SITE);
    expect(alertQuery.sql).toMatch(/count\(/i);
    expect(overlay?.activeAlertCount).toBe(2);
  });

  it('withholds the alert count rather than reporting zero when alert reads are denied', async () => {
    mocks.execute.mockResolvedValueOnce([bindingRow()]);

    const [overlay] = await readTopologyMonitorOverlays(
      context({ permissions: [{ resource: 'topology', action: 'read' }, { resource: 'devices', action: 'read' }] }),
      [{ kind: 'node', id: NODE }],
      { now: NOW },
    );

    expect(overlay?.activeAlertCount).toBeNull();
    expect(overlay?.reasons).toContain('alert_counts_restricted');
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it('withholds monitor detail when the reader may not read monitors', async () => {
    mocks.execute.mockResolvedValueOnce([bindingRow()]).mockResolvedValueOnce([]);

    const [overlay] = await readTopologyMonitorOverlays(
      context({ permissions: [{ resource: 'topology', action: 'read' }, { resource: 'alerts', action: 'read' }] }),
      [{ kind: 'node', id: NODE }],
      { now: NOW },
    );

    expect(overlay?.provenance.monitorName).toBeNull();
    expect(overlay?.provenance.destination).toBeNull();
    expect(overlay?.reasons).toContain('monitor_detail_restricted');
    // The measurement itself is still attributable to its result.
    expect(overlay?.provenance.resultId).toBe(RESULT);
  });

  it('hides an origin device the reader cannot see without discarding the measurement', async () => {
    mocks.execute.mockResolvedValueOnce([bindingRow({ originSiteId: OTHER_SITE })]).mockResolvedValueOnce([]);

    const [overlay] = await readTopologyMonitorOverlays(
      context({ allowedSiteIds: [SITE] }), [{ kind: 'node', id: NODE }], { now: NOW },
    );

    expect(overlay?.provenance.originDeviceId).toBeNull();
    expect(overlay?.provenance.originNodeId).toBeNull();
    expect(overlay?.reasons).toContain('origin_not_visible');
    expect(overlay?.status).toBe('healthy');
  });
});

describe('overlayHealthSummary', () => {
  it('produces the wire health summary the graph projection already publishes', () => {
    const summary = overlayHealthSummary('node', {
      subject: { kind: 'node', id: NODE },
      bindingId: BINDING,
      contextKey: 'default',
      family: 'ipv4',
      metricRole: 'connectivity',
      status: 'healthy',
      coverage: 'monitored',
      freshness: 'fresh',
      reasons: [],
      activeAlertCount: 0,
      provenance: {
        monitorId: MONITOR, monitorName: 'Gateway ping', monitorType: 'icmp_ping', destination: '192.0.2.1',
        runId: null, resultId: RESULT, originDeviceId: DEVICE, originNodeId: ORIGIN_NODE, observedAt: RECENT,
      },
      freshUntil: null,
    });

    expect(summary).toEqual({
      status: 'healthy', coverage: 'monitored', scope: 'node',
      originNodeId: ORIGIN_NODE, resultId: RESULT, reasons: [], freshness: 'fresh',
    });
    expect(graphNodeSchema.shape.health.safeParse(summary).success).toBe(true);
  });

  it('always carries a reason when it publishes an unknown status', () => {
    const summary = overlayHealthSummary('relationship', undefined);

    expect(summary.status).toBe('unknown');
    expect(summary.coverage).toBe('unmonitored');
    expect(summary.reasons.length).toBeGreaterThan(0);
    expect(graphNodeSchema.shape.health.safeParse(summary).success).toBe(true);
  });
});
