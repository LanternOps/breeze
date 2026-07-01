import { and, eq, sql } from 'drizzle-orm';
import { unifiCollectors } from '../../db/schema';
import { encryptSecret, decryptForColumn } from '../secretCrypto';
import type { DbExecutor } from './unifiConnectionService';

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
  return toCollector(rows[0]);
}

export async function deleteCollector(db: DbExecutor, integrationId: string, unifiHostId: string): Promise<boolean> {
  const deleted = await db
    .delete(unifiCollectors)
    .where(and(eq(unifiCollectors.integrationId, integrationId), eq(unifiCollectors.unifiHostId, unifiHostId)))
    .returning({ id: unifiCollectors.id });
  return deleted.length > 0;
}

// Agent-pull: configs for the agent whose device is the collector. Decrypts the key.
export async function listCollectorsForDevice(db: DbExecutor, deviceId: string): Promise<AgentCollectorConfig[]> {
  const rows = await db
    .select({
      id: unifiCollectors.id,
      unifiHostId: unifiCollectors.unifiHostId,
      controllerUrl: unifiCollectors.controllerUrl,
      localApiKeyEncrypted: unifiCollectors.localApiKeyEncrypted,
      pollIntervalSeconds: unifiCollectors.pollIntervalSeconds,
    })
    .from(unifiCollectors)
    .where(and(eq(unifiCollectors.collectorDeviceId, deviceId), eq(unifiCollectors.isEnabled, true)));
  return rows.map((r: any) => ({
    collectorId: r.id,
    unifiHostId: r.unifiHostId,
    controllerUrl: r.controllerUrl,
    apiKey: decryptForColumn('unifi_collectors', 'local_api_key_encrypted', r.localApiKeyEncrypted),
    pollIntervalSeconds: r.pollIntervalSeconds,
  }));
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
