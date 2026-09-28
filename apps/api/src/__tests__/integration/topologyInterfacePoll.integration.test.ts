import './setup';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import pollFixture from '../../../../../packages/shared/src/testing/topology-interface-poll-v1.json';
import metricFixture from '../../../../../packages/shared/src/testing/topology-interface-metrics-v1.json';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { orgContext } from './topology-fixtures';
import { topologyIngestFixture } from '../helpers/topologyIngest';
import { registerTopologyTelemetryAuthority, resolveTopologyTelemetryProducer, type TopologyTelemetryAuthorityRequest } from '../../services/topology/collectionAuthority';
import { ingestTopologyInterfacePollResult } from '../../services/topology/snmpInterfaceMetrics';

const TARGET = 'snmp:192.0.2.10';
const ARM = '77777777-7777-4777-8777-777777777777';
let generation = 'arm-1';
let allowed: string[] = [];
const requests: TopologyTelemetryAuthorityRequest[] = [];
let unregister: (() => void) | undefined;
beforeEach(() => {
  generation = 'arm-1'; allowed = []; requests.length = 0;
  // Stand-in for Track B's arm-backed `snmp` telemetry authority.
  unregister = registerTopologyTelemetryAuthority('snmp', async request => {
    requests.push(request);
    return request.authorityKey === TARGET ? { authorized: true, configurationGeneration: generation, interfaceIds: allowed } : { authorized: false, reason: 'arm_not_found' };
  });
});
afterEach(() => { unregister?.(); unregister = undefined; });

const system = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

async function fixture() {
  const f = await topologyIngestFixture();
  const scope = { orgId: f.orgId, siteId: f.siteId };
  const scoped = <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(f.orgId), fn);
  const [ifA, ifB] = [crypto.randomUUID(), crypto.randomUUID()];
  await scoped(async () => {
    await db.execute(sql`UPDATE organizations SET settings='{"topologyFeatureFlags":{"materialization":true,"interfaceHealth":true}}' WHERE id=${f.orgId}::uuid`);
    for (const [id, key] of [[ifA, 'port-7'], [ifB, 'port-8']] as const) {
      await db.execute(sql`INSERT INTO topology_interfaces (id, org_id, site_id, owner_node_id, interface_key, epoch, os_index)
        VALUES (${id}::uuid, ${f.orgId}::uuid, ${f.siteId}::uuid, ${f.nodeId}::uuid, ${key}, 'gen:1', ${key.slice(5)})`);
    }
  });
  allowed = [ifA, ifB];
  // Dispatch-time credentials, exactly as the arm dispatcher derives them.
  const producer = await scoped(() => resolveTopologyTelemetryProducer({ producerKind: 'snmp', deviceId: f.deviceId, scope, authorityKey: TARGET }));
  const dispatch = async (sequence: string, deviceId = f.deviceId) => {
    const commandId = crypto.randomUUID();
    const payload = {
      ...structuredClone(pollFixture.validV2c), binding: { orgId: f.orgId, siteId: f.siteId, authorityKey: TARGET, armId: ARM },
      producerEpoch: producer.producerEpoch, configurationRevision: producer.configurationRevision, sequence,
      interfaces: [{ interfaceId: ifA, interfaceEpoch: 'gen:1', ifIndex: 7, expectedName: null, expectedPhysAddress: null }],
    };
    await system(() => db.execute(sql`INSERT INTO device_commands (id,device_id,type,status,payload,target_role)
      VALUES (${commandId}::uuid,${deviceId}::uuid,'topology_interface_poll','sent',${JSON.stringify(payload)}::jsonb,'agent')`));
    return { commandId, payload };
  };
  const reply = (commandId: string, payload: { sequence: string; producerEpoch: string; configurationRevision: string }, interfaceId = ifA, atMs = Date.now() - 5_000) => ({
    schemaVersion: 1, family: 'if_metrics', producerEpoch: payload.producerEpoch, sequence: payload.sequence, commandId,
    configurationRevision: payload.configurationRevision, startedAt: new Date(atMs - 1000).toISOString(), finishedAt: new Date(atMs + 1000).toISOString(),
    captureAgeAtSendMs: null, expectedIntervalSeconds: 60, outcome: 'complete', reasonCode: null,
    samples: [{ ...structuredClone(metricFixture.valid.samples[0]!), interfaceId, interfaceEpoch: 'gen:1', sampledAt: new Date(atMs).toISOString() }],
  });
  const ingest = (commandId: string, value: unknown, deviceId = f.deviceId, status = 'completed') =>
    ingestTopologyInterfacePollResult({ commandType: 'topology_interface_poll', commandId, deviceId, status, stdout: JSON.stringify(value) });
  const samples = () => system(async () => Number((await db.execute(sql`SELECT count(*)::int AS n FROM topology_interface_samples WHERE org_id=${f.orgId}::uuid`))[0]!.n));
  return { ...f, scope, ifA, ifB, producer, dispatch, reply, ingest, samples };
}

