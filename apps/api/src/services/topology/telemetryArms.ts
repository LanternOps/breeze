import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { canonicalizeArguments } from '@breeze/shared/canonicalize';
import {
  TOPOLOGY_INTERFACE_POLL_AUTH_PROTOCOLS,
  TOPOLOGY_INTERFACE_POLL_CAPABILITY,
  TOPOLOGY_INTERFACE_POLL_COMMAND_TYPE,
  TOPOLOGY_INTERFACE_POLL_PRIV_PROTOCOLS,
  topologyInterfacePollCommandV1Schema,
  topologyTelemetryArmSchema,
  type TopologyScope,
  type TopologyTelemetryArm,
  type TopologyTelemetryArmRequest,
} from '@breeze/shared';
import { db, runOutsideDbContext, withDbTransaction, withSystemDbAccessContext } from '../../db';
import {
  auditLogs,
  deviceCommands,
  devices,
  discoveredAssets,
  discoveryProfiles,
  topologyCollectionSources,
  topologyInterfaces,
  topologyNodeBindings,
  topologyNodes,
  topologyTelemetryArms,
  users,
  type TopologyTelemetryArmInterface,
} from '../../db/schema';
import type { CommandPayload } from '../commandQueue';
import { insertQueuedCommandInTransaction } from '../commandQueueInsert';
import { encryptSensitivePayloadFields } from '../sensitiveCommandPayload';
import { decryptSnmpCommunities, decryptSnmpCredentials } from '../snmpSecrets';
import { requireTopologySiteAccess, type TopologyRequestContext } from './access';
import { revokeTopologyTelemetrySources } from './collectionAuthority';
import {
  currentArmInterfaces,
  fenceTopologyTelemetryArm,
  readCollectorRoot,
  readTelemetryCredentialProfile,
  topologyArmProducerCredentials,
  topologyCredentialDigest,
  topologyTelemetryConfigurationGeneration,
} from './telemetryArmFence';
export {
  ensureTopologyTelemetryArmAuthority,
  fenceTopologyTelemetryArm,
  topologyCredentialDigest,
  topologyTelemetryArmAuthority,
  topologyTelemetryConfigurationGeneration,
  validateTopologyInterfacePollDelivery,
} from './telemetryArmFence';
import { loadTopologyFlags } from './flags';
import {
  freezeTopologyArmAuthority,
  requireHumanArmingSession,
  topologyArmAuthorityRecordSchema,
  withTopologyArmAuthority,
  type TopologyArmAuthorityDeps,
  type TopologyArmAuthorityRecord,
} from './monitoringAuthority';
import { TopologyOperationError } from './operationErrors';
import { scopedWrite } from './writes';

/**
 * M3-D2/D3 standing SNMP interface-telemetry arms.
 *
 * An arm is the ONLY authority behind the `snmp` telemetry producer. It is
 * created by a human with fresh MFA, pins the exact target (canonical node +
 * the discovered address), collector device, credential source and a digest of
 * its credential/enabled state, the interfaces by canonical id + generation,
 * the cadence and an expiry. Three boundaries re-check it:
 *   - enqueue (`dispatchDueTopologyTelemetryArms`): full live actor authority;
 *   - delivery (`validateTopologyInterfacePollDelivery`, both transports);
 *   - publication (`topologyTelemetryArmAuthority`, inside the sink).
 * Any drift blocks the arm and fences its telemetry sources.
 */
type ArmRow = typeof topologyTelemetryArms.$inferSelect;
type Reader = Pick<typeof db, 'select'>;
const ROOT = { protocol: 'envelope', contextKey: 'root', addressFamily: 'any' } as const;
/** A poll command outlives its interval by at most this much (and never more than 120 s). */
const POLL_COMMAND_MAX_LIFETIME_MS = 120_000;

const sha256 = (value: Record<string, unknown>) => createHash('sha256').update(canonicalizeArguments(value)).digest('hex');

