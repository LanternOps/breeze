/**
 * AI model registry (spec §6): Anthropic model discovery. W01 covers the
 * platform key (`syncPlatformModels`); W03 adds `syncConnectionModels` for
 * BYOK and catalog connections; W06 routes gateway kinds (openai_compatible)
 * through `CONNECTION_MODEL_DISCOVERERS` (connectionDiscovery.ts).
 *
 * Discovery NEVER enables, prices, deletes, or changes an assignment. New ids
 * land unpriced and unoffered, and the operator is alerted.
 */
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { isGatewayConnectionKind, type GatewayConnectionKind, type ModelLifecycle } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiPlatformModels, partnerAiConnections, partnerAiModels } from '../../db/schema';
import { sendOpsAlert } from '../opsAlerts';
import { captureException } from '../sentry';
import { createAnthropicClient, type AnthropicClientTarget } from './connectionFactory';
import { CONNECTION_MODEL_DISCOVERERS, type ConnectionModelDiscoverer } from './connectionDiscovery';
import { decryptConnectionKey, getConnection, getConnectionKeyMaterial, type PartnerAiConnection } from './connections';
import { refreshPlatformModelSnapshot, upsertDiscoveredPlatformModel, type DiscoveredModelInput } from './platformModels';
import { safeErrorMessage } from './safeDbError';
import { containsSecretMaterial, scrubSecrets } from './gateway/scrub';
import type { GatewayConnectionConfig, GatewayCredential } from './gateway/types';
import { gatewayConfigFor, sameRoutingSnapshot } from './gatewayCandidate';

export const ANTHROPIC_API_ORIGIN = 'https://api.anthropic.com';
export type AnthropicModelInfo = DiscoveredModelInput;

/** A plain model identifier; anything else is skipped rather than shown to operators. */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

export async function discoverAnthropicModels(
  apiKey: string | undefined,
  target: AnthropicClientTarget = { kind: 'anthropic' },
): Promise<AnthropicModelInfo[]> {
  const key = apiKey?.trim();
  if (!key) throw new Error('discoverAnthropicModels: an API key is required');
  // Default target pins the public origin with no auth token: the SDK would
  // otherwise pick up ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN from the
  // environment. Built through the connection factory (the only constructor).
  const client = createAnthropicClient({ apiKey: key, target, timeout: 30_000, maxRetries: 2 });
  const models: AnthropicModelInfo[] = [];
  for await (const model of client.models.list({ limit: 100 })) {
    if (typeof model.id !== 'string' || !MODEL_ID_PATTERN.test(model.id)) {
      console.warn(`[aiModels] skipping a listed model with an unexpected id: ${JSON.stringify(String(model.id)).slice(0, 140)}`);
      continue;
    }
    models.push({
      id: model.id,
      displayName: typeof model.display_name === 'string' ? model.display_name : '',
      maxInputTokens: model.max_input_tokens ?? null,
      maxOutputTokens: model.max_tokens ?? null,
      capabilities: model.capabilities ?? null,
    });
  }
  return models;
}

export const LIFECYCLE_MISSING_AFTER_SYNCS = 3;
export const LIFECYCLE_MISSING_MIN_ABSENT_MS = 48 * 3_600_000;
export const LIFECYCLE_RETIRED_AFTER_MS = 14 * 86_400_000;

export function computeLifecycleAfterSync(
  row: { lifecycle: ModelLifecycle; missedSyncCount: number; lastSeenAt: Date | null },
  seen: boolean,
  now: Date,
): { lifecycle: ModelLifecycle; missedSyncCount: number } {
  if (seen) return { lifecycle: 'available', missedSyncCount: 0 };
  // Never observed by a sync (seeded row, e.g. an alias the listing omits): leave it alone.
  if (row.lastSeenAt === null) return { lifecycle: row.lifecycle, missedSyncCount: row.missedSyncCount };
  const missedSyncCount = row.missedSyncCount + 1;
  if (row.lifecycle === 'retired') return { lifecycle: 'retired', missedSyncCount };
  const absentMs = now.getTime() - row.lastSeenAt.getTime();
  if (missedSyncCount >= LIFECYCLE_MISSING_AFTER_SYNCS && absentMs >= LIFECYCLE_RETIRED_AFTER_MS) {
    return { lifecycle: 'retired', missedSyncCount };
  }
  if (missedSyncCount >= LIFECYCLE_MISSING_AFTER_SYNCS && absentMs >= LIFECYCLE_MISSING_MIN_ABSENT_MS) {
    return { lifecycle: 'missing', missedSyncCount };
  }
  return { lifecycle: row.lifecycle, missedSyncCount };
}

