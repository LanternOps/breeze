import { describe, expect, it } from 'vitest';
import pollFixture from '../../../../../packages/shared/src/testing/topology-interface-poll-v1.json';
import metricFixture from '../../../../../packages/shared/src/testing/topology-interface-metrics-v1.json';
import { normalizeSnmpInterfaceMetrics, TopologyInterfacePollRejection } from './snmpInterfaceMetrics';

const COMMAND_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '88888888-8888-4888-8888-888888888888';
const payload = pollFixture.valid;
const command = { id: COMMAND_ID, deviceId: DEVICE_ID, type: 'topology_interface_poll', payload };
const sample = (interfaceId: string, interfaceEpoch: string) => ({ ...structuredClone(metricFixture.valid.samples[0]!), interfaceId, interfaceEpoch, sampledAt: '2026-11-02T10:00:01Z' });
const envelope = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, family: 'if_metrics', producerEpoch: payload.producerEpoch, sequence: payload.sequence, commandId: COMMAND_ID,
  configurationRevision: payload.configurationRevision, startedAt: '2026-11-02T10:00:00Z', finishedAt: '2026-11-02T10:00:03Z', captureAgeAtSendMs: null,
  expectedIntervalSeconds: payload.expectedIntervalSeconds, outcome: 'complete', reasonCode: null,
  samples: [sample(payload.interfaces[0]!.interfaceId, payload.interfaces[0]!.interfaceEpoch)], ...over,
});
const reject = (fn: () => unknown, reason: string) => {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(TopologyInterfacePollRejection);
    expect((error as TopologyInterfacePollRejection).reason).toBe(reason);
    return;
  }
  throw new Error(`expected rejection ${reason}`);
};

describe('normalizeSnmpInterfaceMetrics', () => {
  it('derives scope and authority from the stored command, never from the reply', () => {
    const result = normalizeSnmpInterfaceMetrics(command, { deviceId: DEVICE_ID }, { stdout: JSON.stringify(envelope()) });
    expect(result.scope).toEqual({ orgId: payload.binding.orgId, siteId: payload.binding.siteId });
    expect(result.authorityKey).toBe(payload.binding.authorityKey);
    expect(result.envelope.samples).toHaveLength(1);
    expect(result.expected).toEqual({ producerEpoch: payload.producerEpoch, configurationRevision: payload.configurationRevision });
  });

  it('accepts a structured result object as well as JSON stdout', () => {
    expect(normalizeSnmpInterfaceMetrics(command, { deviceId: DEVICE_ID }, { result: envelope() }).envelope.sequence).toBe(payload.sequence);
  });

  it('parses a terminally-erased stored payload (secrets stripped)', () => {
    const erased = { ...command, payload: pollFixture.erased };
    expect(normalizeSnmpInterfaceMetrics(erased, { deviceId: DEVICE_ID }, { result: envelope() }).authorityKey).toBe(payload.binding.authorityKey);
  });

  it('rejects another command type, another device and a corrupt stored payload', () => {
    reject(() => normalizeSnmpInterfaceMetrics({ ...command, type: 'snmp_poll' }, { deviceId: DEVICE_ID }, { result: envelope() }), 'command_type_mismatch');
    reject(() => normalizeSnmpInterfaceMetrics(command, { deviceId: '99999999-9999-4999-8999-999999999999' }, { result: envelope() }), 'command_not_owned');
    reject(() => normalizeSnmpInterfaceMetrics({ ...command, payload: { version: 1 } }, { deviceId: DEVICE_ID }, { result: envelope() }), 'command_payload_invalid');
  });

  it('rejects an invalid or unparseable reply', () => {
    reject(() => normalizeSnmpInterfaceMetrics(command, { deviceId: DEVICE_ID }, { stdout: 'not json' }), 'invalid_envelope');
    reject(() => normalizeSnmpInterfaceMetrics(command, { deviceId: DEVICE_ID }, { result: { ...envelope(), orgId: payload.binding.orgId } }), 'invalid_envelope');
  });

  it.each([
    ['another command', { commandId: '44444444-4444-4444-8444-444444444444' }],
    ['a standing-stream reply', { commandId: null }],
    ['another sequence', { sequence: '43' }],
    ['another producer epoch', { producerEpoch: 'c'.repeat(64) }],
    ['another configuration revision', { configurationRevision: 'd'.repeat(64) }],
    ['another cadence', { expectedIntervalSeconds: 120 }],
  ])('rejects a reply for %s', (_name, over) => {
    reject(() => normalizeSnmpInterfaceMetrics(command, { deviceId: DEVICE_ID }, { result: envelope(over) }), 'envelope_command_mismatch');
  });

  it('rejects a port outside the command mapping or under another epoch', () => {
    reject(() => normalizeSnmpInterfaceMetrics(command, { deviceId: DEVICE_ID }, { result: envelope({ samples: [sample('55555555-5555-4555-8555-000000000001', 'gen:1')] }) }), 'interface_not_in_command');
    reject(() => normalizeSnmpInterfaceMetrics(command, { deviceId: DEVICE_ID }, { result: envelope({ samples: [sample(payload.interfaces[0]!.interfaceId, 'gen:2')] }) }), 'interface_not_in_command');
  });
});