export function topologyTelemetryArmEffectDigest(input: {
  scope: TopologyScope; targetNodeId: string; targetAddress: string; collectorDeviceId: string; credentialProfileId: string;
  credentialDigest: string; interfaces: ReadonlyArray<TopologyTelemetryArmInterface>; intervalSeconds: number; expiresAt: Date;
  authority: { userId: string; authEpoch: number; mfaEpoch: number; permissionVersion: string };
}): string {
  return sha256({
    kind: 'topology-telemetry-arm-v1',
    ...input,
    interfaces: [...input.interfaces].sort((a, b) => a.interfaceId.localeCompare(b.interfaceId)),
    expiresAt: input.expiresAt.toISOString(),
  });
}

export function topologyTelemetryArmView(row: ArmRow): TopologyTelemetryArm {
  return topologyTelemetryArmSchema.parse({
    id: row.id,
    targetNodeId: row.targetNodeId,
    collectorDeviceId: row.collectorDeviceId,
    authorityKey: row.authorityKey,
    interfaceCount: row.interfaces.length,
    intervalSeconds: row.intervalSeconds,
    state: row.state,
    blockedReason: row.blockedReason,
    generation: row.generation.toString(),
    armedBy: row.armedBy,
    armedAt: row.armedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  });
}

/** The node's discovered SNMP address; the only address an arm may poll. */
async function targetAddressFor(reader: Reader, scope: TopologyScope, targetNodeId: string): Promise<string | null> {
  const [row] = await reader
    .select({ ip: discoveredAssets.ipAddress })
    .from(topologyNodeBindings)
    .innerJoin(discoveredAssets, and(eq(discoveredAssets.id, topologyNodeBindings.discoveredAssetId), eq(discoveredAssets.orgId, topologyNodeBindings.orgId)))
    .innerJoin(topologyNodes, and(eq(topologyNodes.id, topologyNodeBindings.nodeId), eq(topologyNodes.orgId, topologyNodeBindings.orgId)))
    .where(and(scopedWrite(scope, topologyNodeBindings), eq(topologyNodeBindings.nodeId, targetNodeId), isNull(topologyNodes.deletedAt)))
    .limit(1);
  const address = row?.ip ? String(row.ip).replace(/\/\d+$/, '') : null;
  return address && isIP(address) ? address : null;
}

export type ArmTopologyTelemetryDeps = {
  freezeAuthority?: (ctx: TopologyRequestContext) => Promise<TopologyArmAuthorityRecord>;
  now?: () => Date;
  /** Consumes the single-use step-up grant inside the arm transaction; throws to roll the arm back. */
  consumeStepUp?: () => Promise<void>;
};

/**
 * Create (or replace) the standing arm for one SNMP target. Human-only with a
 * satisfied second factor (the route also demands a fresh step-up grant),
 * `configure` + `execute` on the exact site and the interface-health flag.
 * Every identifier is re-resolved server-side: the address comes from the
 * node's discovered asset, ifIndex/generation from the canonical interfaces.
 */
