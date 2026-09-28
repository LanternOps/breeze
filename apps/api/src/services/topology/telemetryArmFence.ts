import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { canonicalizeArguments } from '@breeze/shared/canonicalize';
import { TOPOLOGY_INTERFACE_POLL_COMMAND_TYPE, topologyInterfacePollCommandV1Schema, type TopologyScope } from '@breeze/shared';
import { db } from '../../db';
import { deviceCommands, devices, discoveryProfiles, topologyCollectionSources, topologyInterfaces, topologyTelemetryArms, users, type TopologyTelemetryArmInterface } from '../../db/schema';
import {
  isTopologyTelemetryAuthorityRegistered,
  registerTopologyTelemetryAuthority,
  topologyTelemetryProducerCredentials,
  type TopologyTelemetryAuthorityDecision,
  type TopologyTelemetryAuthorityRequest,
} from './collectionAuthority';
import { getPermissionAuthorityVersion } from '../permissions';
import { topologyArmAuthorityRecordSchema } from './monitoringAuthorityRecord';

/**
 * Telemetry-arm fences that run inside a claim or sink transaction (M3-D2/D13).
 * A leaf on purpose: it sits in commandDispatch.ts's import closure (delivery
 * revalidation) and in the telemetry sink, so it reaches no request-side module.
 */
type ArmRow = typeof topologyTelemetryArms.$inferSelect;
type Reader = Pick<typeof db, 'select'>;
const scopedWrite = (scope: TopologyScope, table: { orgId: typeof topologyInterfaces.orgId; siteId: typeof topologyInterfaces.siteId } | { orgId: typeof topologyTelemetryArms.orgId; siteId: typeof topologyTelemetryArms.siteId }) =>
  and(eq(table.orgId, scope.orgId), eq(table.siteId, scope.siteId));
const sha256 = (value: Record<string, unknown>) => createHash('sha256').update(canonicalizeArguments(value)).digest('hex');

/** Credential revision of a discovery profile: ciphertext + enabled + SNMP method. Never the plaintext. */
export function topologyCredentialDigest(profile: { id: string; enabled: boolean; methods: readonly string[] | null; snmpCommunities: readonly string[] | null; snmpCredentials: unknown }): string {
  return sha256({
    kind: 'topology-telemetry-credential-v1',
    profileId: profile.id,
    enabled: profile.enabled,
    snmp: (profile.methods ?? []).includes('snmp'),
    communities: [...(profile.snmpCommunities ?? [])],
    credentials: profile.snmpCredentials ?? null,
  });
}

export const topologyTelemetryConfigurationGeneration = (arm: Pick<ArmRow, 'id' | 'generation' | 'effectDigest'>) =>
  `arm:${arm.id}:${arm.generation.toString()}:${arm.effectDigest}`;

export async function readTelemetryCredentialProfile(reader: Reader, scope: TopologyScope, profileId: string) {
  const [profile] = await reader
    .select({
      id: discoveryProfiles.id, orgId: discoveryProfiles.orgId, siteId: discoveryProfiles.siteId, enabled: discoveryProfiles.enabled,
      methods: discoveryProfiles.methods, snmpCommunities: discoveryProfiles.snmpCommunities, snmpCredentials: discoveryProfiles.snmpCredentials,
    })
    .from(discoveryProfiles)
    .where(and(eq(discoveryProfiles.id, profileId), eq(discoveryProfiles.orgId, scope.orgId), eq(discoveryProfiles.siteId, scope.siteId)))
    .limit(1);
  return profile ?? null;
}

/** The interfaces still at their armed generation (not retired, same epoch and ifIndex, same owner). */
export async function currentArmInterfaces(reader: Reader, scope: TopologyScope, targetNodeId: string, armed: ReadonlyArray<TopologyTelemetryArmInterface>) {
  if (!armed.length) return [];
  const rows = await reader
    .select({ id: topologyInterfaces.id, epoch: topologyInterfaces.epoch, osIndex: topologyInterfaces.osIndex, retiredAt: topologyInterfaces.retiredAt })
    .from(topologyInterfaces)
    .where(and(scopedWrite(scope, topologyInterfaces), eq(topologyInterfaces.ownerNodeId, targetNodeId), inArray(topologyInterfaces.id, armed.map((i) => i.interfaceId))));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return armed.filter((i) => {
    const row = byId.get(i.interfaceId);
    return row && row.retiredAt === null && row.epoch === i.interfaceEpoch && row.osIndex !== null && Number(row.osIndex) === i.ifIndex;
  });
}

