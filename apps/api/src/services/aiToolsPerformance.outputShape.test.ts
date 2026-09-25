// #6745 (A-W05 follow-up): analyze_metrics + analyze_boot_performance output shape.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefaultPageFits } from './aiToolOutputBudget.testkit';
import { compactToolResultForChat } from './aiToolOutput';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));
vi.mock('./aiDispatch', () => ({ aiExecuteCommand: vi.fn() }));

import { db } from '../db';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerPerformanceTools } from './aiToolsPerformance';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE = { id: DEVICE_ID, orgId: ORG_ID, siteId: 'site-1', hostname: 'host-1', status: 'online', osType: 'windows' };

function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'groupBy', 'orderBy', 'limit', 'innerJoin']) c[m] = vi.fn(() => c);
  c.then = (ok?: (v: unknown) => unknown, bad?: (r: unknown) => unknown) => Promise.resolve(result).then(ok, bad);
  return c;
}
const selectOnce = (result: unknown) => mockDb.select.mockImplementationOnce(() => chain(result));

function tools(): Map<string, AiTool> {
  const reg = new Map<string, AiTool>();
  registerPerformanceTools(reg);
  return reg;
}
const auth = () => ({
  user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
  token: {}, partnerId: null, orgId: ORG_ID, scope: 'organization', accessibleOrgIds: [ORG_ID],
  orgCondition: () => undefined, canAccessOrg: () => true, canAccessSite: () => true,
}) as unknown as AuthContext;

/** A full `device_metrics` row as `select()` returns it — including the jsonb/bigint columns the tool used to echo verbatim. */
function fullMetricRow(i: number) {
  return {
    deviceId: DEVICE_ID, orgId: ORG_ID,
    timestamp: new Date(Date.UTC(2026, 8, 20, 10, 0, 0) - i * 60_000),
    cpuPercent: 12.3456 + i, ramPercent: 56.789, ramUsedMb: 8123, diskPercent: 61.2345, diskUsedGb: 412.5,
    diskActivityAvailable: true, diskReadBytes: 123456789n, diskWriteBytes: 98765432n,
    diskReadBps: 123456n, diskWriteBps: 65432n, diskReadOps: 1234n, diskWriteOps: 4321n,
    networkInBytes: 987654321n, networkOutBytes: 123456789n, bandwidthInBps: 1234567n, bandwidthOutBps: 765432n,
    interfaceStats: [
      { name: 'Ethernet 2 - Intel(R) Ethernet Connection I219-LM', inBytesPerSec: 1234567, outBytesPerSec: 765432, inBytes: 987654321, outBytes: 123456789, inPackets: 12345, outPackets: 6789, inErrors: 0, outErrors: 0, speed: 1000000000 },
    ],
    processCount: 312,
    customMetrics: { someCollector: { value: 42, unit: 'things' } },
  };
}

function rollupRow(i: number) {
  return {
    timestamp: new Date(Date.UTC(2026, 8, 20, 10, 0, 0) - i * 3_600_000),
    cpuPercent: 12.3456 + i, ramPercent: 56.789, ramUsedMb: 8123.45, diskPercent: 61.2345, diskUsedGb: 412.5, sampleCount: 60,
  };
}

