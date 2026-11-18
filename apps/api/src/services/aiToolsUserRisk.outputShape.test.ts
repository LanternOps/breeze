// #6745 (A-W05 follow-up): get_fleet_health offset-mode envelope + row shaping.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefaultPageFits, fixtureRow } from './aiToolOutputBudget.testkit';
import { compactToolResultForChat } from './aiToolOutput';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
}));
const reliabilityMock = vi.hoisted(() => ({
  listReliabilityDevices: vi.fn(),
  summarizeReliabilityDevices: vi.fn(),
}));
vi.mock('./reliabilityScoring', () => reliabilityMock);
vi.mock('./userRiskScoring', () => ({
  assignSecurityTraining: vi.fn(), getUserRiskDetail: vi.fn(), getUserRiskOrgMembership: vi.fn(), listUserRiskScores: vi.fn(),
}));

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerUserRiskTools } from './aiToolsUserRisk';
import { getUserRiskDetail } from './userRiskScoring';
import { toolInputSchemas } from './aiToolSchemas';

function tool(): AiTool {
  const reg = new Map<string, AiTool>();
  registerUserRiskTools(reg);
  return reg.get('get_fleet_health')!;
}
const auth = (extra: Record<string, unknown> = {}) => ({
  user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
  token: {}, partnerId: null, orgId: 'org-1', scope: 'organization', accessibleOrgIds: ['org-1'],
  orgCondition: () => undefined, canAccessOrg: () => true, ...extra,
}) as unknown as AuthContext;

function reliabilityRow(i: number) {
  const f = fixtureRow(i, { deviceId: 'id', orgId: 'id', siteId: 'id', computedAt: 'ts' });
  return {
    ...f,
    hostname: `WKSTN-ACCOUNTING-${i}`, osType: 'windows', status: 'online',
    reliabilityScore: 40 + (i % 50), trendDirection: 'degrading', trendConfidence: 0.8765,
    uptime30d: 97.123, crashCount30d: 3, hangCount30d: 2, serviceFailureCount30d: 5, hardwareErrorCount30d: 1, mtbfHours: 123.45,
    topIssues: [
      { type: 'crashes', count: 3, severity: 'critical', lastOccurrence: '2026-09-19T08:00:00.000Z' },
      { type: 'services', count: 5, severity: 'error', lastOccurrence: '2026-09-19T09:00:00.000Z' },
      { type: 'hangs', count: 2, severity: 'warning', lastOccurrence: '2026-09-18T09:00:00.000Z' },
      { type: 'hardware', count: 1, severity: 'warning', lastOccurrence: '2026-09-17T09:00:00.000Z' },
    ],
  };
}
const FLEET_SUMMARY = { total: 480, averageScore: 71, criticalDevices: 40, poorDevices: 90, fairDevices: 150, goodDevices: 200, degradingDevices: 33 };