// ---------------------------------------------------------------------------
// Fast fence shared by delivery and publication. These run inside a claim or
// sink transaction that already holds locks, so they read ONLY through the
// supplied reader (never a second pooled connection): the frozen actor's user
// row must still be active at the same epochs, and the arm/credential/interface
// state must be exactly what was armed. The permission SET is re-derived at
// enqueue, where no lock is held; delivery and acceptance additionally require
// the version it was verified at to be current (`armPermissionsStillWitnessed`).
// ---------------------------------------------------------------------------
async function actorStillCurrent(reader: Reader, record: unknown): Promise<boolean> {
  const parsed = topologyArmAuthorityRecordSchema.safeParse(record);
  if (!parsed.success) return false;
  const actor = parsed.data.actor;
  const [user] = await reader.select({ status: users.status, authEpoch: users.authEpoch, mfaEpoch: users.mfaEpoch, partnerId: users.partnerId, orgId: users.orgId })
    .from(users).where(eq(users.id, actor.user.id)).limit(1);
  return !!user && user.status === 'active' && user.authEpoch === actor.authEpoch && user.mfaEpoch === actor.mfaEpoch
    && (user.partnerId ?? null) === actor.partnerId && (actor.scope !== 'organization' || user.orgId === actor.orgId);
}

// ---------------------------------------------------------------------------
// Live permission boundary (M3-D13, PR #7117 C4). The epochs above catch a
// sign-out, MFA reset or deactivation, but NOT a role that lost its grants or
// a narrowed site allowlist. Those invalidate through the permission store's
// authority version (`clearPermissionCache` bumps it on every permission
// write). The enqueue boundary re-derives the actor's live permission set and
// stamps the version it verified at onto the arm (`authority_permission_version`);
// delivery and result acceptance then require the CURRENT version to still be
// that one — an unchanged version means the permissions verified live at
// enqueue are still the live permissions. Any change fails closed; the next
// enqueue re-derives live (blocking the arm on a real revocation, re-stamping
// on an unrelated bump — at most the in-flight poll is lost). The set itself is
// never re-read here: these fences run inside a claim or sink transaction, and
// the permission tables are only readable through a second (system) pooled
// connection — the #6671 shape.
// ---------------------------------------------------------------------------
const preResolvedVersions = new AsyncLocalStorage<ReadonlyMap<string, string | null>>();

/**
 * Serve the permission versions an ingest path resolved BEFORE opening its
 * lock-holding transaction (no Redis wait under the site-state lock). A user
 * missing from the map fails closed.
 */
export function withPreResolvedArmPermissionVersions<T>(versions: ReadonlyMap<string, string | null>, fn: () => Promise<T>): Promise<T> {
  return preResolvedVersions.run(new Map(versions), fn);
}

async function currentPermissionVersion(userId: string): Promise<string | null> {
  const store = preResolvedVersions.getStore();
  if (store) return store.get(userId) ?? null;
  return getPermissionAuthorityVersion(userId);
}

/** The arm's frozen actor id, or null for an unreadable record. */
export function topologyArmActorId(arm: Pick<ArmRow, 'authorityActor'>): string | null {
  const parsed = topologyArmAuthorityRecordSchema.safeParse(arm.authorityActor);
  return parsed.success ? parsed.data.actor.user.id : null;
}