describe('analyze_metrics output shape (#6745)', () => {
  const tool = tools().get('analyze_metrics')!;
  beforeEach(() => { vi.clearAllMocks(); });

  it('declares a limit with the shared "(default N, max M)" text', () => {
    const props = (tool.definition.input_schema as { properties: Record<string, { description: string }> }).properties;
    expect(props.limit!.description).toMatch(/^Max data points.*\(default 40, max 500\)$/);
  });

  it('the default raw call projects points to metric columns (no jsonb/bigint noise) and fits the budget', async () => {
    selectOnce([DEVICE]);
    selectOnce(Array.from({ length: 500 }, (_, i) => fullMetricRow(i)));
    const raw = await tool.handler({ deviceId: DEVICE_ID }, auth());
    const out = JSON.parse(raw) as Record<string, any>;
    expect(out.metrics).toHaveLength(40);
    expect(out.limit).toBe(40);
    expect(out.showing).toBe(40);
    expect(out.pointsInWindow).toBe(500);
    expect(out.hasMore).toBe(true);
    // The hint names only parameters this tool accepts.
    expect(out.note).toMatch(/hoursBack/);
    expect(out.note).toMatch(/aggregation/);
    expect(Object.keys(out.metrics[0]).sort()).toEqual(
      ['bandwidthInBps', 'bandwidthOutBps', 'cpuPercent', 'diskPercent', 'ramPercent', 'timestamp'].sort(),
    );
    expect(raw).not.toContain('interfaceStats');
    expect(raw).not.toContain('customMetrics');
    expectDefaultPageFits('analyze_metrics', raw);
  });

  it('honours `metric` in the raw projection', async () => {
    selectOnce([DEVICE]);
    selectOnce(Array.from({ length: 3 }, (_, i) => fullMetricRow(i)));
    const out = JSON.parse(await tool.handler({ deviceId: DEVICE_ID, metric: 'network' }, auth())) as Record<string, any>;
    expect(Object.keys(out.metrics[0]).sort()).toEqual(['bandwidthInBps', 'bandwidthOutBps', 'timestamp']);
    expect(out.hasMore).toBe(false);
    expect(out.note).toBeUndefined();
  });

  it('a 7-day hourly rollup series is paged to the default and fits the budget', async () => {
    selectOnce([DEVICE]);
    selectOnce(Array.from({ length: 168 }, (_, i) => rollupRow(i)));
    const raw = await tool.handler({ deviceId: DEVICE_ID, hoursBack: 168 }, auth());
    const out = JSON.parse(raw) as Record<string, any>;
    expect(out.source).toBe('metric_rollups');
    expect(out.buckets).toHaveLength(40);
    expect(out.pointsInWindow).toBe(168);
    expect(out.hasMore).toBe(true);
    // Summary still covers the whole window, not just the returned page.
    expect(out.summary.dataPoints).toBe(168 * 60);
    expectDefaultPageFits('analyze_metrics', raw);
  });

  it('the device_metrics fallback (no rollups) pages its in-memory buckets too', async () => {
    selectOnce([DEVICE]);
    selectOnce([]); // no rollups for the window
    // 200 raw rows one hour apart -> 200 hourly buckets.
    selectOnce(Array.from({ length: 200 }, (_, i) => ({ ...fullMetricRow(0), timestamp: new Date(Date.UTC(2026, 8, 20, 10) - i * 3_600_000) })));
    const out = JSON.parse(await tool.handler({ deviceId: DEVICE_ID, hoursBack: 168, aggregation: 'hourly' }, auth())) as Record<string, any>;
    expect(out.source).toBe('device_metrics');
    expect(out.buckets).toHaveLength(40);
    expect(out.pointsInWindow).toBe(200);
    expect(out.hasMore).toBe(true);
  });

  it('an explicit large limit that compacts still carries limit/hasMore', async () => {
    selectOnce([DEVICE]);
    selectOnce(Array.from({ length: 500 }, (_, i) => fullMetricRow(i)));
    const raw = await tool.handler({ deviceId: DEVICE_ID, limit: 500 }, auth());
    const compacted = JSON.parse(compactToolResultForChat('analyze_metrics', raw)) as Record<string, unknown>;
    expect(compacted.limit).toBe(500);
    expect(typeof compacted.hasMore).toBe('boolean');
  });
});

function startupItem(i: number) {
  return {
    itemId: `run:HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run\\Vendor Updater ${i}`,
    name: `Vendor Updater Service ${i}`,
    type: 'registry_run',
    path: `"C:\\Program Files (x86)\\Some Very Long Vendor Name\\Updater Suite ${i}\\bin\\updater-helper.exe" --background --silent --channel=stable`,
    enabled: true,
    cpuTimeMs: 1234 + i,
    diskIoBytes: 12_345_678 + i,
    impactScore: 70 - i,
  };
}

function bootRecord(i: number, items: unknown[]) {
  return {
    id: `b-${i}`, deviceId: DEVICE_ID, orgId: ORG_ID,
    bootTimestamp: new Date(Date.UTC(2026, 8, 20 - i, 8, 0, 0)),
    biosSeconds: 8.5, osLoaderSeconds: 12.25, desktopReadySeconds: 45.75, totalBootSeconds: 66.5 + i,
    startupItemCount: items.length, startupItems: items, createdAt: new Date(),
  };
}

describe('analyze_boot_performance output shape (#6745)', () => {
  const tool = tools().get('analyze_boot_performance')!;
  beforeEach(() => { vi.clearAllMocks(); });

  it('omits startup-item paths unless includePaths, and fits the budget with 30 boots and 80 items', async () => {
    const items = Array.from({ length: 80 }, (_, i) => startupItem(i));
    selectOnce([DEVICE]);
    selectOnce(Array.from({ length: 30 }, (_, i) => bootRecord(i, items)));
    const raw = await tool.handler({ deviceId: DEVICE_ID, bootsBack: 30 }, auth());
    const out = JSON.parse(raw) as Record<string, any>;
    expect(out.latestBoot.topImpactItems).toHaveLength(10);
    expect(out.latestBoot.topImpactItems[0].path).toBeUndefined();
    expect(out.latestBoot.topImpactItems[0].itemId).toBeDefined();
    expect(out.latestBoot.startupItemsNotShown).toBe(70);
    expectDefaultPageFits('analyze_boot_performance', raw);
  });

  it('includePaths=true returns the paths', async () => {
    const items = Array.from({ length: 3 }, (_, i) => startupItem(i));
    selectOnce([DEVICE]);
    selectOnce([bootRecord(0, items)]);
    const out = JSON.parse(await tool.handler({ deviceId: DEVICE_ID, includePaths: true }, auth())) as Record<string, any>;
    expect(out.latestBoot.topImpactItems[0].path).toContain('updater-helper.exe');
    expect(out.latestBoot.startupItemsNotShown).toBe(0);
  });
});