describe('get_fleet_health output shape (#6745)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reliabilityMock.listReliabilityDevices.mockImplementation(async (f: { limit: number; offset: number }) => ({
      total: 480,
      rows: Array.from({ length: f.limit }, (_, i) => reliabilityRow(f.offset + i)),
    }));
    reliabilityMock.summarizeReliabilityDevices.mockResolvedValue(FLEET_SUMMARY);
  });

  it('declares limit/offset/cursor with the shared text', () => {
    const props = (tool().definition.input_schema as { properties: Record<string, { description: string }> }).properties;
    expect(props.limit!.description).toBe('Max results (default 15, max 100)');
    expect(props.offset!.description).toBe('Pagination offset (default 0)');
    expect(props.cursor!.description).toBe('nextCursor from a previous call with the same filters');
  });

  it('a default page of realistic rows fits the budget, carries the envelope and omits topIssues', async () => {
    const raw = await tool().handler({}, auth());
    const out = JSON.parse(raw) as Record<string, any>;
    expect(reliabilityMock.listReliabilityDevices.mock.calls[0]![0]).toMatchObject({ limit: 15, offset: 0 });
    expect(Object.keys(out)).toEqual(expect.arrayContaining(['devices', 'showing', 'limit', 'offset', 'total', 'hasMore', 'nextCursor', 'summary']));
    expect(out.hasMore).toBe(true);
    expect(out.devices[0].topIssues).toBeUndefined();
    expect(out.devices[0].topIssueCount).toBe(4);
    expectDefaultPageFits('get_fleet_health', raw);
  });

  it('summary is the fleet-wide aggregate over the filtered set, not the page', async () => {
    const out = JSON.parse(await tool().handler({ limit: 2 }, auth())) as Record<string, any>;
    expect(out.summary).toMatchObject({ averageScore: 71, criticalDevices: 40, degradingDevices: 33 });
    expect(out.total).toBe(480);
  });

  it('the nextCursor fetches the next offset, and a cursor for other filters is refused', async () => {
    const first = JSON.parse(await tool().handler({}, auth())) as { nextCursor: string };
    await tool().handler({ cursor: first.nextCursor }, auth());
    expect(reliabilityMock.listReliabilityDevices.mock.calls[1]![0]).toMatchObject({ offset: 15 });
    const mismatch = JSON.parse(await tool().handler({ scoreRange: 'critical', cursor: first.nextCursor }, auth())) as { code?: string };
    expect(mismatch.code).toBe('CURSOR_MISMATCH');
  });

  it('includeTopIssues=true returns topIssues', async () => {
    const out = JSON.parse(await tool().handler({ includeTopIssues: true, limit: 1 }, auth())) as Record<string, any>;
    expect(out.devices[0].topIssues).toHaveLength(4);
  });

  it('pushes a frozen device set into the query so total/summary/paging are over that set', async () => {
    await tool().handler({}, auth({ allowedDeviceIds: ['d-1', 'd-2'] }));
    expect(reliabilityMock.listReliabilityDevices.mock.calls[0]![0]).toMatchObject({ deviceIds: ['d-1', 'd-2'] });
    expect(reliabilityMock.summarizeReliabilityDevices.mock.calls[0]![0]).toMatchObject({ deviceIds: ['d-1', 'd-2'] });
  });

  it('a worst-case page that compacts still carries hasMore/nextCursor', async () => {
    const raw = await tool().handler({ limit: 100, includeTopIssues: true }, auth());
    const compacted = JSON.parse(compactToolResultForChat('get_fleet_health', raw)) as Record<string, unknown>;
    expect(compacted.hasMore).toBe(true);
    expect(typeof compacted.nextCursor).toBe('string');
  });

  it('#7131: compaction keeps topIssues content instead of dropping it to a depth marker', async () => {
    const raw = await tool().handler({ limit: 100, includeTopIssues: true }, auth());
    const compacted = JSON.parse(compactToolResultForChat('get_fleet_health', raw)) as {
      devices: Array<{ topIssues?: unknown }>;
    };
    expect(compacted.devices.length).toBeGreaterThan(0);
    // The devices array itself is also bounded (a page of 100 compacts down
    // to a handful of real rows + the ordinary "...N more items omitted"
    // sentinel STRING as the last element) — skip that sentinel, it's not a
    // device, and only check the real device rows.
    const realDevices = compacted.devices.filter((d): d is { topIssues?: unknown } => typeof d === 'object' && d !== null);
    expect(realDevices.length).toBeGreaterThan(0);
    for (const device of realDevices) {
      expect(device.topIssues).not.toBe('[truncated: max depth reached]');
      expect(Array.isArray(device.topIssues)).toBe(true);
      const issues = device.topIssues as unknown[];
      expect(issues.length).toBeGreaterThan(0);
      // At least one real issue item (not just a sentinel) must survive with
      // its actual fields readable, not collapsed to the depth marker.
      const firstIssue = issues[0];
      expect(firstIssue).not.toBe('[truncated: max depth reached]');
      expect(typeof firstIssue).toBe('object');
      expect(firstIssue).toMatchObject({ type: expect.any(String), severity: expect.any(String) });
    }
  });

  it('#7131: a realistic 13-device fleet with topIssues near the chat budget keeps them, not a depth marker', async () => {
    // Reproduces the reported prod shape: a page just over MAX_TOOL_RESULT_CHARS
    // (the original incident's raw output was 8,163 chars) needs only the depth-4
    // tier to fit, not the full digest fallback.
    const raw = await tool().handler({ limit: 13, includeTopIssues: true }, auth());
    const compacted = JSON.parse(compactToolResultForChat('get_fleet_health', raw)) as {
      devices: Array<{ topIssues?: unknown }>;
    };
    expect(Array.isArray(compacted.devices)).toBe(true);
    const realDevices = compacted.devices.filter((d): d is { topIssues?: unknown } => typeof d === 'object' && d !== null);
    expect(realDevices.length).toBeGreaterThan(0);
    for (const device of realDevices) {
      expect(device.topIssues).not.toBe('[truncated: max depth reached]');
      expect(Array.isArray(device.topIssues)).toBe(true);
      const issues = device.topIssues as unknown[];
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0]).not.toBe('[truncated: max depth reached]');
      expect(issues[0]).toMatchObject({ type: expect.any(String), severity: expect.any(String) });
    }
  });
});

