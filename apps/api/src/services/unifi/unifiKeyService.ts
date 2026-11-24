/**
 * UniFi Site Manager API keys of a cloud connection (#11808).
 *
 * `unifi_integration_keys` holds one encrypted key per row. Every seal and open
 * goes through `columnAad(UNIFI_KEY_COLUMN_SPEC)`, which is the legacy column
 * tag `unifi_integrations.api_key_encrypted`: the W1 migration copied existing
 * ciphertext verbatim, so the new table's own name is never the AAD.
 *
 * No function here returns, logs or stores a key's ciphertext or plaintext
 * outside `getSyncKeys`, whose result is for building a UniFi client only.
 */
import { and, asc, count, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { unifiIntegrationKeys, unifiIntegrations } from '../../db/schema';
import { columnAad, UNIFI_KEY_COLUMN_SPEC } from '../encryptedColumnRegistry';
import { decryptSecret, encryptSecret } from '../secretCrypto';
import type { DbExecutor } from './unifiConnectionService';
import type { KeyRunResult } from './unifiSyncService';

export type UnifiKeyStatus = 'pending' | 'connected' | 'reauth_required' | 'error';

export interface UnifiKeySummary {
  id: string;
  label: string;
  keyLast4: string | null;
  isEnabled: boolean;
  status: UnifiKeyStatus;
  lastSyncAt: Date | null;
  lastSyncStatus: 'success' | 'failed' | 'skipped' | null;
  lastSyncError: string | null;
  lastOkAt: Date | null;
  hostsSeen: number | null;
  sitesSeen: number | null;
  createdAt: Date;
}

export type UnifiSyncKey =
  | { id: string; label: string; apiKey: string; keyLast4: string | null; lastSeenHostIds: string[] | null }
  | { id: string; label: string; apiKey: null; decryptError: string; lastSeenHostIds: string[] | null };

/** Fixed text: a decrypt failure's own message is never stored or returned. */
export const UNIFI_KEY_DECRYPT_ERROR = 'The stored API key could not be decrypted';

const KEY_AAD = columnAad(UNIFI_KEY_COLUMN_SPEC);

export function sealUnifiKey(apiKey: string): string {
  const sealed = encryptSecret(apiKey, { aad: KEY_AAD });
  if (!sealed) throw new Error('sealUnifiKey: an empty API key cannot be sealed');
  return sealed;
}

/**
 * Opens a stored key. Returns null for an empty value and THROWS when the
 * ciphertext does not decrypt (wrong key material or a tampered value);
 * callers decide what a failure means.
 */
export function openUnifiKey(ciphertext: string): string | null {
  return decryptSecret(ciphertext, { aad: KEY_AAD });
}

/** The last four characters of a key, shown so similar keys can be told apart. */
export function unifiKeyLast4(apiKey: string): string {
  return apiKey.slice(-4);
}

// Precedence order of a connection's keys (plan D4). A function, not a constant, so
// importing this module never touches the schema objects.
const stableOrder = () => [asc(unifiIntegrationKeys.createdAt), asc(unifiIntegrationKeys.id)] as const;

export async function listKeys(db: DbExecutor, integrationId: string, partnerId: string): Promise<UnifiKeySummary[]> {
  // Never select api_key_encrypted here: this feeds API responses.
  const rows = await db
    .select({
      id: unifiIntegrationKeys.id,
      label: unifiIntegrationKeys.label,
      keyLast4: unifiIntegrationKeys.keyLast4,
      isEnabled: unifiIntegrationKeys.isEnabled,
      status: unifiIntegrationKeys.status,
      lastSyncAt: unifiIntegrationKeys.lastSyncAt,
      lastSyncStatus: unifiIntegrationKeys.lastSyncStatus,
      lastSyncError: unifiIntegrationKeys.lastSyncError,
      lastOkAt: unifiIntegrationKeys.lastOkAt,
      hostsSeen: unifiIntegrationKeys.hostsSeen,
      sitesSeen: unifiIntegrationKeys.sitesSeen,
      createdAt: unifiIntegrationKeys.createdAt,
    })
    .from(unifiIntegrationKeys)
    .where(and(eq(unifiIntegrationKeys.integrationId, integrationId), eq(unifiIntegrationKeys.partnerId, partnerId)))
    .orderBy(...stableOrder());
  return (rows as any[]).map((r) => ({
    id: r.id,
    label: r.label,
    keyLast4: r.keyLast4 ?? null,
    isEnabled: r.isEnabled,
    status: r.status as UnifiKeyStatus,
    lastSyncAt: r.lastSyncAt ?? null,
    lastSyncStatus: (r.lastSyncStatus ?? null) as UnifiKeySummary['lastSyncStatus'],
    lastSyncError: r.lastSyncError ?? null,
    lastOkAt: r.lastOkAt ?? null,
    hostsSeen: r.hostsSeen ?? null,
    sitesSeen: r.sitesSeen ?? null,
    createdAt: r.createdAt,
  }));
}

type KeyRow = {
  id: string;
  label: string;
  apiKeyEncrypted: string;
  keyLast4: string | null;
  isEnabled: boolean;
  lastSeenHostIds: string[] | null;
};

function tryOpen(ciphertext: string | null | undefined): { ok: true; value: string | null } | { ok: false } {
  if (!ciphertext) return { ok: true, value: null };
  try {
    return { ok: true, value: openUnifiKey(ciphertext) };
  } catch {
    return { ok: false };
  }
}

/**
 * Rollout reconcile (plan D12; removed in W3). During the W1 deploy an older
 * API instance can still write a reconnect to the legacy column alone. While a
 * connection has exactly one key, a legacy plaintext that differs from the key
 * row's is the newer value (nothing else writes the key row's secret in W1/W2),
 * so it is copied into the key row. An unreadable legacy value means "no
 * adoption": the key row stands, and the sync is not failed for it.
 */
async function reconcileLegacyKey(
  db: DbExecutor,
  integrationId: string,
  partnerId: string,
  legacyCiphertext: string | null,
  row: KeyRow,
): Promise<KeyRow> {
  if (!legacyCiphertext || legacyCiphertext === row.apiKeyEncrypted) return row;
  const legacy = tryOpen(legacyCiphertext);
  if (!legacy.ok) {
    console.warn('[unifi] legacy key unreadable; not adopted', { integrationId });
    return row;
  }
  if (!legacy.value) return row;
  const current = tryOpen(row.apiKeyEncrypted);
  if (current.ok && current.value === legacy.value) return row;

  // Conditional on the key row still holding what was read: a reconnect that
  // committed between the two reads must not be overwritten by the older value.
  const adopted = await db
    .update(unifiIntegrationKeys)
    .set({ apiKeyEncrypted: legacyCiphertext, keyLast4: null, updatedAt: new Date() })
    .where(and(
      eq(unifiIntegrationKeys.id, row.id),
      eq(unifiIntegrationKeys.integrationId, integrationId),
      eq(unifiIntegrationKeys.partnerId, partnerId),
      eq(unifiIntegrationKeys.apiKeyEncrypted, row.apiKeyEncrypted),
    ))
    .returning({ id: unifiIntegrationKeys.id });
  if (adopted.length === 0) {
    console.warn('[unifi] legacy key adoption matched no key row; not adopted', { integrationId });
    return row;
  }
  console.log('[unifi] adopted a reconnect written by an older API instance', { integrationId });
  return { ...row, apiKeyEncrypted: legacyCiphertext, keyLast4: null };
}

function toSyncKey(row: KeyRow): UnifiSyncKey {
  const opened = tryOpen(row.apiKeyEncrypted);
  if (!opened.ok || !opened.value) {
    return { id: row.id, label: row.label, apiKey: null, decryptError: UNIFI_KEY_DECRYPT_ERROR, lastSeenHostIds: row.lastSeenHostIds ?? null };
  }
  return {
    id: row.id,
    label: row.label,
    apiKey: opened.value,
    keyLast4: row.keyLast4 ?? null,
    lastSeenHostIds: row.lastSeenHostIds ?? null,
  };
}

/**
 * The base URL and every ENABLED key of an active cloud integration, in stable
 * `created_at, id` order, decrypted. A key that does not decrypt is returned as
 * a `decryptError` entry, never silently skipped. Returns null unless an active
 * cloud integration matches `(integrationId, partnerId)`.
 */
export async function getSyncKeys(
  db: DbExecutor,
  integrationId: string,
  partnerId: string,
): Promise<{ baseUrl: string; keys: UnifiSyncKey[] } | null> {
  const [integration] = await db
    .select({
      id: unifiIntegrations.id,
      baseUrl: unifiIntegrations.baseUrl,
      connectionType: unifiIntegrations.connectionType,
      apiKeyEncrypted: unifiIntegrations.apiKeyEncrypted,
    })
    .from(unifiIntegrations)
    .where(and(
      eq(unifiIntegrations.id, integrationId),
      eq(unifiIntegrations.partnerId, partnerId),
      eq(unifiIntegrations.isActive, true),
    ))
    .limit(1);
  if (!integration || integration.connectionType !== 'cloud') return null;

  let rows = (await db
    .select({
      id: unifiIntegrationKeys.id,
      label: unifiIntegrationKeys.label,
      apiKeyEncrypted: unifiIntegrationKeys.apiKeyEncrypted,
      keyLast4: unifiIntegrationKeys.keyLast4,
      isEnabled: unifiIntegrationKeys.isEnabled,
      lastSeenHostIds: unifiIntegrationKeys.lastSeenHostIds,
    })
    .from(unifiIntegrationKeys)
    .where(and(eq(unifiIntegrationKeys.integrationId, integrationId), eq(unifiIntegrationKeys.partnerId, partnerId)))
    .orderBy(...stableOrder())) as KeyRow[];

  if (rows.length === 1) {
    rows = [await reconcileLegacyKey(db, integrationId, partnerId, integration.apiKeyEncrypted ?? null, rows[0]!)];
  }

  return {
    baseUrl: integration.baseUrl,
    keys: rows.filter((r) => r.isEnabled).map(toSyncKey),
  };
}

/** How many ENABLED keys the connection holds (D9: several means mapping deletes must be explicit). */
export async function countEnabledKeys(db: DbExecutor, integrationId: string, partnerId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(unifiIntegrationKeys)
    .where(and(
      eq(unifiIntegrationKeys.integrationId, integrationId),
      eq(unifiIntegrationKeys.partnerId, partnerId),
      eq(unifiIntegrationKeys.isEnabled, true),
    ));
  return Number(row?.n ?? 0);
}

const MAX_KEY_ERROR = 500;
const clipError = (text: string | null) => (text === null ? null : text.length > MAX_KEY_ERROR ? `${text.slice(0, MAX_KEY_ERROR - 1)}…` : text);

/**
 * Writes each key's outcome of one sync run onto its row (plan D6). Every write
 * is conditional on the row still belonging to the connection and on
 * `last_sync_at` being older than this run's start, so a run that finishes late
 * never overwrites a newer run's result. A 0-row match (the key was deleted
 * mid-run, or a newer run already recorded) is skipped, not thrown.
 *
 * `keyLast4ById` holds the last four characters of keys whose `key_last4` is
 * unset (a backfilled key); they are filled only while the column is still NULL.
 * Nothing here writes or logs a key.
 */
export async function recordKeyResults(
  db: DbExecutor,
  a: { integrationId: string; partnerId: string; runStartedAt: Date; results: KeyRunResult[]; keyLast4ById: Map<string, string> },
): Promise<void> {
  for (const r of a.results) {
    const now = new Date();
    const set: PgUpdateSetSource<typeof unifiIntegrationKeys> = { lastSyncAt: a.runStartedAt, updatedAt: now };
    if (r.status === 'success') {
      set.status = 'connected';
      set.lastSyncStatus = 'success';
      set.lastSyncError = null;
      set.lastOkAt = now;
      if (r.hostsSeen !== null) set.hostsSeen = r.hostsSeen;
      // A hosts-only run read no sites: keep the last counts and reach snapshot.
      if (r.sitesSeen !== null) set.sitesSeen = r.sitesSeen;
      if (r.hostIds !== null) set.lastSeenHostIds = r.hostIds;
      const last4 = a.keyLast4ById.get(r.keyId);
      if (last4) set.keyLast4 = sql`coalesce(${unifiIntegrationKeys.keyLast4}, ${last4})`;
    } else if (r.status === 'failed') {
      set.status = r.authFailure ? 'reauth_required' : 'error';
      set.lastSyncStatus = 'failed';
      set.lastSyncError = clipError(r.error ?? 'UniFi sync failed');
    } else {
      set.lastSyncStatus = 'skipped';
      set.lastSyncError = clipError(r.error);
    }
    await db
      .update(unifiIntegrationKeys)
      .set(set)
      .where(and(
        eq(unifiIntegrationKeys.id, r.keyId),
        eq(unifiIntegrationKeys.integrationId, a.integrationId),
        eq(unifiIntegrationKeys.partnerId, a.partnerId),
        or(isNull(unifiIntegrationKeys.lastSyncAt), lt(unifiIntegrationKeys.lastSyncAt, a.runStartedAt)),
      ))
      .returning({ id: unifiIntegrationKeys.id });
  }
}
