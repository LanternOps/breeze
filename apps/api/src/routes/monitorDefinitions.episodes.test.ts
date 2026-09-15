/**
 * #5290 — episode activity read routes and the escalation reset.
 *
 * Mock preamble mirrors monitorDefinitions.test.ts: middleware is replaced with
 * cheap controllable gates, and the episode service layer is mocked (its own
 * correctness lives in episodeReset.test.ts and the integration suite).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  hasPermMock,
  mfaOkMock,
  getMonitorDefinitionMock,
  listMonitorDeviceActivityMock,
  listMonitorEpisodesMock,
  resetMonitorEscalationMock,
  writeRouteAuditMock,
  selectMock,
  getDeviceWithOrgAndSiteCheckMock,
  SITE_ACCESS_DENIED,
} = vi.hoisted(() => ({
  hasPermMock: vi.fn<(resource: string, action: string) => boolean>(() => true),
  mfaOkMock: vi.fn(() => true),
  getMonitorDefinitionMock: vi.fn(),
  listMonitorDeviceActivityMock: vi.fn(),
  listMonitorEpisodesMock: vi.fn(),
  resetMonitorEscalationMock: vi.fn(),
  writeRouteAuditMock: vi.fn(),
  selectMock: vi.fn(),
  getDeviceWithOrgAndSiteCheckMock: vi.fn(),
  SITE_ACCESS_DENIED: Symbol('SITE_ACCESS_DENIED'),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireMfa: () => async (c: { json: (body: unknown, status: number) => Response }, next: () => Promise<void>) => (
    mfaOkMock() ? next() : c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403)
  ),
  requirePermission: (resource: string, action: string) => async (
    c: { json: (body: unknown, status: number) => Response },
    next: () => Promise<void>,
  ) => (hasPermMock(resource, action) ? next() : c.json({ error: 'Permission denied' }, 403)),
}));

const { MonitorNotFoundError, MonitorOwnershipError, MonitorValidationError } = vi.hoisted(() => ({
  MonitorNotFoundError: class MonitorNotFoundError extends Error {},
  MonitorOwnershipError: class MonitorOwnershipError extends Error {},
  MonitorValidationError: class MonitorValidationError extends Error {},
}));

vi.mock('../services/monitors/monitorService', () => ({
  MonitorNotFoundError,
  MonitorOwnershipError,
  MonitorValidationError,
  listMonitorDefinitions: vi.fn(),
  getMonitorDefinition: getMonitorDefinitionMock,
  createMonitorDefinition: vi.fn(),
  updateMonitorDefinition: vi.fn(),
  deleteMonitorDefinition: vi.fn(),
}));

vi.mock('../services/monitors/episodeQueries', () => ({
  listMonitorDeviceActivity: listMonitorDeviceActivityMock,
  listMonitorEpisodes: listMonitorEpisodesMock,
}));

vi.mock('../services/monitors/episodeReset', () => ({
  resetMonitorEscalation: resetMonitorEscalationMock,
}));

vi.mock('../services/monitors/monitorCompiler', () => ({ buildCompiledCondition: vi.fn() }));
vi.mock('../services/monitors/monitorResolver', () => ({
  resolveMonitorsForDevice: vi.fn(async () => ({ kind: 'resolved', monitors: [] })),
}));
vi.mock('../services/alertConditions', () => ({ evaluateConditions: vi.fn() }));
vi.mock('../services/configurationPolicy', () => ({
  addFeatureLink: vi.fn(),
  assignPolicy: vi.fn(),
  createConfigPolicy: vi.fn(),
  getConfigPolicy: vi.fn(),
  removeFeatureLink: vi.fn(),
  updateFeatureLink: vi.fn(),
  validateAssignmentTarget: vi.fn(async () => ({ valid: true })),
  authorizeAssignmentTarget: vi.fn(async () => ({ valid: true })),
}));
vi.mock('../services/monitors/monitorAttachability', () => ({
  isMonitorAttachableToPolicy: vi.fn(async () => true),
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));
vi.mock('./devices/helpers', () => ({
  getDeviceWithOrgAndSiteCheck: getDeviceWithOrgAndSiteCheckMock,
  SITE_ACCESS_DENIED,
}));
vi.mock('../db', () => ({ db: { select: selectMock } }));

import { monitorDefinitionRoutes } from './monitorDefinitions';

const ORG_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '77777777-7777-4777-8777-777777777777';
const MONITOR_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';

function selectChain<T>(rows: T) {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    groupBy: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    offset: () => chain,
    then: (resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      user: { id: USER_ID, email: 'tech@example.com', name: 'Tech' },
      canAccessOrg: () => true,
      orgCondition: () => undefined,
    } as never);
    await next();
  });
  app.route('/monitor-definitions', monitorDefinitionRoutes);
  return app;
}

const episode = (overrides: Record<string, unknown> = {}) => ({
  id: 'ep-1',
  deviceId: DEVICE_ID,
  deviceName: 'WS-1',
  orgId: ORG_ID,
  startedAt: '2026-09-13T10:00:00.000Z',
  endedAt: null,
  endReason: null,
  alertId: null,
  responseRunId: null,
  responseOutcome: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  hasPermMock.mockReturnValue(true);
  mfaOkMock.mockReturnValue(true);
  getMonitorDefinitionMock.mockResolvedValue({ id: MONITOR_ID, orgId: ORG_ID, name: 'High CPU' });
  listMonitorEpisodesMock.mockResolvedValue({ episodes: [episode()], nextCursor: null });
  listMonitorDeviceActivityMock.mockResolvedValue([]);
  resetMonitorEscalationMock.mockResolvedValue({ reset: true });
  getDeviceWithOrgAndSiteCheckMock.mockResolvedValue({ id: DEVICE_ID, orgId: ORG_ID, siteId: 'site-1' });
  selectMock.mockImplementation(() => selectChain([]));
});

describe('GET /monitor-definitions/:id/episodes', () => {
  it('returns 403 without alerts:read', async () => {
    hasPermMock.mockReturnValue(false);
    const res = await buildApp().request(`/monitor-definitions/${MONITOR_ID}/episodes`);
    expect(res.status).toBe(403);
  });

  it('returns 404 for a monitor the caller cannot see', async () => {
    getMonitorDefinitionMock.mockResolvedValue(null);
    const res = await buildApp().request(`/monitor-definitions/${MONITOR_ID}/episodes`);
    expect(res.status).toBe(404);
    expect(listMonitorEpisodesMock).not.toHaveBeenCalled();
  });

  it('returns the episode list with a cursor', async () => {
    listMonitorEpisodesMock.mockResolvedValue({
      episodes: [episode()],
      nextCursor: '2026-09-13T09:00:00.000Z',
    });
    const res = await buildApp().request(`/monitor-definitions/${MONITOR_ID}/episodes`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[]; nextCursor: string | null };
    expect(body.data).toHaveLength(1);
    expect(body.nextCursor).toBe('2026-09-13T09:00:00.000Z');
  });

  it('passes deviceId, limit and cursor through to the query', async () => {
    await buildApp().request(
      `/monitor-definitions/${MONITOR_ID}/episodes?deviceId=${DEVICE_ID}&limit=5&cursor=2026-09-13T09:00:00.000Z`,
    );
    expect(listMonitorEpisodesMock).toHaveBeenCalledWith(
      MONITOR_ID,
      expect.anything(),
      expect.objectContaining({ deviceId: DEVICE_ID, limit: 5, cursor: '2026-09-13T09:00:00.000Z' }),
    );
  });
});

describe('GET /monitor-definitions/:id/devices — activity projection', () => {
  it('merges escalation and pause state onto each resolved device', async () => {
    // One attaching policy → one org assignment → one candidate device.
    const chains = [
      selectChain([{ configPolicyId: 'pol-1' }]),
      selectChain([]),
      selectChain([{ level: 'organization', targetId: ORG_ID }]),
      selectChain([{ id: DEVICE_ID, hostname: 'ws-1', displayName: 'WS-1' }]),
    ];
    let i = 0;
    selectMock.mockImplementation(() => chains[i++] ?? selectChain([]));

    const { resolveMonitorsForDevice } = await import('../services/monitors/monitorResolver');
    (resolveMonitorsForDevice as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: 'resolved',
      monitors: [
        { monitorId: MONITOR_ID, enabled: true, overrides: null, sourcePolicyId: 'pol-1', sourceLevel: 'organization' },
      ],
    });

    listMonitorDeviceActivityMock.mockResolvedValue([
      {
        deviceId: DEVICE_ID,
        deviceName: 'WS-1',
        orgId: ORG_ID,
        lastState: 'breach',
        lastEvaluatedAt: '2026-09-13T11:00:00.000Z',
        currentEpisodeId: 'ep-1',
        openSince: '2026-09-13T10:00:00.000Z',
        episodesInWindow: 3,
        windowStartedAt: '2026-09-12T10:00:00.000Z',
        escalatedAt: '2026-09-13T11:00:00.000Z',
        escalationAlertId: 'alert-1',
        responsesPaused: true,
        resetAt: null,
        resetBy: null,
      },
    ]);

    const res = await buildApp().request(`/monitor-definitions/${MONITOR_ID}/devices`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      deviceId: DEVICE_ID,
      lastState: 'breach',
      episodesInWindow: 3,
      responsesPaused: true,
      escalationAlertId: 'alert-1',
    });
  });
});

describe('POST /monitor-definitions/:id/devices/:deviceId/reset', () => {
  const path = `/monitor-definitions/${MONITOR_ID}/devices/${DEVICE_ID}/reset`;

  it('returns 403 without alerts:write', async () => {
    hasPermMock.mockReturnValue(false);
    const res = await buildApp().request(path, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(resetMonitorEscalationMock).not.toHaveBeenCalled();
  });

  it('returns 403 without MFA', async () => {
    mfaOkMock.mockReturnValue(false);
    const res = await buildApp().request(path, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('returns 404 for a monitor outside the caller org', async () => {
    getMonitorDefinitionMock.mockResolvedValue(null);
    const res = await buildApp().request(path, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(resetMonitorEscalationMock).not.toHaveBeenCalled();
  });

  it('returns 403 for a device outside the caller sites (site-scope gate)', async () => {
    // Site is app-layer only — RLS does not defend it. A site-restricted
    // technician must not be able to reset escalation state on another site's
    // device even when the monitor itself is visible to them.
    getDeviceWithOrgAndSiteCheckMock.mockResolvedValue(SITE_ACCESS_DENIED);
    const res = await buildApp().request(path, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(resetMonitorEscalationMock).not.toHaveBeenCalled();
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });

  it('returns 404 for a device the caller cannot see', async () => {
    getDeviceWithOrgAndSiteCheckMock.mockResolvedValue(null);
    const res = await buildApp().request(path, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(resetMonitorEscalationMock).not.toHaveBeenCalled();
  });

  it('returns 200 and { reset: true }', async () => {
    const res = await buildApp().request(path, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reset: true });
    expect(getDeviceWithOrgAndSiteCheckMock).toHaveBeenCalledWith(expect.anything(), DEVICE_ID, expect.anything());
  });

  it('writes an audit entry with action monitor.escalation.reset', async () => {
    await buildApp().request(path, { method: 'POST' });
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'monitor.escalation.reset',
        resourceType: 'monitor_definition',
        resourceId: MONITOR_ID,
      }),
    );
  });
});
