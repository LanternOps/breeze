/**
 * Database side of the MCP_LLM_* env bootstrap (W06 #7604, Task 15 / D6).
 *
 * Every write runs inside `inPartnerEnvLock`: ONE system transaction holding
 * the per-partner registry lock — the same key W03's cutover/compatRemap and
 * W04/W06's /ai/models writes use (legacyReconcile.lockPartnerRegistryReconcile),
 * so the bootstrap serialises with all of them and with itself on another
 * replica. It WAITS for the lock (bounded by lock_timeout) instead of W04's
 * try-lock: a boot task holds no request connection, so there is no
 * pool-starvation cycle, and a replica that loses the race must see the
 * winner's connection rather than skip the partner. The helpers below assume
 * they run inside it and never open a nested transaction. System scope
 * bypasses RLS, so every statement is pinned to the partner.
 */
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { ModelRates } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiModelAssignments, partnerAiConnections, partnerAiModels, partners } from '../../db/schema';
import { createGatewayConnectionRow } from './connections';
import { createManualOfferingLocked, envManagementState } from './gatewayConnections';
import { lockPartnerRegistryReconcile } from './legacyReconcile';

/** Upper bound on waiting for the partner registry lock (or a row lock) at boot; the retry schedule picks the partner up again. */
const BOOT_LOCK_TIMEOUT = '30s';

export interface EnvConnectionState {
  id: string;
  baseUrl: string | null;
  configVersion: number;
  keyFingerprint: string | null;
  /** The MCP_LLM_MODEL this connection was last synced to (bootstrap bookkeeping, non-secret). */
  envModel: string | null;
  /** Released by an earlier boot with the variables unset; this boot re-adopts it. */
  released: boolean;
}

export interface EnvOfferingResult {
  id: string;
  created: boolean;
  repriced: boolean;
  /** Has a verification record (passed or failed). */
  verified: boolean;
}

export async function listPartnerIds(): Promise<string[]> {
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(
    () => db.select({ id: partners.id }).from(partners).orderBy(asc(partners.id)),
    'aiModels.envBootstrap.listPartners',
  ));
  return rows.map((r) => r.id);
}

export async function inPartnerEnvLock<T>(partnerId: string, fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    await db.execute(sql.raw(`SET LOCAL lock_timeout = '${BOOT_LOCK_TIMEOUT}'`));
    await lockPartnerRegistryReconcile(partnerId);
    return fn();
  }, 'aiModels.envBootstrap.partner'));
}

/**
 * The partner's live env-managed connection, released or not, row-locked.
 * Oldest first if (impossibly) several.
 */
export async function findEnvConnection(partnerId: string): Promise<EnvConnectionState | null> {
  const [row] = await db
    .select({
      id: partnerAiConnections.id,
      baseUrl: partnerAiConnections.baseUrl,
      configVersion: partnerAiConnections.configVersion,
      keyFingerprint: partnerAiConnections.keyFingerprint,
      providerConfig: partnerAiConnections.providerConfig,
    })
    .from(partnerAiConnections)
    .where(and(
      eq(partnerAiConnections.partnerId, partnerId),
      eq(partnerAiConnections.kind, 'openai_compatible'),
      ne(partnerAiConnections.status, 'disconnected'),
      sql`${partnerAiConnections.providerConfig}->>'managedBy' = 'env'`,
    ))
    .orderBy(asc(partnerAiConnections.createdAt))
    .limit(1)
    .for('update');
  if (!row) return null;
  const envModel = (row.providerConfig as { envModel?: unknown } | null)?.envModel;
  return {
    id: row.id,
    baseUrl: row.baseUrl,
    configVersion: row.configVersion,
    keyFingerprint: row.keyFingerprint,
    envModel: typeof envModel === 'string' ? envModel : null,
    released: envManagementState(row.providerConfig) === 'released',
  };
}

/** `baseUrl` must already have passed validateByoBaseUrl (no DNS in here). */
export async function insertEnvConnection(input: {
  partnerId: string; name: string; baseUrl: string; apiKey: string | null; model: string;
}): Promise<string> {
  const conn = await createGatewayConnectionRow({
    partnerId: input.partnerId,
    kind: 'openai_compatible',
    name: input.name,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    providerConfig: { managedBy: 'env', envModel: input.model },
    connectedBy: null,
  });
  return conn.id;
}

