// #6745 (A-W05 follow-up): search_logs + get_log_trends output shape.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefaultPageFits, fixtureRow } from './aiToolOutputBudget.testkit';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
}));

const logSearchMock = vi.hoisted(() => ({
  searchFleetLogs: vi.fn(),
  getLogTrends: vi.fn(),
  getLogAggregation: vi.fn(),
  detectPatternCorrelation: vi.fn(),
  resolveSingleOrgId: vi.fn(),
}));
vi.mock('./logSearch', () => logSearchMock);
// Only reached by a site-restricted auth (the zero-device short-circuit test).
vi.mock('./aiToolsSiteScope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./aiToolsSiteScope')>()),
  resolveSiteAllowedDeviceIds: vi.fn(async () => []),
}));

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerEventLogTools } from './aiToolsEventLogs';

function tools(): Map<string, AiTool> {
  const reg = new Map<string, AiTool>();
  registerEventLogTools(reg);
  return reg;
}
const auth = () => ({
  user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
  token: {}, partnerId: null, orgId: 'org-1', scope: 'organization', accessibleOrgIds: ['org-1'],
  orgCondition: () => undefined, canAccessOrg: () => true,
}) as unknown as AuthContext;

// A realistic Windows event message: several sentences, well past the per-row budget.
const LONG_MESSAGE = 'The Service Control Manager tried to take a corrective action (Restart the service) after the unexpected termination of the Windows Update Medic Service service, but this action failed with the following error: Access is denied. '.repeat(3);

function logRow(i: number) {
  const f = fixtureRow(i, { id: 'id', deviceId: 'id', siteId: 'id' });
  return {
    log: {
      id: f.id, orgId: 'org-1', deviceId: f.deviceId,
      timestamp: new Date(Date.UTC(2026, 8, 20, 10, i % 60, 0)),
      level: 'error', category: 'system', source: 'Service Control Manager', eventId: '7031',
      message: LONG_MESSAGE, details: { raw: 'x'.repeat(200) }, createdAt: new Date(),
    },
    device: { id: f.deviceId, hostname: `WKSTN-ACCOUNTING-${i}`, displayName: `Accounting Workstation ${i}`, siteId: f.siteId },
    site: { id: f.siteId, name: 'Main Office - Building A' },
  };
}

describe('search_logs output shape (#6745)', () => {
  const tool = tools().get('search_logs')!;
  beforeEach(() => { vi.clearAllMocks(); });

  it('declares the default limit it applies', () => {
    const props = (tool.definition.input_schema as { properties: Record<string, { description: string }> }).properties;
    expect(props.limit!.description).toBe('Maximum rows to return (default 12, max 500)');
  });

  it('a default page of realistic rows trims messages, drops duplicate device fields and fits the budget', async () => {
    logSearchMock.searchFleetLogs.mockImplementation(async (_a: unknown, f: { limit: number }) => ({
      results: Array.from({ length: f.limit }, (_, i) => logRow(i)),
      total: 5000, totalMode: 'exact', limit: f.limit, offset: 0, hasMore: true, nextCursor: 'c1',
    }));
    const raw = await tool.handler({}, auth());
    const out = JSON.parse(raw) as Record<string, any>;
    expect(logSearchMock.searchFleetLogs.mock.calls[0]![1].limit).toBe(12);
    expect(out.logs).toHaveLength(12);
    expect(out.hasMore).toBe(true);
    expect(out.nextCursor).toBe('c1');
    const row = out.logs[0];
    expect(row.message.length).toBeLessThanOrEqual(300);
    expect(row.messageChars).toBe(LONG_MESSAGE.length);
    expect(row.hostname).toBe('WKSTN-ACCOUNTING-0');
    expect(row.siteName).toBe('Main Office - Building A');
    expect(row.device).toBeUndefined();
    expect(row.site).toBeUndefined();
    expectDefaultPageFits('search_logs', raw);
  });

  it('includeFullMessage=true returns the whole message', async () => {
    logSearchMock.searchFleetLogs.mockResolvedValue({
      results: [logRow(0)], total: 1, totalMode: 'exact', limit: 15, offset: 0, hasMore: false, nextCursor: null,
    });
    const out = JSON.parse(await tool.handler({ includeFullMessage: true }, auth())) as Record<string, any>;
    expect(out.logs[0].message).toBe(LONG_MESSAGE);
    expect(out.logs[0].messageChars).toBeUndefined();
  });
});