describe('topology interface poll result adapter', () => {
  it('persists an authorized reply through the telemetry sink with the stored command as authority', async () => {
    const f = await fixture();
    const { commandId, payload } = await f.dispatch('1');
    const value = f.reply(commandId, payload);
    const receipt = await f.ingest(commandId, value);
    expect(receipt).toMatchObject({ commandId, accepted: true, inserted: 1, acceptedSequence: '1' });
    expect(await f.samples()).toBe(1);
    expect(requests.at(-1)).toMatchObject({ producerKind: 'snmp', authorityKey: TARGET, commandId, scope: f.scope });
    // Redelivery of the same reply (WS + REST race) is an idempotent replay, not a second write.
    expect(await f.ingest(commandId, value)).toMatchObject({ accepted: true, inserted: 0, duplicates: 1 });
    expect(await f.samples()).toBe(1);
  });

  it('refuses a port the command did not bind, even one the arm allows', async () => {
    const f = await fixture();
    const { commandId, payload } = await f.dispatch('1');
    expect(await f.ingest(commandId, f.reply(commandId, payload, f.ifB))).toMatchObject({ accepted: false, reason: 'interface_not_in_command' });
    expect(await f.samples()).toBe(0);
  });

  it('refuses a reply from another device and a reply for another command', async () => {
    const f = await fixture();
    const other = await topologyIngestFixture();
    const { commandId, payload } = await f.dispatch('1');
    expect(await f.ingest(commandId, f.reply(commandId, payload), other.deviceId)).toMatchObject({ accepted: false, reason: 'command_not_owned' });
    expect(await f.ingest(commandId, f.reply(crypto.randomUUID(), payload))).toMatchObject({ accepted: false, reason: 'envelope_command_mismatch' });
    expect(await f.ingest(crypto.randomUUID(), f.reply(commandId, payload))).toMatchObject({ accepted: false, reason: 'command_not_found' });
    expect(await f.samples()).toBe(0);
  });

  it('fences a late reply after the arm generation changed (credential/config revision)', async () => {
    const f = await fixture();
    const { commandId, payload } = await f.dispatch('1');
    generation = 'arm-2';
    expect(await f.ingest(commandId, f.reply(commandId, payload))).toMatchObject({ accepted: false, reason: 'producer_epoch_changed' });
    expect(await f.samples()).toBe(0);
  });

  it('fences a reply once the arm is revoked', async () => {
    const f = await fixture();
    const { commandId, payload } = await f.dispatch('1');
    unregister?.(); unregister = registerTopologyTelemetryAuthority('snmp', async () => ({ authorized: false, reason: 'arm_revoked' }));
    expect(await f.ingest(commandId, f.reply(commandId, payload))).toMatchObject({ accepted: false, reason: 'producer_authority_denied' });
    expect(await f.samples()).toBe(0);
  });

  it('ignores an agent-side failure and other command types', async () => {
    const f = await fixture();
    const { commandId, payload } = await f.dispatch('1');
    expect(await f.ingest(commandId, f.reply(commandId, payload), f.deviceId, 'failed')).toBeNull();
    expect(await ingestTopologyInterfacePollResult({ commandType: 'snmp_poll', commandId, deviceId: f.deviceId, status: 'completed', stdout: '{}' })).toBeNull();
    expect(await f.samples()).toBe(0);
  });
});
