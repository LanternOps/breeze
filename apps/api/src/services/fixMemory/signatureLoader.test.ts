import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rows } = vi.hoisted(() => ({ rows: [] as unknown[][] }));
vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve(rows.shift() ?? []).then(r);
  return { db: chain };
});

import { computeSignature } from './signature';
import { alertSignature, signatureForSource, sourceRefFor } from './signatureLoader';

describe('signatureLoader', () => {
  beforeEach(() => { rows.length = 0; });

  it('rule alert: rule override conditions win over the template', async () => {
    rows.push(
      [{ id: 'a-1', deviceId: 'd-1', ruleId: 'r-1', context: {}, requiresHuman: false }],
      [{ osType: 'windows' }],
      [{ templateId: 't-1', overrideSettings: { conditions: { type: 'service_stopped', serviceName: 'Spooler' } } }],
    );
    const out = await alertSignature('a-1');
    const expected = computeSignature({ family: 'alert', condition: 'rule:service_stopped', osFamily: 'windows', discriminator: { kind: 'service', value: 'spooler' }, rootInferred: false })!;
    expect(out).toEqual({ signature: expected, deviceId: 'd-1', alertId: 'a-1', anomalyEpisodeId: null });
  });

  it('metric_anomaly alert maps to the anomaly family via the anomaly row', async () => {
    rows.push(
      [{ id: 'a-2', deviceId: 'd-1', ruleId: null, context: { source: 'metric_anomaly', anomalyId: 'm-1' }, requiresHuman: false }],
      [{ osType: 'linux' }],
      [{ sourceTable: 'device_metrics', anomalyType: 'spike', metricName: 'cpu_percent', episodeId: 'ep-1', deviceId: 'd-1' }],
    );
    const out = await alertSignature('a-2');
    expect(out!.signature.facets).toMatchObject({ family: 'anomaly', condition: 'anomaly:device_metrics:spike:cpu', osFamily: 'linux' });
    expect(out!.signature.broad).toBe(true);
  });

  it('correlation uses the root alert with family correlation', async () => {
    rows.push(
      [{ rootAlertId: 'a-9' }],
      [{ id: 'a-9', deviceId: 'd-2', ruleId: null, context: { source: 'network_monitor', monitorType: 'ping' }, requiresHuman: false }],
      [{ osType: 'macos' }],
    );
    const out = await signatureForSource({ kind: 'correlation', correlationGroupId: 'g-1' });
    expect(out!.signature.facets).toMatchObject({ family: 'correlation', rootInferred: true, condition: 'sourced:network_monitor:ping' });
    expect(out!.alertId).toBe('a-9');
  });

  it('returns null for a missing alert or an unknown OS', async () => {
    rows.push([]);
    expect(await alertSignature('nope')).toBeNull();
    rows.push([{ id: 'a-3', deviceId: 'd-3', ruleId: null, context: { source: 'network_monitor', monitorType: 'ping' }, requiresHuman: false }], [{ osType: 'solaris' }]);
    expect(await alertSignature('a-3')).toBeNull();
  });

  it('sourceRefFor maps suggestion sources and refuses rca', () => {
    expect(sourceRefFor({ sourceType: 'alert', sourceId: 'a' })).toEqual({ kind: 'alert', alertId: 'a' });
    expect(sourceRefFor({ sourceType: 'anomaly', sourceId: 'm', anomalyEpisodeId: 'ep' })).toEqual({ kind: 'anomaly', anomalyId: 'm', anomalyEpisodeId: 'ep' });
    expect(sourceRefFor({ sourceType: 'correlation', sourceId: 'g' })).toEqual({ kind: 'correlation', correlationGroupId: 'g' });
    expect(sourceRefFor({ sourceType: 'rca', sourceId: 'x' })).toBeNull();
  });
});