function trends(limit: number, hours: number) {
  return {
    start: '2026-09-13T10:00:00.000Z', end: '2026-09-20T10:00:00.000Z', minLevel: 'info',
    levelDistribution: ['info', 'warning', 'error', 'critical'].map((level, i) => ({ level, count: 1000 * (i + 1) })),
    topSources: Array.from({ length: limit }, (_, i) => ({ source: `Microsoft-Windows-Security-Auditing-${i}`, count: 900 - i, errorCount: 12, criticalCount: 1 })),
    topDevices: Array.from({ length: limit }, (_, i) => ({ deviceId: fixtureRow(i, { id: 'id' }).id, hostname: `WKSTN-ACCOUNTING-${i}`, count: 800 - i, errorCount: 44, criticalCount: 2 })),
    topSourcesHasMore: true,
    topDevicesHasMore: true,
    errorTimeline: Array.from({ length: hours }, (_, i) => ({ timestamp: `2026-09-${String(13 + Math.floor(i / 24)).padStart(2, '0')} ${String(i % 24).padStart(2, '0')}:00:00`, count: i % 7 === 0 ? 50 : 3 })),
    spikes: Array.from({ length: Math.ceil(hours / 7) }, (_, i) => ({ timestamp: `2026-09-13 ${String(i % 24).padStart(2, '0')}:00:00`, count: 50 })),
    spikeThreshold: 10,
  };
}

describe('get_log_trends output shape (#6745)', () => {
  const tool = tools().get('get_log_trends')!;
  beforeEach(() => { vi.clearAllMocks(); });

  it('declares the default limit it applies', () => {
    const props = (tool.definition.input_schema as { properties: Record<string, { description: string }> }).properties;
    expect(props.limit!.description).toBe('Max top-list entries (default 20, max 100)');
  });

  it('a 7-day default call omits the hourly timeline, keeps spikes, and fits the budget', async () => {
    logSearchMock.getLogTrends.mockImplementation(async (_a: unknown, f: { limit: number }) => trends(f.limit, 168));
    const raw = await tool.handler({ timeRange: { start: '2026-09-13T10:00:00Z', end: '2026-09-20T10:00:00Z' } }, auth());
    const out = JSON.parse(raw) as Record<string, any>;
    expect(logSearchMock.getLogTrends.mock.calls[0]![1].limit).toBe(20);
    expect(out.trends.errorTimeline).toBeUndefined();
    expect(out.trends.errorTimelineBuckets).toBe(168);
    expect(out.trends.spikeCount).toBe(24);
    expect(out.trends.spikes.length).toBeLessThanOrEqual(10);
    expect(out.trends.topSourcesHasMore).toBe(true);
    expectDefaultPageFits('get_log_trends', raw);
  });

  it('includeTimeline=true returns the hourly timeline and the grouped series', async () => {
    logSearchMock.getLogTrends.mockResolvedValue(trends(15, 24));
    logSearchMock.getLogAggregation.mockResolvedValue({
      groupBy: 'level', totals: [{ group: 'error', count: 3 }],
      series: Array.from({ length: 300 }, (_, i) => ({ bucket: `b${i}`, group: 'error', count: 1 })),
    });
    const out = JSON.parse(await tool.handler({ includeTimeline: true, groupBy: 'level' }, auth())) as Record<string, any>;
    expect(out.trends.errorTimeline).toHaveLength(24);
    expect(out.grouped.sampleSeries).toHaveLength(200);
    expect(out.grouped.totals).toEqual([{ group: 'error', count: 3 }]);
  });

  it('groupBy without includeTimeline returns totals only', async () => {
    logSearchMock.getLogTrends.mockResolvedValue(trends(15, 24));
    logSearchMock.getLogAggregation.mockResolvedValue({
      groupBy: 'level', totals: [{ group: 'error', count: 3 }],
      series: Array.from({ length: 300 }, (_, i) => ({ bucket: `b${i}`, group: 'error', count: 1 })),
    });
    const out = JSON.parse(await tool.handler({ groupBy: 'level' }, auth())) as Record<string, any>;
    expect(out.grouped.sampleSeries).toBeUndefined();
    expect(out.grouped.totals).toEqual([{ group: 'error', count: 3 }]);
  });

  it('the zero-in-scope-device short-circuit returns the same default shape', async () => {
    const restricted = { ...(auth() as unknown as Record<string, unknown>), allowedSiteIds: ['site-x'], canAccessSite: () => true } as unknown as AuthContext;
    const out = JSON.parse(await tool.handler({}, restricted)) as Record<string, any>;
    expect(logSearchMock.getLogTrends).not.toHaveBeenCalled();
    expect(out.trends).toMatchObject({ topSourcesHasMore: false, topDevicesHasMore: false, errorTimelineBuckets: 0, spikeCount: 0, spikes: [] });
    expect(out.trends.errorTimeline).toBeUndefined();
    const withTimeline = JSON.parse(await tool.handler({ includeTimeline: true }, restricted)) as Record<string, any>;
    expect(withTimeline.trends.errorTimeline).toEqual([]);
  });
});
