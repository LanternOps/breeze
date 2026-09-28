import { and, eq } from 'drizzle-orm';
import { pgErrorCode } from '@breeze/shared/pgErrors';
import {
  parseTopologyInterfaceMetricEnvelopeV1, TOPOLOGY_INTERFACE_POLL_COMMAND_TYPE, topologyInterfacePollCommandV1Schema,
  type TopologyInterfaceMetricEnvelopeV1, type TopologyScope,
} from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { deviceCommands, topologyTelemetryArms } from '../../db/schema';
import { getPermissionAuthorityVersion } from '../permissions';
import { captureException } from '../sentry';
import { resolveTopologyTelemetryProducer, TOPOLOGY_TELEMETRY_PRODUCER_REJECTIONS } from './collectionAuthority';
import { persistTopologyInterfaceSamples, type TopologyInterfaceSampleReceipt } from './interfaceSamples';
import { topologyArmActorId, withPreResolvedArmPermissionVersions } from './telemetryArmFence';

/**
 * SNMP interface poll result adapter (M3 Task 3, amendment M3-D2).
 *
 * The agent answers a `topology_interface_poll` command with an if_metrics
 * envelope. Nothing in that reply is authority: scope, target authority key and
 * the ifIndex→interface mapping come from the STORED command the server built
 * (device_commands is server-written), the reply must echo the command's
 * identity, sequence and producer credentials exactly, and every sample must be
 * a (UUID, epoch) the command bound. The telemetry producer is then re-derived
 * from current DB state (`resolveTopologyTelemetryProducer` → the registered
 * arm-backed `snmp` authority) and the sink re-verifies it again under its own
 * locks, so a revoked arm, rotated credential or moved device is fenced no
 * matter when the late result lands. Both result transports (WS and REST) call
 * `ingestTopologyInterfacePollResult`.
 */
export type TopologyInterfacePollRejectionReason =
  | 'command_type_mismatch' | 'command_not_owned' | 'command_payload_invalid' | 'invalid_envelope' | 'envelope_command_mismatch' | 'interface_not_in_command';
export class TopologyInterfacePollRejection extends Error {
  constructor(readonly reason: TopologyInterfacePollRejectionReason) { super(reason); this.name = 'TopologyInterfacePollRejection'; }
}

export type StoredInterfacePollCommand = { id: string; deviceId: string; type: string; payload: unknown };
export type InterfacePollReply = { result?: unknown; stdout?: string | null };
export type NormalizedInterfacePoll = {
  scope: TopologyScope; authorityKey: string; armId: string; envelope: TopologyInterfaceMetricEnvelopeV1;
  /** Producer credentials the dispatcher pinned; a producer that re-derives differently is stale. */
  expected: { producerEpoch: string; configurationRevision: string };
};

function replyValue(reply: InterfacePollReply): unknown {
  if (reply.result !== undefined && reply.result !== null) return reply.result;
  if (typeof reply.stdout !== 'string') return undefined;
  try { return JSON.parse(reply.stdout); } catch { return undefined; }
}

/** Pure validation of one reply against the command it answers. */
export function normalizeSnmpInterfaceMetrics(command: StoredInterfacePollCommand, reporter: { deviceId: string }, reply: InterfacePollReply): NormalizedInterfacePoll {
  if (command.type !== TOPOLOGY_INTERFACE_POLL_COMMAND_TYPE) throw new TopologyInterfacePollRejection('command_type_mismatch');
  if (command.deviceId !== reporter.deviceId) throw new TopologyInterfacePollRejection('command_not_owned');
  const stored = topologyInterfacePollCommandV1Schema.safeParse(command.payload);
  if (!stored.success) throw new TopologyInterfacePollRejection('command_payload_invalid');
  const payload = stored.data;
  const parsed = parseTopologyInterfaceMetricEnvelopeV1(replyValue(reply));
  if (!parsed.accepted) throw new TopologyInterfacePollRejection('invalid_envelope');
  const envelope = parsed.envelope;
  if (envelope.commandId !== command.id || envelope.sequence !== payload.sequence || envelope.producerEpoch !== payload.producerEpoch
    || envelope.configurationRevision !== payload.configurationRevision || envelope.expectedIntervalSeconds !== payload.expectedIntervalSeconds) {
    throw new TopologyInterfacePollRejection('envelope_command_mismatch');
  }
  const bound = new Map(payload.interfaces.map(entry => [entry.interfaceId, entry.interfaceEpoch]));
  if (envelope.samples.some(sample => bound.get(sample.interfaceId) !== sample.interfaceEpoch)) throw new TopologyInterfacePollRejection('interface_not_in_command');
  return {
    scope: { orgId: payload.binding.orgId, siteId: payload.binding.siteId }, authorityKey: payload.binding.authorityKey, armId: payload.binding.armId, envelope,
    expected: { producerEpoch: payload.producerEpoch, configurationRevision: payload.configurationRevision },
  };
}