export async function armTopologyTelemetry(
  ctx: TopologyRequestContext,
  request: TopologyTelemetryArmRequest,
  deps: ArmTopologyTelemetryDeps = {},
): Promise<TopologyTelemetryArm> {
  requireHumanArmingSession(ctx);
  await requireTopologySiteAccess(ctx.auth, ctx.permissions, ctx.scope.siteId, 'configure');
  await requireTopologySiteAccess(ctx.auth, ctx.permissions, ctx.scope.siteId, 'execute');
  const flags = await loadTopologyFlags(ctx);
  if (!flags.materialization || !flags.interfaceHealth) throw new TopologyOperationError('interface_health_disabled', 409);
  const authority = await (deps.freezeAuthority ?? freezeTopologyArmAuthority)(ctx);
  const now = (deps.now ?? (() => new Date()))();

  return withDbTransaction(async () => {
    const address = await targetAddressFor(db, ctx.scope, request.targetNodeId);
    if (!address) throw new TopologyOperationError('target_not_armable', 409, 'The target has no discovered SNMP address in this site');
    const [collector] = await db
      .select({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId, isEphemeral: devices.isEphemeral })
      .from(devices)
      .where(and(eq(devices.id, request.collectorDeviceId), eq(devices.orgId, ctx.scope.orgId), eq(devices.siteId, ctx.scope.siteId)))
      .limit(1);
    if (!collector || collector.isEphemeral) throw new TopologyOperationError('collector_not_eligible', 409);
    const [root] = await db.select({ id: topologyCollectionSources.id, revokedAt: topologyCollectionSources.revokedAt })
      .from(topologyCollectionSources)
      .where(and(scopedWrite(ctx.scope, topologyCollectionSources), eq(topologyCollectionSources.producerKind, 'agent'), eq(topologyCollectionSources.producerId, collector.id),
        eq(topologyCollectionSources.protocol, ROOT.protocol), eq(topologyCollectionSources.contextKey, ROOT.contextKey), eq(topologyCollectionSources.addressFamily, ROOT.addressFamily)))
      .limit(1);
    if (!root || root.revokedAt) throw new TopologyOperationError('collector_not_eligible', 409);
    const profile = await readTelemetryCredentialProfile(db, ctx.scope, request.credentialProfileId);
    if (!profile || !profile.enabled || !(profile.methods ?? []).includes('snmp')
      || (!(profile.snmpCommunities ?? []).length && !profile.snmpCredentials)) {
      throw new TopologyOperationError('credential_not_available', 409, 'The discovery profile has no enabled SNMP credentials in this site');
    }
    const rows = await db
      .select({ id: topologyInterfaces.id, epoch: topologyInterfaces.epoch, osIndex: topologyInterfaces.osIndex })
      .from(topologyInterfaces)
      .where(and(scopedWrite(ctx.scope, topologyInterfaces), eq(topologyInterfaces.ownerNodeId, request.targetNodeId),
        inArray(topologyInterfaces.id, request.interfaceIds), isNull(topologyInterfaces.retiredAt)));
    if (rows.length !== request.interfaceIds.length || rows.some((r) => r.osIndex === null || Number(r.osIndex) < 1)) {
      throw new TopologyOperationError('interface_not_armable', 409, 'Every interface must be a current, indexed port of the target');
    }
    const interfaces: TopologyTelemetryArmInterface[] = rows
      .map((r) => ({ interfaceId: r.id, interfaceEpoch: r.epoch, ifIndex: Number(r.osIndex) }))
      .sort((a, b) => a.ifIndex - b.ifIndex || a.interfaceId.localeCompare(b.interfaceId));
    const credentialDigest = topologyCredentialDigest(profile);
    const expiresAt = new Date(now.getTime() + request.ttlDays * 86_400_000);
    const effectDigest = topologyTelemetryArmEffectDigest({
      scope: ctx.scope, targetNodeId: request.targetNodeId, targetAddress: address, collectorDeviceId: collector.id,
      credentialProfileId: profile.id, credentialDigest, interfaces, intervalSeconds: request.intervalSeconds, expiresAt,
      authority: { userId: authority.actor.user.id, authEpoch: authority.actor.authEpoch, mfaEpoch: authority.actor.mfaEpoch, permissionVersion: authority.permissionVersion },
    });
    const authorityKey = `snmp:${address}`;
    const [previous] = await db.select().from(topologyTelemetryArms)
      .where(and(scopedWrite(ctx.scope, topologyTelemetryArms), eq(topologyTelemetryArms.producerKind, 'snmp'), eq(topologyTelemetryArms.authorityKey, authorityKey), eq(topologyTelemetryArms.state, 'armed')))
      .for('update');
    if (previous) {
      await db.update(topologyTelemetryArms)
        .set({ state: 'revoked', revokedAt: now, revokedBy: ctx.auth.user.id, blockedReason: 'replaced', updatedAt: now })
        .where(eq(topologyTelemetryArms.id, previous.id));
    }
    await revokeTopologyTelemetrySources(ctx.scope, { producerKind: 'snmp', authorityKey });
    const [maxGeneration] = await db.select({ value: sql<string>`coalesce(max(${topologyTelemetryArms.generation}), 0)::text` })
      .from(topologyTelemetryArms)
      .where(and(scopedWrite(ctx.scope, topologyTelemetryArms), eq(topologyTelemetryArms.authorityKey, authorityKey)));
    const [arm] = await db.insert(topologyTelemetryArms).values({
      ...ctx.scope,
      producerKind: 'snmp',
      targetNodeId: request.targetNodeId,
      collectorDeviceId: collector.id,
      credentialProfileId: profile.id,
      authorityKey,
      targetAddress: address,
      credentialDigest,
      interfaces,
      intervalSeconds: request.intervalSeconds,
      state: 'armed',
      generation: BigInt(maxGeneration?.value ?? '0') + 1n,
      armedBy: authority.actor.user.id,
      authorityActor: authority as unknown as Record<string, unknown>,
      authorityPermissionVersion: authority.permissionVersion,
      effectDigest,
      armedAt: now,
      expiresAt,
      nextPollAt: now,
    }).returning();
    await deps.consumeStepUp?.();
    await db.insert(auditLogs).values({
      orgId: ctx.scope.orgId,
      actorType: 'user',
      actorId: ctx.auth.user.id,
      actorEmail: ctx.auth.user.email,
      action: 'topology.telemetry_arm.armed',
      resourceType: 'topology_telemetry_arm',
      resourceId: arm!.id,
      result: 'success',
      details: { siteId: ctx.scope.siteId, authorityKey, interfaces: interfaces.length, intervalSeconds: request.intervalSeconds, replaced: previous?.id ?? null, effectDigest },
    });
    return topologyTelemetryArmView(arm!);
  });
}