// #6734 (A-W05 D12b follow-up): get_user_risk_detail returned up to 100 risk
// events, each with its free-form `details` jsonb, in one response.
describe('get_user_risk_detail output shape (#6734)', () => {
  const USER_ID = '33333333-3333-4333-8333-333333333333';
  function riskTool(): AiTool {
    const reg = new Map<string, AiTool>();
    registerUserRiskTools(reg);
    return reg.get('get_user_risk_detail')!;
  }
  function detail(eventCount: number) {
    return {
      user: { id: USER_ID, name: 'Dana Whitfield', email: 'dana.whitfield@example.com', mfaEnabled: false, lastLoginAt: '2026-09-20T08:00:00.000Z' },
      latestScore: {
        score: 82, trendDirection: 'up', calculatedAt: '2026-09-20T09:00:00.000Z', deltaFromPrevious: 9, severity: 'high',
        factors: { mfaRisk: 100, authFailureRisk: 64, sessionAnomalyRisk: 22, threatExposureRisk: 71, softwareViolationRisk: 40, deviceSecurityRisk: 35, staleAccessRisk: 10, recentImpactRisk: 55 },
      },
      recentEvents: Array.from({ length: eventCount }, (_, i) => ({
        ...fixtureRow(i, { id: 'id', occurredAt: 'ts' }),
        eventType: 'auth_failure_burst', severity: 'high', scoreImpact: 6,
        description: `Repeated failed sign-ins from an unfamiliar network against the user's mailbox (${i}).`,
        details: {
          sourceIp: '203.0.113.42', country: 'NL', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
          failures: 14, windowMinutes: 10, deviceId: '44444444-4444-4444-8444-444444444444', hostname: `WKSTN-ACCOUNTING-${i}`,
        },
      })),
      history: Array.from({ length: 30 }, (_, i) => ({ score: 60 + (i % 25), trendDirection: 'up', calculatedAt: new Date(Date.UTC(2026, 8, 20 - i)).toISOString() })),
      policy: {
        orgId: 'org-1', updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: null,
        weights: { mfaRisk: 0.14, authFailureRisk: 0.2, sessionAnomalyRisk: 0.1, threatExposureRisk: 0.2, softwareViolationRisk: 0.15, deviceSecurityRisk: 0.1, staleAccessRisk: 0.06, recentImpactRisk: 0.05 },
        thresholds: { medium: 50, high: 70, critical: 85, spikeDelta: 15, autoAssignTrainingAtOrAbove: 80 },
        interventions: { autoAssignTraining: false, trainingModuleId: 'security-awareness-baseline', notifyOnHighRisk: true, notifyOnRiskSpike: true },
      },
    };
  }
  beforeEach(() => { vi.mocked(getUserRiskDetail).mockReset(); });

  it('declares limit with the "(default N, max M)" text on the registry and Zod surfaces', () => {
    const props = (riskTool().definition.input_schema as { properties: Record<string, { description: string }> }).properties;
    expect(props.limit!.description).toBe('Max recent events (default 10, max 100)');
    expect(toolInputSchemas.get_user_risk_detail!.safeParse({ userId: USER_ID, limit: 5, includeDetails: true }).success).toBe(true);
  });

  it('a default response for a user with 100 events fits the budget uncompacted and drops event details', async () => {
    vi.mocked(getUserRiskDetail).mockResolvedValue(detail(100) as never);
    const raw = await riskTool().handler({ userId: USER_ID }, auth());
    expectDefaultPageFits('get_user_risk_detail', raw);
    const out = JSON.parse(raw).userRisk as Record<string, any>;
    expect(out.recentEvents).toHaveLength(10);
    expect(out.recentEventCount).toBe(100);
    expect(out.recentEvents[0]).not.toHaveProperty('details');
    expect(out.recentEvents[0]).toMatchObject({ eventType: 'auth_failure_burst', scoreImpact: 6 });
    expect(out.latestScore.factors.mfaRisk).toBe(100);
    expect(out.history).toHaveLength(30);
  });

  it('limit and includeDetails widen the event list and restore details', async () => {
    vi.mocked(getUserRiskDetail).mockResolvedValue(detail(100) as never);
    const out = JSON.parse(await riskTool().handler({ userId: USER_ID, limit: 40, includeDetails: true }, auth())).userRisk;
    expect(out.recentEvents).toHaveLength(40);
    expect(out.recentEvents[0].details).toMatchObject({ sourceIp: '203.0.113.42', failures: 14 });
  });
});