/** Null while the permissions verified at the last enqueue still hold; otherwise the fence reason. */
export async function armPermissionsStillWitnessed(arm: Pick<ArmRow, 'authorityActor' | 'authorityPermissionVersion'>): Promise<'permission_changed' | 'authority_unavailable' | null> {
  const userId = topologyArmActorId(arm);
  if (!userId) return 'authority_unavailable';
  const current = await currentPermissionVersion(userId);
  if (current === null) return 'authority_unavailable';
  return current === arm.authorityPermissionVersion ? null : 'permission_changed';
}

export type TelemetryArmFence = { ok: true; arm: ArmRow; interfaces: TopologyTelemetryArmInterface[] } | { ok: false; reason: string };

export async function fenceTopologyTelemetryArm(reader: Reader, arm: ArmRow | undefined, input: { deviceId: string; now: Date }): Promise<TelemetryArmFence> {
  if (!arm || arm.state !== 'armed') return { ok: false, reason: 'arm_revoked' };
  if (arm.expiresAt.getTime() <= input.now.getTime()) return { ok: false, reason: 'arm_expired' };
  if (arm.collectorDeviceId !== input.deviceId) return { ok: false, reason: 'collector_changed' };
  const [device] = await reader.select({ orgId: devices.orgId, siteId: devices.siteId }).from(devices).where(eq(devices.id, arm.collectorDeviceId)).limit(1);
  if (!device || device.orgId !== arm.orgId || device.siteId !== arm.siteId) return { ok: false, reason: 'collector_moved' };
  const profile = await readTelemetryCredentialProfile(reader, arm, arm.credentialProfileId);
  if (!profile || topologyCredentialDigest(profile) !== arm.credentialDigest) return { ok: false, reason: 'credential_changed' };
  if (!(await actorStillCurrent(reader, arm.authorityActor))) return { ok: false, reason: 'authority_changed' };
  const interfaces = await currentArmInterfaces(reader, arm, arm.targetNodeId, arm.interfaces);
  if (!interfaces.length) return { ok: false, reason: 'interface_generation_changed' };
  return { ok: true, arm, interfaces };
}

/** The collector's agent root; the poll's producer epoch/revision derive from it. */
export async function readCollectorRoot(reader: Reader, scope: TopologyScope, deviceId: string) {
  const [root] = await reader.select().from(topologyCollectionSources)
    .where(and(eq(topologyCollectionSources.orgId, scope.orgId), eq(topologyCollectionSources.siteId, scope.siteId), eq(topologyCollectionSources.producerKind, 'agent'),
      eq(topologyCollectionSources.producerId, deviceId), eq(topologyCollectionSources.protocol, 'envelope'), eq(topologyCollectionSources.contextKey, 'root'),
      eq(topologyCollectionSources.addressFamily, 'any')))
    .limit(1);
  return root && !root.revokedAt ? root : null;
}

/** Producer credentials a poll minted from this arm generation must carry (M3-D1 telemetry domain). */
export function topologyArmProducerCredentials(root: { producerEpoch: string; configurationRevision: string }, arm: Pick<ArmRow, 'id' | 'generation' | 'effectDigest' | 'authorityKey'>) {
  return topologyTelemetryProducerCredentials({ root, producerKind: 'snmp', authorityKey: arm.authorityKey, configurationGeneration: topologyTelemetryConfigurationGeneration(arm) });
}

type PollBinding = { orgId: string; siteId: string; authorityKey: string; armId: string };
function pollBinding(payload: unknown): PollBinding | null {
  const binding = (payload as { binding?: Partial<PollBinding> } | null)?.binding;
  return binding && typeof binding.armId === 'string' && typeof binding.authorityKey === 'string' && typeof binding.orgId === 'string' && typeof binding.siteId === 'string'
    ? binding as PollBinding : null;
}

/**
 * The registered `snmp` telemetry authority (collectionAuthority seam). The
 * result adapter calls it with the poll's command id; the stored (server-
 * written) command must be a poll THIS arm minted for this device, scope and
 * authority key. Generation drift surfaces as a configuration-revision change
 * (the generation feeds the producer credentials), which the adapter refuses.
 */