/** Revocation only reduces authority: `configure`, no step-up. Fences the sources in the same transaction. */
export async function revokeTopologyTelemetryArm(ctx: TopologyRequestContext, armId: string): Promise<TopologyTelemetryArm> {
  await requireTopologySiteAccess(ctx.auth, ctx.permissions, ctx.scope.siteId, 'configure');
  if (!/^[0-9a-f-]{36}$/i.test(armId)) throw new TopologyOperationError('telemetry_arm_not_found', 404);
  return withDbTransaction(async () => {
    const [arm] = await db.select().from(topologyTelemetryArms)
      .where(and(scopedWrite(ctx.scope, topologyTelemetryArms), eq(topologyTelemetryArms.id, armId))).for('update');
    if (!arm) throw new TopologyOperationError('telemetry_arm_not_found', 404);
    if (arm.state === 'revoked') return topologyTelemetryArmView(arm);
    const now = new Date();
    const [updated] = await db.update(topologyTelemetryArms)
      .set({ state: 'revoked', revokedAt: now, revokedBy: ctx.auth.user.id, updatedAt: now })
      .where(eq(topologyTelemetryArms.id, arm.id)).returning();
    await revokeTopologyTelemetrySources(ctx.scope, { producerKind: 'snmp', authorityKey: arm.authorityKey });
    await db.insert(auditLogs).values({
      orgId: ctx.scope.orgId, actorType: 'user', actorId: ctx.auth.user.id, actorEmail: ctx.auth.user.email,
      action: 'topology.telemetry_arm.revoked', resourceType: 'topology_telemetry_arm', resourceId: arm.id, result: 'success',
      details: { siteId: ctx.scope.siteId, authorityKey: arm.authorityKey },
    });
    return topologyTelemetryArmView(updated!);
  });
}

