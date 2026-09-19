/**
 * Exact-device axis for the monitor-activity AI tool (#6086 class).
 *
 * `get_monitor_activity` takes an OPTIONAL deviceId. The central `deviceArgs`
 * gate only fires when the caller supplies one — omit it and the underlying
 * episode queries were scoped by org alone, so a device-bound preconfigured
 * agent run saw every sibling device's breach state and episode history.
 *
 * Both restricted shapes must be covered:
 *  - device-bound run: allowedDeviceIds + allowedSiteIds + canAccessSite
 *  - device-LESS analysis run: allowedDeviceIds only (no site axis) — guards
 *    written `if (auth.allowedSiteIds && …)` silently no-op for this one.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

const { getMonitorDefinitionMock } = vi.hoisted(() => ({ getMonitorDefinitionMock: vi.fn() }));
vi.mock('./monitors/monitorService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./monitors/monitorService')>()),
  getMonitorDefinition: getMonitorDefinitionMock,
}));

import { db } from '../db';
import { registerMonitorTools } from './aiToolsMonitors';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

const ORG = '11111111-1111-4111-8111-111111111111';
const MONITOR_ID = 'm1';
const DEV_ALLOWED = 'dev-allowed-aaa';
const DEV_SIBLING = 'dev-sibling-bbb';
const SITE = 'site-1';

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerMonitorTools(reg);
  const tool = reg.get(name);
  if (!tool) throw new Error(`${name} not registered`);
  return tool.handler;
}

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: null,
    partnerId: null,
    orgId: ORG,
    scope: 'organization',
    accessibleOrgIds: [ORG],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    ...overrides,
  } as unknown as AuthContext;
}

/** Device-bound preconfigured-agent shape: both axes pinned. */
const deviceBoundAuth = () =>
  auth({
    allowedDeviceIds: [DEV_ALLOWED],
    allowedSiteIds: [SITE],
    canAccessSite: ((s: string | null | undefined) => s === SITE) as never,
  } as Partial<AuthContext>);

/** Device-LESS analysis shape: device axis only, no site axis at all. */
const deviceOnlyAuth = () =>
  auth({ allowedDeviceIds: [DEV_ALLOWED] } as Partial<AuthContext>);

function activityRow(deviceId: string) {
  return {
    deviceId,
    orgId: ORG,
    lastState: 'breach',
    lastEvaluatedAt: new Date('2026-09-01T00:00:00.000Z'),
    currentEpisodeId: `ep-${deviceId}`,
    episodesInWindow: 1,
    windowStartedAt: null,
    escalatedAt: null,
    escalationAlertId: null,
    responsesPaused: false,
    resetAt: null,
    resetBy: null,
    hostname: `host-${deviceId}`,
    displayName: null,
    openSince: null,
  };
}

function episodeRow(deviceId: string) {
  return {
    id: `ep-${deviceId}`,
    deviceId,
    orgId: ORG,
    startedAt: new Date('2026-09-01T00:00:00.000Z'),
    endedAt: null,
    endReason: null,
    alertId: null,
    responseRunId: null,
    responseOutcome: null,
    hostname: `host-${deviceId}`,
    displayName: null,
  };
}

/** Does the captured drizzle condition tree mention this literal value? */
function mentions(node: unknown, needle: string, seen = new Set<unknown>()): boolean {
  if (node === needle) return true;
  if (node === null || typeof node !== 'object' || seen.has(node)) return false;
  seen.add(node);
  return Object.values(node as Record<string, unknown>).some((v) => mentions(v, needle, seen));
}

let capturedWheres: unknown[] = [];

/**
 * Serve the two episodeQueries reads in order: the device-activity join first,
 * then the episode list. Both `where(...)` conditions are captured.
 */