export type SyncReport =
  | { status: 'skipped'; reason: 'no_platform_key' | 'custom_base_url' }
  | { status: 'failed'; error: string }
  | {
    status: 'ok';
    discovered: number;
    inserted: string[];
    restored: string[];
    markedMissing: string[];
    retired: string[];
    operatorNotified: boolean;
  };

export interface SyncPlatformModelsOptions {
  env?: NodeJS.ProcessEnv;
  discover?: (apiKey: string) => Promise<AnthropicModelInfo[]>;
  now?: () => Date;
}

function isAnthropicApiOrigin(url: string): boolean {
  try {
    return new URL(url).origin === ANTHROPIC_API_ORIGIN;
  } catch {
    return false;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
}

interface SyncWrite {
  inserted: string[];
  restored: string[];
  markedMissing: string[];
  retired: string[];
  toNotify: Array<{ id: string; modelId: string }>;
  defaultProblem: { modelId: string; lifecycle: ModelLifecycle } | null;
}

function formatSyncAlert(write: SyncWrite): { title: string; body: string } {
  const lines: string[] = [];
  if (write.toNotify.length > 0) {
    lines.push(
      `New Anthropic model(s) discovered: ${write.toNotify.map((m) => m.modelId).join(', ')}.`,
      'They are unpriced and not offered to anyone until a platform admin sets a price and offers them on /admin/ai-models.',
    );
  }
  if (write.markedMissing.length > 0) lines.push(`No longer listed by the Models API (missing): ${write.markedMissing.join(', ')}.`);
  if (write.retired.length > 0) lines.push(`Retired after 14 days unlisted: ${write.retired.join(', ')}.`);
  if (write.defaultProblem) {
    lines.push(`The platform default model ${write.defaultProblem.modelId} is ${write.defaultProblem.lifecycle}; choose another default on /admin/ai-models.`);
  }
  const title = write.toNotify.length > 0
    ? `${write.toNotify.length} new Anthropic model(s) awaiting pricing`
    : 'Anthropic model availability changed';
  return { title, body: lines.join('\n') };
}

export async function syncPlatformModels(options: SyncPlatformModelsOptions = {}): Promise<SyncReport> {
  const env = options.env ?? process.env;
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return { status: 'skipped', reason: 'no_platform_key' };
  const baseUrl = env.ANTHROPIC_BASE_URL?.trim();
  if (baseUrl && !isAnthropicApiOrigin(baseUrl)) return { status: 'skipped', reason: 'custom_base_url' };

  // Network call: never inside a DB context (#1105).
  let discovered: AnthropicModelInfo[];
  try {
    discovered = await runOutsideDbContext(() => (options.discover ?? discoverAnthropicModels)(apiKey));
  } catch (error) {
    captureException(error instanceof Error ? error : new Error(String(error)));
    return { status: 'failed', error: describeError(error) };
  }
  if (discovered.length === 0) return { status: 'failed', error: 'the Models API returned no models' };

  const now = (options.now ?? (() => new Date()))();
  const seenIds = new Set(discovered.map((model) => model.id));

  const write = await runOutsideDbContext(() => withSystemDbAccessContext(async (): Promise<SyncWrite> => {
    // Serialise concurrent syncs (daily + manual + boot across replicas) so
    // missed-sync counts are never double-incremented by overlapping runs.
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('ai-model-discovery:sync-platform', 0))`);

    const inserted: string[] = [];
    const restored: string[] = [];
    for (const model of discovered) {
      const result = await upsertDiscoveredPlatformModel(model, now);
      if (result.inserted) inserted.push(model.id);
      else if (result.previousLifecycle && result.previousLifecycle !== 'available') restored.push(model.id);
    }

    const rows = await db
      .select({
        id: aiPlatformModels.id,
        modelId: aiPlatformModels.modelId,
        lifecycle: aiPlatformModels.lifecycle,
        missedSyncCount: aiPlatformModels.missedSyncCount,
        lastSeenAt: aiPlatformModels.lastSeenAt,
        isPlatformDefault: aiPlatformModels.isPlatformDefault,
      })
      .from(aiPlatformModels)
      .where(eq(aiPlatformModels.provider, 'anthropic'));

    const markedMissing: string[] = [];
    const retired: string[] = [];
    let defaultProblem: SyncWrite['defaultProblem'] = null;
    for (const row of rows) {
      if (seenIds.has(row.modelId)) continue;
      const next = computeLifecycleAfterSync(row, false, now);
      if (next.lifecycle !== row.lifecycle || next.missedSyncCount !== row.missedSyncCount) {
        await db.update(aiPlatformModels)
          .set({ lifecycle: next.lifecycle, missedSyncCount: next.missedSyncCount, updatedAt: now })
          .where(eq(aiPlatformModels.id, row.id));
      }
      if (next.lifecycle !== row.lifecycle) (next.lifecycle === 'missing' ? markedMissing : retired).push(row.modelId);
      if (row.isPlatformDefault && next.lifecycle !== 'available') defaultProblem = { modelId: row.modelId, lifecycle: next.lifecycle };
    }

    // New-to-the-operator ids: discovered by a sync (not seeded), not offered,
    // never successfully alerted. Includes earlier syncs' undelivered alerts.
    const toNotify = await db
      .select({ id: aiPlatformModels.id, modelId: aiPlatformModels.modelId })
      .from(aiPlatformModels)
      .where(and(
        eq(aiPlatformModels.platformOffered, false),
        isNull(aiPlatformModels.operatorNotifiedAt),
        isNotNull(aiPlatformModels.lastSeenAt),
      ));

    return { inserted, restored, markedMissing, retired, toNotify, defaultProblem };
  }, 'aiModels.syncPlatform'));

  let operatorNotified = false;
  if (write.toNotify.length > 0 || write.markedMissing.length > 0 || write.retired.length > 0 || write.defaultProblem) {
    operatorNotified = await sendOpsAlert(formatSyncAlert(write));
    if (!operatorNotified) {
      console.warn('[aiModels] model discovery alert was not delivered (ops alerting unconfigured or failing); new models are flagged on /admin/ai-models');
    }
    if (operatorNotified && write.toNotify.length > 0) {
      // The alert already went out. A failed mark must not fail the job:
      // BullMQ would retry the whole sync and send the same alert again. The
      // next daily sync re-alerts these ids at worst.
      try {
        await runOutsideDbContext(() => withSystemDbAccessContext(() =>
          db.update(aiPlatformModels)
            .set({ operatorNotifiedAt: now })
            .where(inArray(aiPlatformModels.id, write.toNotify.map((row) => row.id))),
        'aiModels.markNotified'));
      } catch (error) {
        const message = safeErrorMessage(error);
        console.warn('[aiModels] could not mark discovered models as notified; they will be re-alerted on the next sync:', message);
        captureException(new Error(`AI model discovery notify mark failed: ${message}`));
      }
    }
  }

  try {
    await refreshPlatformModelSnapshot();
  } catch (error) {
    const message = safeErrorMessage(error);
    console.warn('[aiModels] snapshot refresh after sync failed; the periodic refresher will retry:', message);
    captureException(new Error(`AI platform model snapshot refresh after sync failed: ${message}`));
  }

  return {
    status: 'ok',
    discovered: discovered.length,
    inserted: write.inserted,
    restored: write.restored,
    markedMissing: write.markedMissing,
    retired: write.retired,
    operatorNotified,
  };
}

// ── W03 (#7601, Task 16): BYOK and catalog connections ─────────────────────

/** Spec §6 names; the rule itself is W01's {@link computeLifecycleAfterSync}. */
export const MISSING_AFTER_SUCCESSFUL_SYNCS = LIFECYCLE_MISSING_AFTER_SYNCS;
export const RETIRED_AFTER_DAYS = LIFECYCLE_RETIRED_AFTER_MS / 86_400_000;

export interface ConnectionSyncReport {
  connectionId: string;
  status: 'ok' | 'failed' | 'skipped';
  discovered: number;
  added: number;
  markedMissing: number;
  markedRetired: number;
  error?: string;
  /** Skipped because the key or endpoint changed while listing: run it again (with the new material). */
  retry?: boolean;
}

export interface SyncConnectionModelsDeps {
  discoverAnthropicModels: typeof discoverAnthropicModels;
  /** Gateway-kind listers (W06); defaults to CONNECTION_MODEL_DISCOVERERS. */
  connectionDiscoverers?: Partial<Record<GatewayConnectionKind, ConnectionModelDiscoverer>>;
}

/** displayName is only taken from gateway listings, and only on insert (an admin's name is never overwritten). */
interface FoundModel { modelId: string; capabilities: unknown; displayName: string | null }

/** Everything a gateway listing needs, read before the network call. */
interface GatewayListing {
  discoverer: ConnectionModelDiscoverer;
  config: GatewayConnectionConfig;
  credential: GatewayCredential;
}

/** Offerings discovery owns. Manual (and platform) rows are the admin's: never aged. */
const DISCOVERY_OWNED_SOURCES = ['discovered', 'catalog'] as const;

const sysTx = <T>(fn: () => Promise<T>, label: string) =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

/**
 * Safe to store and log: SQL values scrubbed (safeDbError), the connection key
 * (and its encodings/tail) and generic key shapes never echoed, capped.
 */
function connectionSyncError(error: unknown, apiKey: string | null): string {
  return scrubSecrets(safeErrorMessage(error), [apiKey], 500);
}

async function listConnectionModels(
  conn: PartnerAiConnection,
  deps: SyncConnectionModelsDeps,
  keyRef: { key: string | null },
  gateway: GatewayListing | null,
): Promise<FoundModel[]> {
  if (gateway) {
    keyRef.key = gateway.credential.secret;
    // The partner's endpoint, through the gateway's guarded egress
    // (forwardUpstream): never a direct client to base_url.
    const models = await gateway.discoverer({ config: gateway.config, credential: gateway.credential });
    // Same rule as W01: an empty listing is a failure, never a mass "missing".
    if (models.length === 0) throw new Error('The endpoint listed no usable models.');
    // capabilities null: discovery never writes capabilities for a gateway
    // offering (only the verifier does), and the upsert's COALESCE keeps a
    // verification record already on the row.
    return withoutKeyMaterial(models, gateway.credential.secret)
      .map((model) => ({ modelId: model.modelId, capabilities: null, displayName: model.displayName }));
  }
  if (conn.kind === 'anthropic_byok') {
    const material = await sysTx(() => getConnectionKeyMaterial(conn.id), 'aiModels.syncConnection.key');
    if (!material) throw new Error('The connection no longer exists.');
    keyRef.key = decryptConnectionKey(material);
    // The partner's key, pinned to the public API (connection factory target):
    // never the platform key, never an ambient ANTHROPIC_BASE_URL.
    const models = await deps.discoverAnthropicModels(keyRef.key, { kind: 'anthropic' });
    // W01 rule: an empty listing is a failure, never a mass "missing".
    if (models.length === 0) throw new Error('the Models API returned no models');
    return models.map((model) => ({ modelId: model.id, capabilities: model.capabilities ?? null, displayName: null }));
  }
  // Catalog: mirror the entry's CURRENT listed revision, only models both
  // mapped and verified. The revision is the platform's vetted listing, so the
  // gateway itself is not called. Lazy: keeps this module's import graph light.
  const [{ getListedProviderByEntryId }, { isLlmProviderCatalogEnabled }] = await Promise.all([
    import('../llmProviderCatalog'),
    import('../llm/llmConfigResolver'),
  ]);
  if (!isLlmProviderCatalogEnabled()) throw new Error('Catalog endpoints are disabled on this deployment.');
  const provider = conn.catalogEntryId ? await getListedProviderByEntryId(conn.catalogEntryId) : null;
  if (!provider) throw new Error('The catalog provider for this connection is not listed.');
  return [...new Set(provider.verifiedModels)]
    .filter((id) => Object.hasOwn(provider.modelMap, id))
    .map((id) => ({ modelId: id, capabilities: null, displayName: null }));
}

/** Shortest run of the key that is treated as the key itself when it appears in endpoint-supplied text. */
const KEY_WINDOW = 12;

function carriesKey(text: string, key: string | null): boolean {
  if (!key) return false;
  const hay = text.toLowerCase();
  const needle = key.toLowerCase();
  if (needle.length <= KEY_WINDOW) return hay.includes(needle);
  for (let i = 0; i + KEY_WINDOW <= needle.length; i += 1) {
    if (hay.includes(needle.slice(i, i + KEY_WINDOW))) return true;
  }
  return false;
}

/** Whether `text` carries the key: case-insensitive 12-char windows, or anything the gateway scrubber detects (encodings and their fragments). */
function leaksKey(text: string, key: string | null): boolean {
  return carriesKey(text, key) || containsSecretMaterial(text, key);
}

/** The gateway scrubber would redact a generic credential shape in `text` (key or not). */
function hasGenericCredentialShape(text: string): boolean {
  const count = (t: string) => t.split('[redacted]').length;
  return count(scrubSecrets(text, [], Number.MAX_SAFE_INTEGER)) > count(text);
}

/**
 * An endpoint's /models listing is stored and shown to admins, so it must
 * never carry the connection key back into the database: a listed id that
 * contains the key, any 12-character run of it, or an encoding of it (hex,
 * base64/base64url, percent-encoding, or a fragment of one) is skipped, and a
 * display name that does the same or holds a generic credential shape is
 * dropped (the row falls back to its model id).
 */
export function withoutKeyMaterial<T extends { modelId: string; displayName: string | null }>(
  models: readonly T[],
  key: string | null,
): T[] {
  const out: T[] = [];
  for (const model of models) {
    if (leaksKey(model.modelId, key)) {
      console.warn('[aiModels] skipping a listed model whose id carries credential material');
      continue;
    }
    const name = model.displayName;
    const nameLeaks = name !== null && (leaksKey(name, key) || hasGenericCredentialShape(name));
    out.push(nameLeaks ? { ...model, displayName: null } : model);
  }
  return out;
}

async function recordDiscoveryError(connectionId: string, message: string): Promise<void> {
  try {
    await sysTx(() => db.update(partnerAiConnections)
      .set({ discoveryError: message })
      .where(eq(partnerAiConnections.id, connectionId)), 'aiModels.syncConnection.recordError');
  } catch (writeError) {
    console.warn(`[aiModels] could not record discovery_error on connection ${connectionId}: ${safeErrorMessage(writeError)}`);
  }
}

type GatewayPreparation =
  | { kind: 'ready'; listing: GatewayListing }
  | { kind: 'skip'; error: string }
  | { kind: 'superseded' }
  | { kind: 'fail'; error: string };

/**
 * The discoverer, config and credential for a gateway connection. Status is
 * read in the SAME row read as the key: a disconnected row also has a NULL key,
 * so it must never be taken for a keyless endpoint. So are kind, base URL and
 * config_version: a key row from a newer endpoint state than `conn` (the URL
 * and key changed between the two reads) is never sent to `conn`'s URL — the
 * sync is skipped for a re-run against the new state.
 */
async function prepareGatewayListing(
  conn: PartnerAiConnection & { kind: GatewayConnectionKind },
  deps: SyncConnectionModelsDeps,
): Promise<GatewayPreparation> {
  const discoverer = (deps.connectionDiscoverers ?? CONNECTION_MODEL_DISCOVERERS)[conn.kind];
  if (!discoverer) return { kind: 'skip', error: `${conn.kind} models are entered by hand` };
  const config = gatewayConfigFor(conn);
  if (!config) return { kind: 'skip', error: 'connection has no endpoint' };
  const material = await sysTx(() => getConnectionKeyMaterial(conn.id), 'aiModels.syncConnection.key');
  if (!material || material.partnerId !== conn.partnerId) return { kind: 'skip', error: 'connection not found' };
  if (material.status !== 'active') return { kind: 'skip', error: 'connection disconnected' };
  if (!sameRoutingSnapshot(material, conn)) return { kind: 'superseded' };
  if (material.apiKeyEncrypted === null) return { kind: 'ready', listing: { discoverer, config, credential: { secret: null } } };
  try {
    return { kind: 'ready', listing: { discoverer, config, credential: { secret: decryptConnectionKey(material) } } };
  } catch {
    // The decrypt error text is not stored: a fixed message is enough to act on.
    return { kind: 'fail', error: 'The stored key for this connection could not be decrypted; re-enter it.' };
  }
}

/**
 * Spec §6 for ONE connection (`ai-model-discovery` job `sync-connection`).
 * New ids land as DISABLED offerings (BYOK: linked to the platform row when
 * the ids match). Lifecycle follows W01's rule, only for rows discovery owns
 * and has seen at least once. Never enables, never touches an assignment,
 * never deletes; a failed listing records `discovery_error` and changes no
 * lifecycle.
 */
export async function syncConnectionModels(
  connectionId: string,
  now: Date = new Date(),
  deps: SyncConnectionModelsDeps = { discoverAnthropicModels },
): Promise<ConnectionSyncReport> {
  const base = { connectionId, discovered: 0, added: 0, markedMissing: 0, markedRetired: 0 };
  const conn = await sysTx(() => getConnection(connectionId), 'aiModels.syncConnection.read');
  if (!conn) return { ...base, status: 'skipped', error: 'connection not found' };
  // Before any kind dispatch: a disconnected row is never listed (W06 alignment).
  if (conn.status === 'disconnected') return { ...base, status: 'skipped', error: 'connection disconnected' };
  const gatewayKind = isGatewayConnectionKind(conn.kind);
  if (conn.kind !== 'anthropic_byok' && conn.kind !== 'catalog' && !gatewayKind) {
    return { ...base, status: 'skipped', error: `${conn.kind} discovery is not supported` };
  }

  let gateway: GatewayListing | null = null;
  if (gatewayKind) {
    const prepared = await prepareGatewayListing(conn as PartnerAiConnection & { kind: GatewayConnectionKind }, deps);
    if (prepared.kind === 'skip') return { ...base, status: 'skipped', error: prepared.error };
    if (prepared.kind === 'superseded') return { ...base, status: 'skipped', retry: true, error: 'connection changed during sync' };
    if (prepared.kind === 'fail') {
      console.warn(`[aiModels] connection ${conn.id} model discovery failed: ${prepared.error}`);
      await recordDiscoveryError(conn.id, prepared.error);
      return { ...base, status: 'failed', error: prepared.error };
    }
    gateway = prepared.listing;
  }

  // Network call outside any DB context (#1105).
  const keyRef: { key: string | null } = { key: null };
  let found: FoundModel[];
  try {
    found = await listConnectionModels(conn, deps, keyRef, gateway);
  } catch (error) {
    const message = connectionSyncError(error, keyRef.key);
    console.warn(`[aiModels] connection ${conn.id} model discovery failed: ${message}`);
    await recordDiscoveryError(conn.id, message);
    return { ...base, status: 'failed', error: message };
  } finally {
    // Best effort: the plaintext is not needed past the listing.
    if (gateway) gateway.credential.secret = null;
    keyRef.key = null;
  }

  const seen = new Set(found.map((f) => f.modelId));
  const outcome = await sysTx(async () => {
    // Row lock: serialises overlapping syncs of this connection (missed-sync
    // counts never double-increment) and facade writes. A key or endpoint
    // change since the listing makes the listing stale.
    const [current] = await db
      .select({
        kind: partnerAiConnections.kind,
        status: partnerAiConnections.status,
        configVersion: partnerAiConnections.configVersion,
        catalogEntryId: partnerAiConnections.catalogEntryId,
        baseUrl: partnerAiConnections.baseUrl,
      })
      .from(partnerAiConnections)
      .where(eq(partnerAiConnections.id, conn.id))
      .for('update');
    if (!current) return { kind: 'gone' as const };
    // Disconnected while listing: never write offerings onto a dead connection.
    if (current.status === 'disconnected') return { kind: 'disconnected' as const };
    if (current.kind !== conn.kind || current.configVersion !== conn.configVersion
      || current.catalogEntryId !== conn.catalogEntryId || current.baseUrl !== conn.baseUrl) {
      return { kind: 'superseded' as const };
    }

    const platformIds = new Map<string, string>();
    if (conn.kind === 'anthropic_byok' && seen.size > 0) {
      const platformRows = await db
        .select({ id: aiPlatformModels.id, modelId: aiPlatformModels.modelId })
        .from(aiPlatformModels)
        .where(inArray(aiPlatformModels.modelId, [...seen]));
      for (const row of platformRows) platformIds.set(row.modelId, row.id);
    }
    // Gateway kinds land 'discovered' too (catalog_shape_chk forbids prices on 'catalog').
    const source = conn.kind === 'catalog' ? 'catalog' : 'discovered';

    let added = 0;
    for (const f of found) {
      const capabilities = f.capabilities === null ? null : JSON.stringify(f.capabilities);
      const rows = await db.execute<{ inserted: boolean }>(sql`
        INSERT INTO partner_ai_models (partner_id, connection_id, platform_model_id, model_id, source, display_name,
          capabilities, enabled, lifecycle, last_seen_at, missed_sync_count)
        VALUES (${conn.partnerId}::uuid, ${conn.id}::uuid, ${platformIds.get(f.modelId) ?? null}::uuid, ${f.modelId}, ${source},
          ${f.displayName}, ${capabilities}::jsonb, false, 'available', ${now.toISOString()}::timestamptz, 0)
        ON CONFLICT (connection_id, model_id) WHERE connection_id IS NOT NULL DO UPDATE SET
          lifecycle = 'available',
          last_seen_at = EXCLUDED.last_seen_at,
          missed_sync_count = 0,
          platform_model_id = COALESCE(partner_ai_models.platform_model_id, EXCLUDED.platform_model_id),
          capabilities = CASE WHEN partner_ai_models.source = 'discovered'
                              THEN COALESCE(EXCLUDED.capabilities, partner_ai_models.capabilities)
                              ELSE partner_ai_models.capabilities END,
          updated_at = now()
        RETURNING (xmax = 0) AS inserted`);
      // enabled, prices and display_name are deliberately never written on
      // conflict: discovery never enables or re-prices (spec §6).
      if (rows[0]?.inserted) added += 1;
    }

    const owned = await db
      .select({
        id: partnerAiModels.id,
        modelId: partnerAiModels.modelId,
        lifecycle: partnerAiModels.lifecycle,
        missedSyncCount: partnerAiModels.missedSyncCount,
        lastSeenAt: partnerAiModels.lastSeenAt,
      })
      .from(partnerAiModels)
      .where(and(
        eq(partnerAiModels.connectionId, conn.id),
        inArray(partnerAiModels.source, [...DISCOVERY_OWNED_SOURCES]),
      ));
    let markedMissing = 0;
    let markedRetired = 0;
    for (const row of owned) {
      if (row.modelId !== null && seen.has(row.modelId)) continue;
      // Never-seen rows (lastSeenAt NULL: projected offerings, aliases the
      // listing omits) come back unchanged — W01's guard.
      const next = computeLifecycleAfterSync(row, false, now);
      if (next.lifecycle === row.lifecycle && next.missedSyncCount === row.missedSyncCount) continue;
      await db.update(partnerAiModels)
        .set({ lifecycle: next.lifecycle, missedSyncCount: next.missedSyncCount, updatedAt: now })
        .where(eq(partnerAiModels.id, row.id));
      if (next.lifecycle !== row.lifecycle && next.lifecycle === 'missing') markedMissing += 1;
      if (next.lifecycle !== row.lifecycle && next.lifecycle === 'retired') markedRetired += 1;
    }

    await db.update(partnerAiConnections)
      .set({ lastDiscoveredAt: now, discoveryError: null })
      .where(eq(partnerAiConnections.id, conn.id));
    return { kind: 'written' as const, added, markedMissing, markedRetired };
  }, 'aiModels.syncConnection.write');

  if (outcome.kind === 'gone') return { ...base, status: 'skipped', error: 'connection not found' };
  if (outcome.kind === 'disconnected') return { ...base, status: 'skipped', error: 'connection disconnected' };
  if (outcome.kind === 'superseded') {
    return { ...base, status: 'skipped', retry: true, error: 'connection changed during sync' };
  }
  return {
    ...base,
    status: 'ok',
    discovered: found.length,
    added: outcome.added,
    markedMissing: outcome.markedMissing,
    markedRetired: outcome.markedRetired,
  };
}
