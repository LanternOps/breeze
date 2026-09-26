import { describe, expect, it } from 'vitest';
import { topologyInterfaceMeasurementSchema } from '@breeze/shared';
import {
  assessTopologyInterfaceMeasurement, interfaceMeasurementContributions, topologyInterfaceEvidenceApplies,
  type InterfaceMeasurementInput, type InterfaceMeasurementSample,
} from './interfaceHealth';

const IF = '11111111-1111-4111-8111-111111111111';
const IF_B = '11111111-1111-4111-8111-222222222222';
const SOURCE = '22222222-2222-4222-8222-222222222222';
const REL = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-11-02T12:00:00Z');
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

function sample(secondsAgo: number, over: Partial<InterfaceMeasurementSample['readings']> = {}, meta: Partial<InterfaceMeasurementSample> = {}): InterfaceMeasurementSample {
  const uptime = 1_000_000 - secondsAgo * 100;
  return {
    sourceId: SOURCE, sourceKind: 'snmp', producerEpoch: 'p1', sourceRevoked: false, sourceLastReceivedAt: ago(Math.max(secondsAgo - 1, 0)),
    sampledAt: ago(secondsAgo),
    readings: {
      v: 1, expectedIntervalSeconds: 60, counterWidth: 64, inOctets: String(10_000_000 - secondsAgo * 1000), outOctets: '0',
      inErrors: '0', outErrors: '0', inDiscards: '0', outDiscards: '0', inPackets: null, outPackets: null, capacityBps: '1000000000',
      discontinuityTicks: '0', deviceUptimeTicks: String(uptime), reportedInBps: null, reportedOutBps: null,
      adminStatus: 'up', operStatus: 'up', unavailable: {}, ...over,
    },
    ...meta,
  };
}
const input = (samples: InterfaceMeasurementSample[], over: Partial<InterfaceMeasurementInput> = {}): InterfaceMeasurementInput =>
  ({ interfaceId: IF, interfaceEpoch: 'gen:1', retired: false, samples, ...over });
const assess = (value: InterfaceMeasurementInput) => {
  const result = assessTopologyInterfaceMeasurement(value, NOW);
  expect(topologyInterfaceMeasurementSchema.safeParse(result).success, JSON.stringify(result)).toBe(true);
  return result;
};