function mockEpisodeReads(activity: unknown[], episodes: unknown[]): void {
  let call = 0;
  mockDb.select.mockImplementation(() => {
    const which = call++;
    const rows = which === 0 ? activity : episodes;
    const tail = {
      where: (cond: unknown) => {
        capturedWheres.push(cond);
        return {
          limit: () => Promise.resolve(rows),
          orderBy: () => ({ limit: () => Promise.resolve(rows) }),
        };
      },
    };
    return {
      from: () => ({
        innerJoin: () => ({ leftJoin: () => tail }),
        leftJoin: () => tail,
      }),
    };
  });
}

describe('get_monitor_activity — exact-device axis (no deviceId supplied)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedWheres = [];
    getMonitorDefinitionMock.mockResolvedValue({ id: MONITOR_ID, orgId: ORG, name: 'Mon' });
  });

  it('device-bound caller cannot see a sibling device in the same site', async () => {
    mockEpisodeReads(
      [activityRow(DEV_ALLOWED), activityRow(DEV_SIBLING)],
      [episodeRow(DEV_ALLOWED), episodeRow(DEV_SIBLING)],
    );

    const parsed = JSON.parse(
      await handlerFor('get_monitor_activity')({ monitorId: MONITOR_ID }, deviceBoundAuth()),
    );

    expect(parsed.error).toBeUndefined();
    expect(parsed.devices.map((d: { deviceId: string }) => d.deviceId)).toEqual([DEV_ALLOWED]);
    expect(parsed.episodes.map((e: { deviceId: string }) => e.deviceId)).toEqual([DEV_ALLOWED]);
    expect(JSON.stringify(parsed)).not.toContain(DEV_SIBLING);
    // The narrowing must also reach SQL, not only the response mapping.
    expect(capturedWheres.length).toBe(2);
    for (const cond of capturedWheres) expect(mentions(cond, DEV_ALLOWED)).toBe(true);
  });

  it('device-bound caller still sees its own device (no over-blocking)', async () => {
    mockEpisodeReads([activityRow(DEV_ALLOWED)], [episodeRow(DEV_ALLOWED)]);

    const parsed = JSON.parse(
      await handlerFor('get_monitor_activity')({ monitorId: MONITOR_ID }, deviceBoundAuth()),
    );

    expect(parsed.devices).toHaveLength(1);
    expect(parsed.devices[0].deviceId).toBe(DEV_ALLOWED);
    expect(parsed.episodes).toHaveLength(1);
    expect(parsed.episodes[0].deviceId).toBe(DEV_ALLOWED);
  });

  it('device-LESS analysis shape (no allowedSiteIds) also cannot see a sibling device', async () => {
    mockEpisodeReads(
      [activityRow(DEV_ALLOWED), activityRow(DEV_SIBLING)],
      [episodeRow(DEV_ALLOWED), episodeRow(DEV_SIBLING)],
    );

    const parsed = JSON.parse(
      await handlerFor('get_monitor_activity')({ monitorId: MONITOR_ID }, deviceOnlyAuth()),
    );

    expect(parsed.devices.map((d: { deviceId: string }) => d.deviceId)).toEqual([DEV_ALLOWED]);
    expect(parsed.episodes.map((e: { deviceId: string }) => e.deviceId)).toEqual([DEV_ALLOWED]);
    expect(JSON.stringify(parsed)).not.toContain(DEV_SIBLING);
    for (const cond of capturedWheres) expect(mentions(cond, DEV_ALLOWED)).toBe(true);
  });

  it('unrestricted caller is not narrowed at all', async () => {
    mockEpisodeReads(
      [activityRow(DEV_ALLOWED), activityRow(DEV_SIBLING)],
      [episodeRow(DEV_ALLOWED), episodeRow(DEV_SIBLING)],
    );

    const parsed = JSON.parse(
      await handlerFor('get_monitor_activity')({ monitorId: MONITOR_ID }, auth()),
    );

    expect(parsed.devices).toHaveLength(2);
    expect(parsed.episodes).toHaveLength(2);
    for (const cond of capturedWheres) expect(mentions(cond, DEV_ALLOWED)).toBe(false);
  });
});
