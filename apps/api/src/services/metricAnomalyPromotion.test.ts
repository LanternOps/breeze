import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  selectMock,
  insertMock,
  updateMock,
  shouldProduceMlOutputMock,
  publishEventMock,
  resolveDeviceSiteIdMock,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  insertMock: vi.fn(),
  updateMock: vi.fn(),
  shouldProduceMlOutputMock: vi.fn(),
  publishEventMock: vi.fn(),
  resolveDeviceSiteIdMock: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ type: 'and', conditions }),
  eq: (left: unknown, right: unknown) => ({ type: 'eq', left, right }),
  ne: (left: unknown, right: unknown) => ({ type: 'ne', left, right }),
}));

vi.mock('../db', () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
  },
}));

vi.mock('../db/schema', () => ({
  alerts: {
    id: 'alerts.id',
  },
  metricAnomalies: {
    id: 'metricAnomalies.id',
    orgId: 'metricAnomalies.orgId',
    deviceId: 'metricAnomalies.deviceId',
  },
}));

vi.mock('./eventBus', () => ({
  publishEvent: publishEventMock,
}));

vi.mock('./mlFeatureFlags', () => ({
  shouldProduceMlOutput: shouldProduceMlOutputMock,
}));

vi.mock('./deviceSiteResolver', () => ({
  resolveDeviceSiteId: resolveDeviceSiteIdMock,
}));

import { promoteMetricAnomalyToAlert } from './metricAnomalyPromotion';

const anomaly = {
  id: '33333333-3333-4333-8333-333333333333',
  orgId: '11111111-1111-4111-8111-111111111111',
  deviceId: '22222222-2222-4222-8222-222222222222',
  sourceTable: 'device_metrics',
  metricType: 'system',
  metricName: 'cpu_percent',
  anomalyType: 'spike',
  status: 'open',
  windowStart: new Date('2026-06-18T12:00:00.000Z'),
  windowEnd: new Date('2026-06-18T12:05:00.000Z'),
  bucketSeconds: 300,
  observedValue: 97.3,
  baselineValue: 45.1,
  baselineMin: 20,
  baselineMax: 60,
  score: 8,
  confidence: 0.87,
  sampleCount: 5,
  baselineSummary: { modelVersion: 'metric-anomalies-v1' },
  evidence: {},
  linkedAlertId: null,
  linkedCorrelationGroupId: null,
  detectedAt: new Date('2026-06-18T12:06:00.000Z'),
  resolvedAt: null,
  updatedAt: new Date('2026-06-18T12:06:00.000Z'),
};

function chain(result: unknown) {
  const c: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'values', 'set']) {
    c[method] = vi.fn(() => c);
  }
  c.returning = vi.fn(() => Promise.resolve(result));
  c.then = (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return c;
}

