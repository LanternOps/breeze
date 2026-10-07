import { and, eq, sql } from 'drizzle-orm';
import { unifiCollectors } from '../../db/schema';
import { encryptSecret, decryptForColumn } from '../secretCrypto';
import type { DbExecutor } from './unifiConnectionService';
import { notInHoldingOrgCondition } from '../unassignedPool/selectorPredicate';
import { HotPathTtlCache } from '../hotPathCache';

export type { DbExecutor } from './unifiConnectionService';

// The legal collector status domain. Kept as a closed union so a typo
// (e.g. 'conected') is a compile error rather than a silently-stored bad value
// that breaks the UI status badge.
export type CollectorStatus = 'pending' | 'connected' | 'firmware_too_old' | 'unreachable' | 'error';

export interface UnifiCollector {
  id: string;
  integrationId: string;
  orgId: string;
  siteId: string;
  unifiHostId: string | null;
  collectorDeviceId: string;
  controllerUrl: string;
  isEnabled: boolean;
  pollIntervalSeconds: number;
  status: CollectorStatus;
  firmwareOk: boolean | null;
  lastPollAt: Date | null;
  lastPollStatus: string | null;
  lastPollError: string | null;
}

export interface AgentCollectorConfig {
  collectorId: string;
  unifiHostId: string | null;
  controllerUrl: string;
  apiKey: string;
  pollIntervalSeconds: number;
  // Optional topology negotiation (M2 Task 5, Collection §8). Present only when
  // the server authorizes UniFi topology for this collector; the agent then
  // attaches `topologyV1` bound to this epoch + source identity.
  acceptedUnifiTopologyVersions?: number[];
  topologyProducerEpoch?: string;
  topologySourceIdentity?: string;
}

export interface CollectorTopologyAdvertisement {
  acceptedUnifiTopologyVersions: number[];
  topologyProducerEpoch: string;
  topologySourceIdentity: string;
}

function toCollector(row: any): UnifiCollector {
  return {
    id: row.id,
    integrationId: row.integrationId,
    orgId: row.orgId,
    siteId: row.siteId,
    unifiHostId: row.unifiHostId,
    collectorDeviceId: row.collectorDeviceId,
    controllerUrl: row.controllerUrl,
    isEnabled: row.isEnabled,
    pollIntervalSeconds: row.pollIntervalSeconds,
    status: row.status,
    firmwareOk: row.firmwareOk ?? null,
    lastPollAt: row.lastPollAt ?? null,
    lastPollStatus: row.lastPollStatus ?? null,
    lastPollError: row.lastPollError ?? null,
  };
}

export async function listCollectors(db: DbExecutor, integrationId: string): Promise<UnifiCollector[]> {
  const rows = await db.select().from(unifiCollectors).where(eq(unifiCollectors.integrationId, integrationId));
  return rows.map(toCollector);
}