export async function listTopologyTelemetryArms(ctx: TopologyRequestContext): Promise<TopologyTelemetryArm[]> {
  await requireTopologySiteAccess(ctx.auth, ctx.permissions, ctx.scope.siteId, 'read');
  const rows = await db.select().from(topologyTelemetryArms)
    .where(scopedWrite(ctx.scope, topologyTelemetryArms))
    .orderBy(asc(topologyTelemetryArms.createdAt), asc(topologyTelemetryArms.id))
    .limit(200);
  return rows.map(topologyTelemetryArmView);
}

// ---------------------------------------------------------------------------
// Enqueue (worker). Runs under the arm actor's own live authority.
// ---------------------------------------------------------------------------
async function blockArm(arm: ArmRow, reason: string): Promise<void> {
  await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const now = new Date();
    await db.transaction(async () => {
      await db.update(topologyTelemetryArms)
        .set({ state: 'blocked', blockedReason: reason.slice(0, 64), nextPollAt: null, updatedAt: now })
        .where(and(eq(topologyTelemetryArms.id, arm.id), eq(topologyTelemetryArms.state, 'armed'), eq(topologyTelemetryArms.generation, arm.generation)));
      await revokeTopologyTelemetrySources({ orgId: arm.orgId, siteId: arm.siteId }, { producerKind: 'snmp', authorityKey: arm.authorityKey });
    });
  }, 'topology telemetry arm block'));
}

const MAC = /^([\da-f]{2}[:-]){5}[\da-f]{2}$/i;
function normalizeMac(value: string | null): string | null {
  return value && MAC.test(value) ? value.toLowerCase().replaceAll('-', ':') : null;
}

function collectorAdvertisesPoll(baseline: unknown): boolean {
  const capabilities = (baseline as { capabilities?: Array<{ name?: unknown; version?: unknown; supported?: unknown }> } | null)?.capabilities;
  return Array.isArray(capabilities) && capabilities.some((cap) => cap.name === TOPOLOGY_INTERFACE_POLL_CAPABILITY.name
    && cap.version === TOPOLOGY_INTERFACE_POLL_CAPABILITY.version && cap.supported === true);
}

type PollCredential = {
  snmp: { version: 'v1' | 'v2c' | 'v3'; timeoutMs: number; retries: number; username: string | null;
    authProtocol: (typeof TOPOLOGY_INTERFACE_POLL_AUTH_PROTOCOLS)[number] | null; privProtocol: (typeof TOPOLOGY_INTERFACE_POLL_PRIV_PROTOCOLS)[number] | null };
  secrets: { snmpCommunity?: string; snmpAuthPassphrase?: string; snmpPrivPassphrase?: string };
};
const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);
function protocol<T extends readonly string[]>(allowed: T, value: unknown): T[number] | null | undefined {
  const raw = str(value)?.toLowerCase().replace(/-/g, '');
  if (!raw) return null;
  const normalized = raw === 'aes128' ? 'aes' : raw;
  return (allowed as readonly string[]).includes(normalized) ? normalized as T[number] : undefined;
}
/**
 * The first usable credential of the profile, in the same shapes discovery
 * uses (profile `snmpCredentials` object/array: v3 user + protocols, or a
 * v1/v2c community; else the first `snmpCommunities` entry). An unsupported
 * protocol is `null` (the arm blocks), never a silent downgrade.
 */