export async function setEnvModel(partnerId: string, connectionId: string, model: string): Promise<void> {
  await db
    .update(partnerAiConnections)
    .set({ providerConfig: { managedBy: 'env', envModel: model }, updatedAt: new Date() })
    .where(and(eq(partnerAiConnections.id, connectionId), eq(partnerAiConnections.partnerId, partnerId)));
}

/** Clears the release marker: the connection is synced from MCP_LLM_* again. No routing field changes. */
export async function readoptEnvConnection(partnerId: string, connectionId: string, envModel: string | null): Promise<void> {
  await db
    .update(partnerAiConnections)
    .set({ providerConfig: envModel === null ? { managedBy: 'env' } : { managedBy: 'env', envModel }, updatedAt: new Date() })
    .where(and(eq(partnerAiConnections.id, connectionId), eq(partnerAiConnections.partnerId, partnerId)));
}

export async function findConnectionOffering(partnerId: string, connectionId: string, modelId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: partnerAiModels.id })
    .from(partnerAiModels)
    .where(and(
      eq(partnerAiModels.partnerId, partnerId),
      eq(partnerAiModels.connectionId, connectionId),
      eq(partnerAiModels.modelId, modelId),
    ))
    .limit(1);
  return row?.id ?? null;
}

const same = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 5e-7;   // numeric(20,6)

/**
 * The env model's offering on the env connection, priced from MCP_LLM_PRICE_*.
 * Created (manual, unverified) and enabled when missing. An existing row is
 * re-priced when the env prices changed and enabled only when `enable` (the
 * boot that creates the connection or changes the model) — a steady-state
 * boot never re-enables an offering an admin disabled. Never writes
 * capabilities: only the verifier does.
 */
