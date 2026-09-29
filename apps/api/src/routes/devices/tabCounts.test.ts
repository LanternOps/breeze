import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { selectMock, selectDistinctOnMock, getDeviceWithOrgAndSiteCheckMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  selectDistinctOnMock: vi.fn(),
  getDeviceWithOrgAndSiteCheckMock: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ type: 'and', conditions }),
  desc: (column: unknown) => ({ type: 'desc', column }),
  eq: (left: unknown, right: unknown) => ({ type: 'eq', left, right }),
  inArray: (left: unknown, right: unknown) => ({ type: 'inArray', left, right }),
  isNull: (column: unknown) => ({ type: 'isNull', column }),
  sql: Object.assign((strings: TemplateStringsArray) => ({ type: 'sql', text: strings.join('?') }), {
    raw: (s: string) => ({ type: 'raw', s }),
  }),
}));

vi.mock('../../db', () => ({ db: { select: selectMock, selectDistinctOn: selectDistinctOnMock } }));

vi.mock('../../db/schema', () => ({
  alerts: { deviceId: 'alerts.deviceId', status: 'alerts.status' },
  metricAnomalies: { deviceId: 'metricAnomalies.deviceId', status: 'metricAnomalies.status' },
  metricAnomalyEpisodes: { deviceId: 'metricAnomalyEpisodes.deviceId', status: 'metricAnomalyEpisodes.status' },
  tickets: { deviceId: 'tickets.deviceId', status: 'tickets.status', deletedAt: 'tickets.deletedAt' },
  aiOperatorTasks: { deviceId: 'aiOperatorTasks.deviceId', state: 'aiOperatorTasks.state' },
  AI_OPERATOR_TASK_LIVE_STATES: ['queued', 'running', 'waiting', 'paused'],
  serviceProcessCheckResults: {
    deviceId: 'spcr.deviceId', status: 'spcr.status', watchType: 'spcr.watchType', name: 'spcr.name', timestamp: 'spcr.timestamp',
  },
  automationPolicyCompliance: { deviceId: 'apc.deviceId', status: 'apc.status' },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', { user: { id: 'user-1' }, orgId: '11111111-1111-4111-8111-111111111111', scope: 'organization' });
    return next();
  }),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: { DEVICES_READ: { resource: 'devices', action: 'read' } },
}));

vi.mock('./helpers', () => ({
  SITE_ACCESS_DENIED: Symbol.for('site-access-denied'),
  getDeviceWithOrgAndSiteCheck: getDeviceWithOrgAndSiteCheckMock,
}));

import { tabCountsRoutes } from './tabCounts';

const device = {
  id: '22222222-2222-4222-8222-222222222222',
  orgId: '11111111-1111-4111-8111-111111111111',
};

function chainResolving(rows: unknown[]) {
  const thenable = Promise.resolve(rows);
  const chain: any = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    then: thenable.then.bind(thenable),
  };
  return chain;
}

/** Each db.select() call resolves, in order, to one of `counts`; the single
 *  db.selectDistinctOn() call (monitoring) resolves to `monitoringRows`. */
function queueSelects(counts: unknown[][], monitoringRows: unknown[]) {
  const queue = [...counts];
  selectMock.mockImplementation(() => chainResolving(queue.shift() ?? []));
  selectDistinctOnMock.mockImplementation(() => chainResolving(monitoringRows));
}

describe('GET /devices/:id/tab-counts', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    getDeviceWithOrgAndSiteCheckMock.mockResolvedValue(device);
    app = new Hono();
    app.route('/devices', tabCountsRoutes);
  });

  it('returns one count per signal tab, coerced to numbers', async () => {
    queueSelects([
      [{ count: '3' }], // alerts
      [{ count: '1' }], // anomalies
      [{ count: '2' }], // tickets
      [{ count: '0' }], // operator tasks
      [{ count: '4' }], // compliance
    ], [
      // monitoring: latest per watch — one failing, one healthy
      { watchType: 'service', name: 'spooler', status: 'stopped' },
      { watchType: 'process', name: 'agent', status: 'running' },
    ]);

    const res = await app.request(`/devices/${device.id}/tab-counts`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { alerts: 3, anomalies: 1, tickets: 2, operatorTasks: 0, monitoring: 1, compliance: 4 },
    });
    expect(selectMock).toHaveBeenCalledTimes(5);
    expect(selectDistinctOnMock).toHaveBeenCalledTimes(1);
  });

  it('counts OPEN anomaly episodes, not raw metric_anomalies rows (#6650)', async () => {
    queueSelects([[{ count: '0' }], [{ count: '2' }], [{ count: '0' }], [{ count: '0' }], [{ count: '0' }]], []);

    const res = await app.request(`/devices/${device.id}/tab-counts`);
    expect(res.status).toBe(200);
    expect((await res.json()).data.anomalies).toBe(2);

    // Second db.select() is the anomalies count.
    const anomalyChain = selectMock.mock.results[1]!.value;
    const [from] = anomalyChain.from.mock.calls[0]!;
    expect(from).toEqual({ deviceId: 'metricAnomalyEpisodes.deviceId', status: 'metricAnomalyEpisodes.status' });
    const [where] = anomalyChain.where.mock.calls[0]!;
    expect(where).toEqual({
      type: 'and',
      conditions: [
        { type: 'eq', left: 'metricAnomalyEpisodes.deviceId', right: device.id },
        // Snoozed episodes are status 'dismissed' (close_reason 'snoozed'), so
        // status = 'open' alone excludes both snoozed and resolved episodes.
        { type: 'eq', left: 'metricAnomalyEpisodes.status', right: 'open' },
      ],
    });
  });

  it('404s when the device is not visible to the caller', async () => {
    getDeviceWithOrgAndSiteCheckMock.mockResolvedValueOnce(null);
    const res = await app.request(`/devices/${device.id}/tab-counts`);
    expect(res.status).toBe(404);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('403s on a site-scope denial', async () => {
    getDeviceWithOrgAndSiteCheckMock.mockResolvedValueOnce(Symbol.for('site-access-denied'));
    const res = await app.request(`/devices/${device.id}/tab-counts`);
    expect(res.status).toBe(403);
  });
});