describe('assessTopologyInterfaceMeasurement', () => {
  it('is healthy for a fresh up port with a continuous quiet window and reports that endpoint\'s own rates', () => {
    const result = assess(input([sample(10), sample(70)]));
    expect(result).toMatchObject({ status: 'healthy', coverage: 'monitored', freshness: 'fresh', reasons: [], operStatus: 'up', adminStatus: 'up',
      observedAt: ago(10).toISOString(), expectedIntervalSeconds: 60 });
    // Freshness = max(3 × cadence, 60 s) after the observation.
    expect(result.freshUntil).toBe(new Date(ago(10).getTime() + 180_000).toISOString());
    expect(result.rates?.values.find(rate => rate.name === 'in_bps')).toEqual({ name: 'in_bps', unit: 'bits_per_second', value: 8000, reason: null });
  });

  it('labels a fresh explicit operStatus=down as a failed port check only when admin is up', () => {
    expect(assess(input([sample(10, { operStatus: 'down' })]))).toMatchObject({ status: 'failed_check', reasons: expect.arrayContaining(['interface_link_down']) });
    expect(assess(input([sample(10, { operStatus: 'lower_layer_down' })]))).toMatchObject({ status: 'failed_check' });
  });

  it('treats administratively disabled as an expected state and unknown admin status as no fault claim', () => {
    const disabled = assess(input([sample(10, { adminStatus: 'down', operStatus: 'down' })]));
    expect(disabled.status).toBe('degraded');
    expect(disabled.reasons).toContain('interface_admin_disabled');
    expect(disabled.reasons).not.toContain('interface_link_down');
    const unknownAdmin = assess(input([sample(10, { adminStatus: 'unknown', operStatus: 'down' })]));
    expect(unknownAdmin.status).not.toBe('failed_check');
    expect(unknownAdmin.reasons).toContain('interface_admin_status_unknown');
  });

  it('degrades on errors or discards at the fixed thresholds from one continuous window', () => {
    const errors = assess(input([sample(10, { inErrors: '60' }), sample(70)]));
    expect(errors).toMatchObject({ status: 'degraded', reasons: ['interface_errors_elevated'] });
    const below = assess(input([sample(10, { inErrors: '59' }), sample(70)]));
    expect(below.status).toBe('healthy');
    const discards = assess(input([sample(10, { outDiscards: '600' }), sample(70)]));
    expect(discards).toMatchObject({ status: 'degraded', reasons: ['interface_discards_elevated'] });
  });

  it('never derives a rate across a generation, source or restart boundary', () => {
    const restarted = assess(input([sample(10, { deviceUptimeTicks: '5', inErrors: '9999' }), sample(70)]));
    expect(restarted.status).toBe('healthy');
    expect(restarted.coverage).toBe('partial');
    expect(restarted.rates).toBeNull();
    expect(restarted.reasons).toContain('interface_rates_unavailable');
    const otherSource = assess(input([sample(10, { inErrors: '9999' }), sample(70, {}, { sourceId: '44444444-4444-4444-8444-444444444444' })]));
    expect(otherSource.rates).toBeNull();
  });

  it('is stale after the freshness window and does not let a future agent timestamp extend it', () => {
    const stale = assess(input([sample(181)]));
    expect(stale).toMatchObject({ status: 'unknown', coverage: 'partial', freshness: 'stale', reasons: ['interface_measurement_stale'] });
    // Sample claims a future time but the server received it 170 s ago: freshness is bounded by receipt.
    const future = assess(input([sample(-120, {}, { sourceLastReceivedAt: ago(170) })]));
    expect(future.observedAt).toBe(ago(170).toISOString());
    expect(future.freshness).toBe('fresh');
    expect(future.freshUntil).toBe(new Date(ago(170).getTime() + 180_000).toISOString());
    expect(assess(input([sample(-120, {}, { sourceLastReceivedAt: ago(200) })])).freshness).toBe('stale');
  });

  it('reports unmeasured, stopped (revoked source) and retired generations without a status claim', () => {
    expect(assess(input([]))).toMatchObject({ status: 'unknown', coverage: 'unmonitored', freshness: 'unknown', reasons: ['interface_unmeasured'], operStatus: null });
    const stopped = assess(input([sample(5, {}, { sourceRevoked: true })]));
    expect(stopped).toMatchObject({ status: 'unknown', coverage: 'unmonitored', reasons: ['interface_measurement_stopped'], operStatus: null, freshUntil: null });
    expect(assess(input([sample(5)], { retired: true }))).toMatchObject({ status: 'unknown', coverage: 'unavailable', reasons: ['interface_generation_retired'], retired: true });
  });

  it('never claims a status for an unknown oper state', () => {
    expect(assess(input([sample(10, { operStatus: 'unknown' })]))).toMatchObject({ status: 'unknown', reasons: expect.arrayContaining(['interface_oper_status_unknown']) });
  });
});

describe('topologyInterfaceEvidenceApplies', () => {
  const rel = { id: REL, kind: 'physical_link' as const, evidenceClass: 'observed' as const, sourceInterfaceId: IF, targetInterfaceId: null };
  it('applies port evidence only to identified observed/manual physical links', () => {
    expect(topologyInterfaceEvidenceApplies(rel)).toEqual({ applies: true, reason: null });
    expect(topologyInterfaceEvidenceApplies({ ...rel, kind: 'network_member' })).toEqual({ applies: false, reason: 'not_a_physical_link' });
    expect(topologyInterfaceEvidenceApplies({ ...rel, evidenceClass: 'inferred' })).toEqual({ applies: false, reason: 'inferred_relationship' });
    expect(topologyInterfaceEvidenceApplies({ ...rel, sourceInterfaceId: null })).toEqual({ applies: false, reason: 'interface_unresolved' });
  });

  it('contributes one view per endpoint in one shared context, never for an inferred membership edge', () => {
    const measurements = new Map([[IF, assess(input([sample(10, { operStatus: 'down' })]))], [IF_B, assess(input([sample(10)], { interfaceId: IF_B }))]]);
    const both = interfaceMeasurementContributions({ ...rel, targetInterfaceId: IF_B }, measurements);
    expect(both.map(c => [c.key, c.contextKey, c.status])).toEqual([[`interface:source:${IF}`, 'interface', 'failed_check'], [`interface:target:${IF_B}`, 'interface', 'healthy']]);
    expect(interfaceMeasurementContributions({ ...rel, kind: 'network_member', targetInterfaceId: IF_B }, measurements)).toEqual([]);
    expect(interfaceMeasurementContributions({ ...rel, evidenceClass: 'inferred' }, measurements)).toEqual([]);
  });
});
