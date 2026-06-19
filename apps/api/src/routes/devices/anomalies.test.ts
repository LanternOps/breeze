import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  selectMock,
  updateMock,
  emitAnomalyFeedbackMock,
  promoteMetricAnomalyToAlertMock,
  getDeviceWithOrgAndSiteCheckMock,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  emitAnomalyFeedbackMock: vi.fn(),
  promoteMetricAnomalyToAlertMock: vi.fn(),
  getDeviceWithOrgAndSiteCheckMock: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ type: 'and', conditions }),
  desc: (column: unknown) => ({ type: 'desc', column }),
  eq: (left: unknown, right: unknown) => ({ type: 'eq', left, right }),
  ne: (left: unknown, right: unknown) => ({ type: 'ne', left, right }),
}));

vi.mock('../../db', () => ({
  db: {
    select: selectMock,
    update: updateMock,
  },
}));

vi.mock('../../db/schema', () => ({
  metricAnomalies: {
    id: 'metricAnomalies.id',
    orgId: 'metricAnomalies.orgId',
    deviceId: 'metricAnomalies.deviceId',
    status: 'metricAnomalies.status',
    detectedAt: 'metricAnomalies.detectedAt',
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com' },
      orgId: '11111111-1111-4111-8111-111111111111',
      scope: 'organization',
    });
    return next();
  }),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../services/metricAnomalyPromotion', () => ({
  promoteMetricAnomalyToAlert: promoteMetricAnomalyToAlertMock,
}));

vi.mock('../../services/mlFeedbackEmitters', () => ({
  emitAnomalyFeedback: emitAnomalyFeedbackMock,
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    ALERTS_WRITE: { resource: 'alerts', action: 'write' },
    DEVICES_READ: { resource: 'devices', action: 'read' },
  },
}));

vi.mock('./helpers', () => ({
  SITE_ACCESS_DENIED: Symbol.for('site-access-denied'),
  getDeviceWithOrgAndSiteCheck: getDeviceWithOrgAndSiteCheckMock,
}));

import { anomaliesRoutes } from './anomalies';

const device = {
  id: '22222222-2222-4222-8222-222222222222',
  orgId: '11111111-1111-4111-8111-111111111111',
};

const anomaly = {
  id: '33333333-3333-4333-8333-333333333333',
  orgId: device.orgId,
  deviceId: device.id,
  sourceTable: 'device_metrics',
  metricType: 'system',
  metricName: 'cpu_percent',
  anomalyType: 'spike',
  status: 'open',
  windowStart: new Date('2026-06-18T12:00:00.000Z'),
  windowEnd: new Date('2026-06-18T12:05:00.000Z'),
  bucketSeconds: 300,
  observedValue: 95,
  baselineValue: 40,
  baselineMin: 10,
  baselineMax: 60,
  score: 7,
  confidence: 0.88,
  sampleCount: 5,
  baselineSummary: {},
  evidence: {},
  linkedAlertId: null,
  linkedCorrelationGroupId: null,
  detectedAt: new Date('2026-06-18T12:06:00.000Z'),
  resolvedAt: null,
  updatedAt: new Date('2026-06-18T12:06:00.000Z'),
};

function updateChain(result: unknown) {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(result),
      }),
    }),
  };
}

function selectChain(result: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(result),
      }),
    }),
  };
}

describe('device anomaly routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    getDeviceWithOrgAndSiteCheckMock.mockResolvedValue(device);
    emitAnomalyFeedbackMock.mockResolvedValue(undefined);
    app = new Hono();
    app.route('/devices', anomaliesRoutes);
  });

  it('promotes an anomaly through the anomaly-to-alert service', async () => {
    promoteMetricAnomalyToAlertMock.mockResolvedValueOnce({
      status: 'promoted',
      anomaly: { ...anomaly, status: 'promoted', linkedAlertId: '44444444-4444-4444-8444-444444444444' },
      alertId: '44444444-4444-4444-8444-444444444444',
      created: true,
    });

    const res = await app.request(`/devices/${device.id}/anomalies/${anomaly.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ status: 'promoted', note: 'Escalate this' }),
    });

    expect(res.status).toBe(200);
    expect(promoteMetricAnomalyToAlertMock).toHaveBeenCalledWith({
      orgId: device.orgId,
      deviceId: device.id,
      anomalyId: anomaly.id,
      actorUserId: 'user-1',
      requireCreateAlertsFlag: false,
    });
    expect(updateMock).not.toHaveBeenCalled();
    expect(emitAnomalyFeedbackMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'anomaly.promoted',
      dedupeKey: 'promoted:alert:44444444-4444-4444-8444-444444444444',
      outcome: 'promoted',
      occurredAt: anomaly.updatedAt,
      metadata: expect.objectContaining({
        linkedAlertId: '44444444-4444-4444-8444-444444444444',
        createdAlert: true,
      }),
    }));
    const body = await res.json();
    expect(body.data.status).toBe('promoted');
    expect(body.data.linkedAlertId).toBe('44444444-4444-4444-8444-444444444444');
  });

  it('returns 409 when anomaly alert promotion is disabled', async () => {
    promoteMetricAnomalyToAlertMock.mockResolvedValueOnce({
      status: 'disabled',
      anomaly,
    });

    const res = await app.request(`/devices/${device.id}/anomalies/${anomaly.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ status: 'promoted' }),
    });

    expect(res.status).toBe(409);
    expect(emitAnomalyFeedbackMock).not.toHaveBeenCalled();
  });

  it('keeps dismissed status updates on the existing direct update path', async () => {
    const transitionAt = new Date('2026-06-18T12:10:00.000Z');
    updateMock.mockReturnValueOnce(updateChain([{ ...anomaly, status: 'dismissed', updatedAt: transitionAt }]));

    const res = await app.request(`/devices/${device.id}/anomalies/${anomaly.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ status: 'dismissed' }),
    });

    expect(res.status).toBe(200);
    expect(promoteMetricAnomalyToAlertMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalled();
    expect(emitAnomalyFeedbackMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'anomaly.dismissed',
      outcome: 'dismissed',
      occurredAt: transitionAt,
    }));
  });

  it('returns an existing same-status anomaly without emitting duplicate feedback', async () => {
    const existingDismissed = {
      ...anomaly,
      status: 'dismissed',
      updatedAt: new Date('2026-06-18T12:10:00.000Z'),
    };
    updateMock.mockReturnValueOnce(updateChain([]));
    selectMock.mockReturnValueOnce(selectChain([existingDismissed]));

    const res = await app.request(`/devices/${device.id}/anomalies/${anomaly.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ status: 'dismissed' }),
    });

    expect(res.status).toBe(200);
    expect(emitAnomalyFeedbackMock).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.data.status).toBe('dismissed');
    expect(body.data.updatedAt).toBe('2026-06-18T12:10:00.000Z');
  });
});