export async function upsertCollector(
  db: DbExecutor,
  fields: {
    integrationId: string;
    orgId: string;
    siteId: string;
    unifiHostId: string;
    collectorDeviceId: string;
    controllerUrl: string;
    apiKey: string;
    pollIntervalSeconds?: number;
    createdBy?: string | null;
  },
): Promise<UnifiCollector> {
  const localApiKeyEncrypted = encryptSecret(fields.apiKey, { aad: 'unifi_collectors.local_api_key_encrypted' });
  const rows = await db
    .insert(unifiCollectors)
    .values({
      integrationId: fields.integrationId,
      orgId: fields.orgId,
      siteId: fields.siteId,
      unifiHostId: fields.unifiHostId,
      collectorDeviceId: fields.collectorDeviceId,
      controllerUrl: fields.controllerUrl,
      localApiKeyEncrypted,
      pollIntervalSeconds: fields.pollIntervalSeconds ?? 60,
      createdBy: fields.createdBy ?? null,
      status: 'pending',
    })
    .onConflictDoUpdate({
      target: [unifiCollectors.integrationId, unifiCollectors.unifiHostId],
      // unifi_collectors_integration_host_idx is PARTIAL (self-hosted rows
      // have a null host id and are governed by the controller_url index);
      // Postgres can only infer a partial arbiter when the predicate matches.
      targetWhere: sql`${unifiCollectors.unifiHostId} IS NOT NULL`,
      set: {
        orgId: fields.orgId,
        siteId: fields.siteId,
        collectorDeviceId: fields.collectorDeviceId,
        controllerUrl: fields.controllerUrl,
        localApiKeyEncrypted,
        pollIntervalSeconds: fields.pollIntervalSeconds ?? 60,
        status: 'pending',
        lastPollError: null,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!rows[0]) throw new Error('upsertCollector returned no unifi_collectors row');
  agentCollectorAbsenceCache.invalidateAroundCommit(agentCollectorAbsenceKey(fields.collectorDeviceId, fields.orgId));
  return toCollector(rows[0]);
}

export async function upsertSelfHostedController(
  db: DbExecutor,
  fields: {
    integrationId: string;
    orgId: string;
    siteId: string;
    collectorDeviceId: string;
    controllerUrl: string;
    apiKey: string;
    pollIntervalSeconds?: number;
    createdBy?: string | null;
  },
): Promise<UnifiCollector> {
  const localApiKeyEncrypted = encryptSecret(fields.apiKey, { aad: 'unifi_collectors.local_api_key_encrypted' });
  const rows = await db
    .insert(unifiCollectors)
    .values({
      integrationId: fields.integrationId,
      orgId: fields.orgId,
      siteId: fields.siteId,
      unifiHostId: null,
      collectorDeviceId: fields.collectorDeviceId,
      controllerUrl: fields.controllerUrl,
      localApiKeyEncrypted,
      pollIntervalSeconds: fields.pollIntervalSeconds ?? 60,
      createdBy: fields.createdBy ?? null,
      status: 'pending',
    })
    .onConflictDoUpdate({
      target: [unifiCollectors.integrationId, unifiCollectors.controllerUrl],
      targetWhere: sql`${unifiCollectors.unifiHostId} IS NULL`,
      set: {
        orgId: fields.orgId,
        siteId: fields.siteId,
        collectorDeviceId: fields.collectorDeviceId,
        localApiKeyEncrypted,
        pollIntervalSeconds: fields.pollIntervalSeconds ?? 60,
        status: 'pending',
        lastPollError: null,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!rows[0]) throw new Error('upsertSelfHostedController returned no unifi_collectors row');
  agentCollectorAbsenceCache.invalidateAroundCommit(agentCollectorAbsenceKey(fields.collectorDeviceId, fields.orgId));
  return toCollector(rows[0]);
}

export async function deleteCollector(db: DbExecutor, integrationId: string, unifiHostId: string): Promise<boolean> {
  const deleted = await db
    .delete(unifiCollectors)
    .where(and(eq(unifiCollectors.integrationId, integrationId), eq(unifiCollectors.unifiHostId, unifiHostId)))
    .returning({ id: unifiCollectors.id });
  return deleted.length > 0;
}

// The ONE predicate for "collectors this agent's device is served". Shared by
// listCollectorsForDevice and the presence probe below so the two can never
// disagree about which rows count.
function agentCollectorCondition(deviceId: string, orgId: string) {
  return and(
    eq(unifiCollectors.collectorDeviceId, deviceId),
    eq(unifiCollectors.orgId, orgId),
    eq(unifiCollectors.isEnabled, true),
    // Never hand a controller key to a device parked in a holding org.
    notInHoldingOrgCondition(sql`(SELECT d.org_id FROM devices d WHERE d.id = ${unifiCollectors.collectorDeviceId})`),
  );
}

/**
 * Whether listCollectorsForDevice would return anything for this device — one
 * indexed `LIMIT 1` probe, no decryption. The agent polls every 30 s and almost
 * no device is a collector, so the route asks this first (#8053).
 */
export async function deviceHasAgentCollectors(db: DbExecutor, deviceId: string, orgId: string): Promise<boolean> {
  const rows = await db
    .select({ id: unifiCollectors.id })
    .from(unifiCollectors)
    .where(agentCollectorCondition(deviceId, orgId))
    .limit(1);
  return rows.length > 0;
}

/**
 * #8053 — NEGATIVE cache for the agent's collector poll, keyed by org AND
 * device. Only "this device has no collectors" is ever stored (never a config:
 * those carry decrypted controller keys), so the worst a stale entry can do is
 * delay a NEW collector's first poll. Bounded by the TTL across instances, and
 * cleared on this process by every collector create/re-point below
 * (upsertCollector, upsertSelfHostedController), after their transaction
 * commits. Deletes need no invalidation: they only ever make "none" truer.
 */
export const AGENT_COLLECTOR_ABSENCE_TTL_MS = 5 * 60_000;

export const agentCollectorAbsenceCache = new HotPathTtlCache<string, boolean>({
  name: 'unifi-agent-collector-absence',
  ttlMs: AGENT_COLLECTOR_ABSENCE_TTL_MS,
  // One small entry per collector-less agent; past the bound the oldest device
  // just probes again on its next poll.
  maxEntries: 50_000,
});

export function agentCollectorAbsenceKey(deviceId: string, orgId: string): string {
  return `${orgId}:${deviceId}`;
}

// Agent-pull: configs for the agent whose device is the collector. Decrypts the key.
// `orgId` is the token-resolved agent org and is load-bearing: the caller reads
// in system scope, and a collector row can outlive a move of its device to
// another org (the org-move path does not rewrite unifi_collectors).
// `topologyAdvertisement` (services/topology/unifiAuthority.ts
// unifiTopologyAdvertisement) decides per collector whether topology v1 is
// offered; without it every collector is legacy-only.
export async function listCollectorsForDevice(
  db: DbExecutor,
  deviceId: string,
  orgId: string,
  opts: { topologyAdvertisement?: (collectorId: string) => Promise<CollectorTopologyAdvertisement | null> } = {},
): Promise<AgentCollectorConfig[]> {
  const rows = await db
    .select({
      id: unifiCollectors.id,
      unifiHostId: unifiCollectors.unifiHostId,
      controllerUrl: unifiCollectors.controllerUrl,
      localApiKeyEncrypted: unifiCollectors.localApiKeyEncrypted,
      pollIntervalSeconds: unifiCollectors.pollIntervalSeconds,
    })
    .from(unifiCollectors)
    .where(agentCollectorCondition(deviceId, orgId));
  const out: AgentCollectorConfig[] = [];
  for (const r of rows as any[]) {
    const topology = opts.topologyAdvertisement ? await opts.topologyAdvertisement(r.id) : null;
    out.push({
      collectorId: r.id,
      unifiHostId: r.unifiHostId,
      controllerUrl: r.controllerUrl,
      // local_api_key_encrypted is NOT NULL, so decryption yields a string.
      apiKey: decryptForColumn('unifi_collectors', 'local_api_key_encrypted', r.localApiKeyEncrypted) as string,
      pollIntervalSeconds: r.pollIntervalSeconds,
      ...(topology ?? {}),
    });
  }
  return out;
}

// Returns the device that owns a collector, or null if the collector is unknown.
// The ingest worker uses this to enforce that an agent may only write telemetry
// for a collector bound to its own device (the agent path runs system-scoped, so
// RLS does not provide this guarantee — the check must be explicit).
export async function getCollectorOwnerDeviceId(db: DbExecutor, collectorId: string): Promise<string | null> {
  const [row] = await db
    .select({ collectorDeviceId: unifiCollectors.collectorDeviceId })
    .from(unifiCollectors)
    .where(eq(unifiCollectors.id, collectorId))
    .limit(1);
  return row?.collectorDeviceId ?? null;
}

export async function markCollectorPoll(
  db: DbExecutor,
  collectorId: string,
  status: CollectorStatus,
  firmwareOk: boolean | null,
  error?: string | null,
): Promise<void> {
  const updated = await db
    .update(unifiCollectors)
    .set({
      status,
      firmwareOk,
      lastPollAt: new Date(),
      lastPollStatus: status === 'connected' ? 'success' : status === 'firmware_too_old' ? 'failed' : status,
      lastPollError: error ?? null,
      updatedAt: new Date(),
    })
    .where(eq(unifiCollectors.id, collectorId))
    .returning({ id: unifiCollectors.id });
  if (updated.length === 0) {
    throw new Error(`markCollectorPoll matched no unifi_collectors row (id=${collectorId})`);
  }
}