export type TopologyInterfacePollReceipt =
  | (TopologyInterfaceSampleReceipt & { commandId: string })
  | { commandId: string; accepted: false; reason: string; inserted: 0; duplicates: 0; historicalOnly: 0; healthChanged: false };

/**
 * Ingest one completed poll result (both transports). Returns null for other
 * command types and for an agent-side failure (no envelope to ingest); every
 * refusal is a receipt, never an exception into the result route.
 */
async function preResolveArmPermissionVersions(commandId: string): Promise<Map<string, string | null>> {
  const actorId = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [command] = await db.select({ payload: deviceCommands.payload }).from(deviceCommands).where(eq(deviceCommands.id, commandId)).limit(1);
    const binding = (command?.payload as { binding?: { armId?: unknown; orgId?: unknown } } | null)?.binding;
    const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (typeof binding?.armId !== 'string' || typeof binding.orgId !== 'string' || !uuidLike.test(binding.armId) || !uuidLike.test(binding.orgId)) return null;
    const [arm] = await db.select({ authorityActor: topologyTelemetryArms.authorityActor }).from(topologyTelemetryArms)
      .where(and(eq(topologyTelemetryArms.id, binding.armId), eq(topologyTelemetryArms.orgId, binding.orgId))).limit(1);
    return arm ? topologyArmActorId(arm) : null;
  }, 'topology interface poll permission pre-read'));
  return actorId ? new Map([[actorId, await getPermissionAuthorityVersion(actorId)]]) : new Map();
}

export async function ingestTopologyInterfacePollResult(input: {
  commandType: string; commandId: string; deviceId: string; status: string; result?: unknown; stdout?: string | null;
}): Promise<TopologyInterfacePollReceipt | null> {
  if (input.commandType !== TOPOLOGY_INTERFACE_POLL_COMMAND_TYPE || input.status !== 'completed') return null;
  const refused = (reason: string): TopologyInterfacePollReceipt =>
    ({ commandId: input.commandId, accepted: false, reason, inserted: 0, duplicates: 0, historicalOnly: 0, healthChanged: false });
  try {
    // C4: the arm's live-permission fence needs the actor's CURRENT permission
    // version. Resolve it here, before the sink transaction takes the site-state
    // lock, so acceptance never waits on Redis while holding it (T4). The fence
    // fails closed for any actor not resolved here.
    const versions = await preResolveArmPermissionVersions(input.commandId);
    return await withPreResolvedArmPermissionVersions(versions, () => runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(async () => {
      const [command] = await db.select({ id: deviceCommands.id, deviceId: deviceCommands.deviceId, type: deviceCommands.type, payload: deviceCommands.payload })
        .from(deviceCommands).where(eq(deviceCommands.id, input.commandId)).limit(1);
      if (!command) return refused('command_not_found');
      const poll = normalizeSnmpInterfaceMetrics(command, { deviceId: input.deviceId }, { result: input.result, stdout: input.stdout });
      const producer = await resolveTopologyTelemetryProducer({ producerKind: 'snmp', deviceId: input.deviceId, scope: poll.scope,
        authorityKey: poll.authorityKey, commandId: command.id });
      if (producer.producerEpoch !== poll.expected.producerEpoch || producer.configurationRevision !== poll.expected.configurationRevision) {
        return refused('producer_epoch_changed');
      }
      return { commandId: command.id, ...(await persistTopologyInterfaceSamples(producer, poll.envelope)) };
    }), 'topology interface poll result')));
  } catch (error) {
    if (error instanceof TopologyInterfacePollRejection) return refused(error.reason);
    const message = error instanceof Error ? error.message : '';
    if (TOPOLOGY_TELEMETRY_PRODUCER_REJECTIONS.has(message)) return refused(message);
    if (pgErrorCode(error) === '55P03') return refused('producer_busy');
    captureException(error);
    throw error;
  }
}