export function resolvePollCredential(communities: readonly string[], credentials: unknown): PollCredential | null {
  const base = { timeoutMs: 2000, retries: 1 };
  const entries = Array.isArray(credentials) ? credentials : credentials && typeof credentials === 'object' ? [credentials] : [];
  for (const entry of entries as Array<Record<string, unknown>>) {
    const version = (str(entry.version) ?? 'v2c').toLowerCase();
    if (version === 'v3') {
      const username = str(entry.username);
      if (!username) continue;
      const authProtocol = protocol(TOPOLOGY_INTERFACE_POLL_AUTH_PROTOCOLS, entry.authProtocol);
      const privProtocol = protocol(TOPOLOGY_INTERFACE_POLL_PRIV_PROTOCOLS, entry.privacyProtocol ?? entry.privProtocol);
      if (authProtocol === undefined || privProtocol === undefined || (privProtocol && !authProtocol)) return null;
      const authPassphrase = str(entry.authPassphrase) ?? str(entry.authPassword);
      const privPassphrase = str(entry.privacyPassphrase) ?? str(entry.privPassword);
      return {
        snmp: { ...base, version: 'v3', username, authProtocol, privProtocol },
        secrets: { ...(authPassphrase ? { snmpAuthPassphrase: authPassphrase } : {}), ...(privPassphrase ? { snmpPrivPassphrase: privPassphrase } : {}) },
      };
    }
    const community = str(entry.community);
    if (community && (version === 'v1' || version === 'v2c')) {
      return { snmp: { ...base, version, username: null, authProtocol: null, privProtocol: null }, secrets: { snmpCommunity: community } };
    }
  }
  const community = communities.find((value) => !!str(value));
  return community ? { snmp: { ...base, version: 'v2c', username: null, authProtocol: null, privProtocol: null }, secrets: { snmpCommunity: community } } : null;
}

export type TelemetryDispatchDeps = TopologyArmAuthorityDeps & { now?: Date; limit?: number };