describe('metric anomaly promotion service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shouldProduceMlOutputMock.mockResolvedValue(true);
    publishEventMock.mockResolvedValue('event-1');
    resolveDeviceSiteIdMock.mockResolvedValue('site-1');
  });

  it('creates an alert, links the anomaly, and publishes alert.triggered', async () => {
    selectMock.mockReturnValueOnce(chain([anomaly]));
    selectMock.mockReturnValueOnce(chain([])); // dedupe siblings lookup
    insertMock.mockReturnValueOnce(chain([{ id: '44444444-4444-4444-8444-444444444444' }]));
    updateMock.mockReturnValueOnce(chain([{ ...anomaly, status: 'promoted', linkedAlertId: '44444444-4444-4444-8444-444444444444' }]));

    const result = await promoteMetricAnomalyToAlert({
      orgId: anomaly.orgId,
      deviceId: anomaly.deviceId,
      anomalyId: anomaly.id,
      actorUserId: 'user-1',
    });

    expect(result).toMatchObject({
      status: 'promoted',
      alertId: '44444444-4444-4444-8444-444444444444',
      created: true,
    });
    expect(shouldProduceMlOutputMock).toHaveBeenCalledWith(anomaly.orgId, 'ml.anomalies.create_alerts');
    expect(insertMock).toHaveBeenCalledWith(expect.anything());
    expect(updateMock).toHaveBeenCalledWith(expect.anything());
    expect(publishEventMock).toHaveBeenCalledWith(
      'alert.triggered',
      anomaly.orgId,
      expect.objectContaining({
        alertId: '44444444-4444-4444-8444-444444444444',
        ruleId: null,
        deviceId: anomaly.deviceId,
        source: 'metric-anomaly',
        anomalyId: anomaly.id,
      }),
      'metric-anomaly-promotion',
      expect.objectContaining({ userId: 'user-1', siteId: 'site-1' }),
    );
  });

  it('reuses a sibling anomaly alert instead of creating a duplicate incident', async () => {
    // network_egress can be emitted twice for one event: once for
    // bandwidth_out_bps (baseline) and once for top_process_net_bps_sum
    // (process runaway). Promoting the second one must reuse the first alert.
    const requested = {
      ...anomaly,
      id: '55555555-5555-4555-8555-555555555555',
      metricName: 'top_process_net_bps_sum',
      anomalyType: 'network_egress',
      linkedAlertId: null,
      status: 'open',
    };
    const promotedSibling = {
      ...anomaly,
      id: '66666666-6666-4666-8666-666666666666',
      metricName: 'bandwidth_out_bps',
      anomalyType: 'network_egress',
      linkedAlertId: 'alert-from-sibling',
      status: 'promoted',
    };

    selectMock.mockReturnValueOnce(chain([requested]));
    selectMock.mockReturnValueOnce(chain([promotedSibling])); // dedupe siblings lookup
    updateMock.mockReturnValueOnce(chain([{ ...requested, status: 'promoted', linkedAlertId: 'alert-from-sibling' }]));

    const result = await promoteMetricAnomalyToAlert({
      orgId: requested.orgId,
      deviceId: requested.deviceId,
      anomalyId: requested.id,
      actorUserId: 'user-1',
    });

    expect(result).toMatchObject({
      status: 'promoted',
      alertId: 'alert-from-sibling',
      created: false,
    });
    // No new alert and no second alert.triggered event for the duplicate row.
    expect(insertMock).not.toHaveBeenCalled();
    expect(publishEventMock).not.toHaveBeenCalled();
    // The duplicate row is still linked + marked promoted.
    expect(updateMock).toHaveBeenCalledWith(expect.anything());
  });

  it('is idempotent when the anomaly is already linked to an alert', async () => {
    selectMock.mockReturnValueOnce(chain([{ ...anomaly, status: 'promoted', linkedAlertId: 'alert-existing' }]));

    const result = await promoteMetricAnomalyToAlert({
      orgId: anomaly.orgId,
      deviceId: anomaly.deviceId,
      anomalyId: anomaly.id,
    });

    expect(result).toMatchObject({
      status: 'promoted',
      alertId: 'alert-existing',
      created: false,
    });
    expect(shouldProduceMlOutputMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it('suppresses alert creation when anomaly alert promotion is disabled', async () => {
    selectMock.mockReturnValueOnce(chain([anomaly]));
    selectMock.mockReturnValueOnce(chain([])); // dedupe siblings lookup
    shouldProduceMlOutputMock.mockResolvedValue(false);

    const result = await promoteMetricAnomalyToAlert({
      orgId: anomaly.orgId,
      deviceId: anomaly.deviceId,
      anomalyId: anomaly.id,
    });

    expect(result).toMatchObject({ status: 'disabled' });
    expect(insertMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it('allows explicit manual promotion even when automatic anomaly alert creation is disabled', async () => {
    selectMock.mockReturnValueOnce(chain([anomaly]));
    selectMock.mockReturnValueOnce(chain([])); // dedupe siblings lookup
    shouldProduceMlOutputMock.mockResolvedValue(false);
    insertMock.mockReturnValueOnce(chain([{ id: '44444444-4444-4444-8444-444444444444' }]));
    updateMock.mockReturnValueOnce(chain([{ ...anomaly, status: 'promoted', linkedAlertId: '44444444-4444-4444-8444-444444444444' }]));

    const result = await promoteMetricAnomalyToAlert({
      orgId: anomaly.orgId,
      deviceId: anomaly.deviceId,
      anomalyId: anomaly.id,
      actorUserId: 'user-1',
      requireCreateAlertsFlag: false,
    });

    expect(result).toMatchObject({
      status: 'promoted',
      alertId: '44444444-4444-4444-8444-444444444444',
      created: true,
    });
    expect(shouldProduceMlOutputMock).not.toHaveBeenCalled();
    expect(insertMock).toHaveBeenCalledWith(expect.anything());
    expect(updateMock).toHaveBeenCalledWith(expect.anything());
    expect(publishEventMock).toHaveBeenCalled();
  });
});