export async function upsertEnvOffering(input: {
  partnerId: string; connectionId: string; model: string; prices: ModelRates; enable: boolean;
}): Promise<EnvOfferingResult> {
  const p = input.prices;
  const [existing] = await db
    .select({
      id: partnerAiModels.id,
      enabled: partnerAiModels.enabled,
      capabilities: partnerAiModels.capabilities,
      in: partnerAiModels.priceInputCentsPerM,
      out: partnerAiModels.priceOutputCentsPerM,
      cr: partnerAiModels.priceCacheReadCentsPerM,
      cw: partnerAiModels.priceCacheWriteCentsPerM,
    })
    .from(partnerAiModels)
    .where(and(
      eq(partnerAiModels.partnerId, input.partnerId),
      eq(partnerAiModels.connectionId, input.connectionId),
      eq(partnerAiModels.modelId, input.model),
    ))
    .for('update');
  if (!existing) {
    const created = await createManualOfferingLocked({
      partnerId: input.partnerId, connectionId: input.connectionId, modelId: input.model, displayName: input.model, prices: p,
      allowManaged: true,
    });
    await db.update(partnerAiModels).set({ enabled: true, updatedAt: new Date() })
      .where(and(eq(partnerAiModels.id, created.id), eq(partnerAiModels.partnerId, input.partnerId)));
    return { id: created.id, created: true, repriced: false, verified: false };
  }
  const repriced = !(same(existing.in, p.inputCentsPerM) && same(existing.out, p.outputCentsPerM)
    && same(existing.cr, p.cacheReadCentsPerM) && same(existing.cw, p.cacheWriteCentsPerM));
  const enable = input.enable && !existing.enabled;
  if (repriced || enable) {
    await db.update(partnerAiModels)
      .set({
        ...(repriced ? {
          priceInputCentsPerM: p.inputCentsPerM,
          priceOutputCentsPerM: p.outputCentsPerM,
          priceCacheReadCentsPerM: p.cacheReadCentsPerM,
          priceCacheWriteCentsPerM: p.cacheWriteCentsPerM,
        } : {}),
        ...(enable ? { enabled: true } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(partnerAiModels.id, existing.id), eq(partnerAiModels.partnerId, input.partnerId)));
  }
  return { id: existing.id, created: false, repriced, verified: existing.capabilities !== null };
}

/**
 * Re-point the PARTNER-level `chat` default (role 'default') to `to`:
 *  - from 'platform': only when there is no default yet (no row / NULL) or the
 *    default is a platform offering — exactly where legacy env routing sent
 *    chat to the env endpoint;
 *  - from an offering id: only when the default is exactly that offering.
 * Never touches another surface or any org override. A permitted list, when
 * set, gains `to` (the default must be permitted).
 */
export async function repointChatDefault(input: { partnerId: string; to: string; from: 'platform' | string }): Promise<boolean> {
  const [row] = await db
    .select({ id: aiModelAssignments.id, defaultOfferingId: aiModelAssignments.defaultOfferingId, permitted: aiModelAssignments.permittedOfferingIds })
    .from(aiModelAssignments)
    .where(and(
      eq(aiModelAssignments.partnerId, input.partnerId),
      isNull(aiModelAssignments.orgId),
      eq(aiModelAssignments.surface, 'chat'),
      eq(aiModelAssignments.role, 'default'),
    ))
    .for('update');

  if (!row) {
    if (input.from !== 'platform') return false;
    const inserted = await db.insert(aiModelAssignments)
      .values({ partnerId: input.partnerId, offeringPartnerId: input.partnerId, surface: 'chat', role: 'default', defaultOfferingId: input.to })
      .onConflictDoNothing()
      .returning({ id: aiModelAssignments.id });
    return inserted.length > 0;
  }

  if (input.from === 'platform') {
    if (row.defaultOfferingId !== null) {
      const [cur] = await db
        .select({ connectionId: partnerAiModels.connectionId })
        .from(partnerAiModels)
        .where(and(eq(partnerAiModels.id, row.defaultOfferingId), eq(partnerAiModels.partnerId, input.partnerId)));
      if (!cur || cur.connectionId !== null) return false;
    }
  } else if (row.defaultOfferingId !== input.from) {
    return false;
  }
  const permitted = row.permitted && !row.permitted.includes(input.to) ? [...row.permitted, input.to] : row.permitted;
  await db.update(aiModelAssignments)
    .set({ defaultOfferingId: input.to, permittedOfferingIds: permitted, updatedAt: new Date() })
    .where(and(eq(aiModelAssignments.id, row.id), eq(aiModelAssignments.partnerId, input.partnerId)));
  return true;
}

/** Disables the offering unless an assignment (any surface, partner or org level) still defaults or falls back to it. */
export async function disableOfferingIfUnused(partnerId: string, offeringId: string): Promise<boolean> {
  const [use] = await db
    .select({ id: aiModelAssignments.id })
    .from(aiModelAssignments)
    .where(and(
      eq(aiModelAssignments.offeringPartnerId, partnerId),
      sql`(${aiModelAssignments.defaultOfferingId} = ${offeringId}::uuid OR ${offeringId}::uuid = ANY(COALESCE(${aiModelAssignments.fallbackOfferingIds}, '{}'::uuid[])))`,
    ))
    .limit(1);
  if (use) return false;
  await db.update(partnerAiModels)
    .set({ enabled: false, updatedAt: new Date() })
    .where(and(eq(partnerAiModels.id, offeringId), eq(partnerAiModels.partnerId, partnerId), eq(partnerAiModels.enabled, true)));
  return true;
}

/**
 * MCP_LLM_PROVIDER no longer openai-compatible: every live env-managed
 * connection is marked released (envReleasedAt). It is NOT handed to the
 * partner as an ordinary connection: it still holds the operator's endpoint
 * and key, so the write services keep it read-only and allow only a
 * disconnect. Nothing is deleted or disabled, so chat keeps working until an
 * admin changes it. No routing field changes (provider_config is not part of
 * an openai_compatible endpoint fingerprint), so config_version is left
 * alone. Returns the number newly released.
 */
export async function releaseEnvManagedConnections(now: Date = new Date()): Promise<number> {
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(
    () => db.update(partnerAiConnections)
      .set({
        providerConfig: sql`${partnerAiConnections.providerConfig} || jsonb_build_object('envReleasedAt', ${now.toISOString()}::text)`,
        updatedAt: now,
      })
      .where(and(
        eq(partnerAiConnections.kind, 'openai_compatible'),
        ne(partnerAiConnections.status, 'disconnected'),
        sql`${partnerAiConnections.providerConfig}->>'managedBy' = 'env'`,
        sql`(${partnerAiConnections.providerConfig}->>'envReleasedAt') IS NULL`,
      ))
      .returning({ id: partnerAiConnections.id }),
    'aiModels.envBootstrap.release',
  ));
  return rows.length;
}