/** Mint one poll command for every due arm; one in-flight poll per arm (a pending or sent poll is a skipped slot, never a second batch). */
export async function dispatchDueTopologyTelemetryArms(deps: TelemetryDispatchDeps = {}): Promise<{ dispatched: number; skipped: number; blocked: number }> {
  const now = deps.now ?? new Date();
  const due = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.select().from(topologyTelemetryArms)
    .where(and(eq(topologyTelemetryArms.state, 'armed'), lte(topologyTelemetryArms.nextPollAt, now)))
    .orderBy(asc(topologyTelemetryArms.nextPollAt), asc(topologyTelemetryArms.id))
    .limit(deps.limit ?? 100), 'topology telemetry due arms'));
  const result = { dispatched: 0, skipped: 0, blocked: 0 };
  for (const arm of due) {
    if (arm.expiresAt.getTime() <= now.getTime()) { await blockArm(arm, 'arm_expired'); result.blocked++; continue; }
    const scope = { orgId: arm.orgId, siteId: arm.siteId };
    const outcome = await withTopologyArmAuthority(arm.authorityActor, scope, ['interfaceHealth'], (ctx, live) => withDbTransaction(async () => {
      const [locked] = await db.select().from(topologyTelemetryArms)
        .where(and(scopedWrite(ctx.scope, topologyTelemetryArms), eq(topologyTelemetryArms.id, arm.id))).for('update');
      if (!locked || locked.state !== 'armed' || locked.generation !== arm.generation) return { kind: 'skipped' as const };
      const fence = await fenceTopologyTelemetryArm(db, locked, { deviceId: locked.collectorDeviceId, now });
      if (!fence.ok) return { kind: 'blocked' as const, reason: fence.reason };
      const next = new Date(now.getTime() + locked.intervalSeconds * 1000);
      const [inflight] = await db.select({ id: deviceCommands.id }).from(deviceCommands)
        .where(and(eq(deviceCommands.deviceId, locked.collectorDeviceId), eq(deviceCommands.type, TOPOLOGY_INTERFACE_POLL_COMMAND_TYPE),
          inArray(deviceCommands.status, ['pending', 'sent']), sql`${deviceCommands.payload}->'binding'->>'armId' = ${locked.id}`))
        .limit(1);
      if (inflight) {
        await db.update(topologyTelemetryArms).set({ nextPollAt: next, updatedAt: now }).where(eq(topologyTelemetryArms.id, locked.id));
        return { kind: 'skipped' as const };
      }
      const root = await readCollectorRoot(db, ctx.scope, locked.collectorDeviceId);
      if (!root) return { kind: 'blocked' as const, reason: 'collector_not_enrolled' };
      // An agent that cannot run the poll gets nothing; the arm stays armed for when it can.
      if (!collectorAdvertisesPoll(root.currentBaseline)) {
        await db.update(topologyTelemetryArms).set({ nextPollAt: next, updatedAt: now }).where(eq(topologyTelemetryArms.id, locked.id));
        return { kind: 'skipped' as const };
      }
      const profile = await readTelemetryCredentialProfile(db, ctx.scope, locked.credentialProfileId);
      if (!profile) return { kind: 'blocked' as const, reason: 'credential_changed' };
      const credential = resolvePollCredential(decryptSnmpCommunities(profile.snmpCommunities), decryptSnmpCredentials(profile.snmpCredentials));
      if (!credential) return { kind: 'blocked' as const, reason: 'credential_unsupported' };
      const identity = await db.select({ id: topologyInterfaces.id, name: topologyInterfaces.name, physAddress: topologyInterfaces.physAddress })
        .from(topologyInterfaces).where(and(scopedWrite(ctx.scope, topologyInterfaces), inArray(topologyInterfaces.id, fence.interfaces.map((i) => i.interfaceId))));
      const byId = new Map(identity.map((row) => [row.id, row]));
      const [sequenced] = await db.update(topologyTelemetryArms)
        .set({ pollSequence: sql`${topologyTelemetryArms.pollSequence} + 1` })
        .where(eq(topologyTelemetryArms.id, locked.id))
        .returning({ pollSequence: topologyTelemetryArms.pollSequence });
      const producer = topologyArmProducerCredentials(root, locked);
      const commandId = randomUUID();
      const intervalMs = locked.intervalSeconds * 1000;
      const payload = topologyInterfacePollCommandV1Schema.parse({
        version: 1,
        family: 'if_metrics',
        binding: { orgId: locked.orgId, siteId: locked.siteId, authorityKey: locked.authorityKey, armId: locked.id },
        producerEpoch: producer.producerEpoch,
        configurationRevision: producer.configurationRevision,
        sequence: String(sequenced!.pollSequence),
        expectedIntervalSeconds: locked.intervalSeconds,
        deadlineMs: Math.max(1000, Math.min(intervalMs - 1000, 60_000)),
        target: { address: locked.targetAddress, port: 161 },
        snmp: credential.snmp,
        ...credential.secrets,
        interfaces: fence.interfaces.map((i) => ({
          interfaceId: i.interfaceId,
          interfaceEpoch: i.interfaceEpoch,
          ifIndex: i.ifIndex,
          expectedName: byId.get(i.interfaceId)?.name ?? null,
          expectedPhysAddress: normalizeMac(byId.get(i.interfaceId)?.physAddress ?? null),
        })),
      });
      await insertQueuedCommandInTransaction(db as never, {
        id: commandId,
        deviceId: locked.collectorDeviceId,
        type: TOPOLOGY_INTERFACE_POLL_COMMAND_TYPE as never,
        payload: encryptSensitivePayloadFields(TOPOLOGY_INTERFACE_POLL_COMMAND_TYPE, payload as unknown as Record<string, unknown>) as unknown as CommandPayload,
        createdBy: locked.armedBy,
      });
      // C4: stamp the permission version the live re-derivation above was
      // verified at; delivery and acceptance require it to still be current.
      await db.update(topologyTelemetryArms)
        .set({ nextPollAt: next, lastPolledAt: now, updatedAt: now, authorityPermissionVersion: live.permissionVersion })
        .where(eq(topologyTelemetryArms.id, locked.id));
      return { kind: 'dispatched' as const };
    }), deps);
    if (!outcome.ok) { await blockArm(arm, outcome.reason); result.blocked++; continue; }
    if (outcome.value.kind === 'blocked') { await blockArm(arm, outcome.value.reason); result.blocked++; continue; }
    result[outcome.value.kind]++;
  }
  return result;
}