export async function topologyTelemetryArmAuthority(request: TopologyTelemetryAuthorityRequest, reader: Reader = db): Promise<TopologyTelemetryAuthorityDecision> {
  if (request.producerKind !== 'snmp' || request.commandId === null) return { authorized: false, reason: 'producer_authority_denied' };
  if (request.device.orgId !== request.scope.orgId || request.device.siteId !== request.scope.siteId) return { authorized: false, reason: 'collector_moved' };
  const [command] = await reader.select({ type: deviceCommands.type, deviceId: deviceCommands.deviceId, payload: deviceCommands.payload })
    .from(deviceCommands).where(eq(deviceCommands.id, request.commandId)).limit(1);
  const binding = pollBinding(command?.payload);
  if (!command || !binding || command.type !== TOPOLOGY_INTERFACE_POLL_COMMAND_TYPE || command.deviceId !== request.device.id
    || binding.orgId !== request.scope.orgId || binding.siteId !== request.scope.siteId || binding.authorityKey !== request.authorityKey) {
    return { authorized: false, reason: 'producer_authority_denied' };
  }
  const [arm] = await reader.select().from(topologyTelemetryArms)
    .where(and(eq(topologyTelemetryArms.id, binding.armId), scopedWrite(request.scope, topologyTelemetryArms), eq(topologyTelemetryArms.authorityKey, request.authorityKey)))
    .limit(1);
  const fence = await fenceTopologyTelemetryArm(reader, arm, { deviceId: request.device.id, now: new Date() });
  if (!fence.ok) return { authorized: false, reason: fence.reason };
  const permissions = await armPermissionsStillWitnessed(fence.arm);
  if (permissions) return { authorized: false, reason: permissions };
  return { authorized: true, configurationGeneration: topologyTelemetryConfigurationGeneration(fence.arm), interfaceIds: fence.interfaces.map((i) => i.interfaceId) };
}

/** Idempotent explicit registration; called at API boot and by the monitoring worker. */
export function ensureTopologyTelemetryArmAuthority(): void {
  if (!isTopologyTelemetryAuthorityRegistered('snmp')) registerTopologyTelemetryAuthority('snmp', (request) => topologyTelemetryArmAuthority(request));
}

/**
 * Delivery revalidation for `topology_interface_poll` (mandatory set, both
 * transports): the arm must still be armed and intact for this collector, the
 * poll's producer credentials must equal what the CURRENT arm generation and
 * collector root derive (a re-arm or root rotation strands older polls), and
 * the poll must still be inside its own interval.
 */
export async function validateTopologyInterfacePollDelivery(reader: Reader, row: { id: string; deviceId: string; payload: unknown }, now = new Date()): Promise<'scope_changed' | 'expired' | null> {
  const parsed = topologyInterfacePollCommandV1Schema.safeParse(row.payload);
  if (!parsed.success) return 'scope_changed';
  const poll = parsed.data;
  const [command] = await reader.select({ createdAt: deviceCommands.createdAt }).from(deviceCommands).where(eq(deviceCommands.id, row.id)).limit(1);
  if (!command || now.getTime() - command.createdAt.getTime() >= poll.expectedIntervalSeconds * 1000) return 'expired';
  const scope = { orgId: poll.binding.orgId, siteId: poll.binding.siteId };
  const [arm] = await reader.select().from(topologyTelemetryArms)
    .where(and(eq(topologyTelemetryArms.id, poll.binding.armId), scopedWrite(scope, topologyTelemetryArms), eq(topologyTelemetryArms.authorityKey, poll.binding.authorityKey)))
    .limit(1);
  const fence = await fenceTopologyTelemetryArm(reader, arm, { deviceId: row.deviceId, now });
  if (!fence.ok) return 'scope_changed';
  if (await armPermissionsStillWitnessed(fence.arm)) return 'scope_changed';
  const root = await readCollectorRoot(reader, scope, row.deviceId);
  if (!root) return 'scope_changed';
  const expected = topologyArmProducerCredentials(root, fence.arm);
  return expected.producerEpoch === poll.producerEpoch && expected.configurationRevision === poll.configurationRevision ? null : 'scope_changed';
}
