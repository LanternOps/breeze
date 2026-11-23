/**
 * UniFi Site Manager API keys of a cloud connection (#11808).
 *
 * `unifi_integration_keys` holds one encrypted key per row. Every seal and open
 * goes through `columnAad(UNIFI_KEY_COLUMN_SPEC)`, which is the legacy column
 * tag `unifi_integrations.api_key_encrypted`: the W1 migration copied existing
 * ciphertext verbatim, so the new table's own name is never the AAD.
 *
 * No function here returns, logs or stores a key's ciphertext or plaintext
 * outside `getSyncKeys` and `getKeyForTest`, whose results are for building a
 * UniFi client only.
 */
import { and, asc, count, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { isPgUniqueViolation } from '@breeze/shared/pgErrors';
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

// The columns of a key summary. Never api_key_encrypted: summaries feed API
// responses. A function, so importing this module never touches the schema.
const summaryColumns = () => ({
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
});

function toSummary(r: any): UnifiKeySummary {
  return {
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
  };
}

export async function listKeys(db: DbExecutor, integrationId: string, partnerId: string): Promise<UnifiKeySummary[]> {
  const rows = await db
    .select(summaryColumns())
    .from(unifiIntegrationKeys)
    .where(and(eq(unifiIntegrationKeys.integrationId, integrationId), eq(unifiIntegrationKeys.partnerId, partnerId)))
    .orderBy(...stableOrder());
  return (rows as any[]).map(toSummary);
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

function toSyncKey(row: KeyRow): UnifiSyncKey {
  const opened = tryOpen(row.apiKeyEncrypted);
  if (!opened.ok || !opened.value) {
    // By key id only: the ciphertext and the decrypt error's text stay out of logs.
    console.warn('[unifi] a stored API key did not decrypt', { keyId: row.id });
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
    })
    .from(unifiIntegrations)
    .where(and(
      eq(unifiIntegrations.id, integrationId),
      eq(unifiIntegrations.partnerId, partnerId),
      eq(unifiIntegrations.isActive, true),
    ))
    .limit(1);
  if (!integration || integration.connectionType !== 'cloud') return null;

  const rows = (await db
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

// ---------------------------------------------------------------------------
// Key management (#11808 W3).
//
// Every write runs in one transaction that first locks the active integration
// row (FOR NO KEY UPDATE). That lock serializes the cap, label and last-enabled checks
// against each other and against `/connect` (upsertConnection takes the same
// lock), so two concurrent adds with one slot left end with 25 keys, not 26.
// The label unique index is the backstop; its 23505 is mapped OUTSIDE the
// transaction, so the savepoint has already rolled back when it is caught.
// ---------------------------------------------------------------------------

export const UNIFI_MAX_KEYS = 25;
export const UNIFI_KEY_LABEL_MAX = 100;

export type UnifiKeyErrorCode =
  | 'UNIFI_KEY_LIMIT'
  | 'UNIFI_KEY_LABEL_TAKEN'
  | 'UNIFI_KEY_LABEL_INVALID'
  | 'UNIFI_LAST_ENABLED_KEY'
  | 'UNIFI_NOT_CLOUD'
  | 'UNIFI_NOT_CONNECTED'
  | 'UNIFI_KEY_NOT_FOUND';

const KEY_ERROR_MESSAGES: Record<UnifiKeyErrorCode, string> = {
  UNIFI_KEY_LIMIT: `A UniFi connection can hold at most ${UNIFI_MAX_KEYS} API keys.`,
  UNIFI_KEY_LABEL_TAKEN: 'Another API key on this connection already has that label.',
  UNIFI_KEY_LABEL_INVALID: `A key label must be 1 to ${UNIFI_KEY_LABEL_MAX} characters.`,
  UNIFI_LAST_ENABLED_KEY: 'This is the last enabled API key on the connection. Enable or add another key first, or disconnect the integration.',
  UNIFI_NOT_CLOUD: 'Only a UniFi Site Manager (cloud) connection has API keys.',
  UNIFI_NOT_CONNECTED: 'Not connected',
  UNIFI_KEY_NOT_FOUND: 'API key not found.',
};

/** A refused key change. The message is fixed text: it never carries a key or a database error. */
export class UnifiKeyError extends Error {
  readonly code: UnifiKeyErrorCode;
  constructor(code: UnifiKeyErrorCode) {
    super(KEY_ERROR_MESSAGES[code]);
    this.name = 'UnifiKeyError';
    this.code = code;
  }
}

const LABEL_INDEX = 'unifi_integration_keys_label_idx';

/** Trimmed; 1-100 characters (code points, as the DB CHECK's char_length counts them). */
function normalizeLabel(label: string): string {
  const trimmed = label.trim();
  const length = Array.from(trimmed).length;
  if (length < 1 || length > UNIFI_KEY_LABEL_MAX) throw new UnifiKeyError('UNIFI_KEY_LABEL_INVALID');
  return trimmed;
}

async function mapLabelConflict<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isPgUniqueViolation(err, LABEL_INDEX)) throw new UnifiKeyError('UNIFI_KEY_LABEL_TAKEN');
    throw err;
  }
}

/** Locks the active integration row; refuses a missing or self-hosted one. */
async function lockCloudIntegration(tx: DbExecutor, integrationId: string, partnerId: string): Promise<void> {
  const [row] = await tx
    .select({ id: unifiIntegrations.id, connectionType: unifiIntegrations.connectionType })
    .from(unifiIntegrations)
    .where(and(
      eq(unifiIntegrations.id, integrationId),
      eq(unifiIntegrations.partnerId, partnerId),
      eq(unifiIntegrations.isActive, true),
    ))
    .limit(1)
    // NO KEY UPDATE conflicts with itself and with upsertConnection's FOR
    // UPDATE, so key writes stay serialized, but not with the KEY SHARE locks
    // the sync apply's foreign-key checks take on this row.
    .for('no key update');
  if (!row) throw new UnifiKeyError('UNIFI_NOT_CONNECTED');
  if (row.connectionType !== 'cloud') throw new UnifiKeyError('UNIFI_NOT_CLOUD');
}

async function lockedKeyRows(
  tx: DbExecutor,
  integrationId: string,
  partnerId: string,
): Promise<Array<{ id: string; label: string; isEnabled: boolean }>> {
  return tx
    .select({ id: unifiIntegrationKeys.id, label: unifiIntegrationKeys.label, isEnabled: unifiIntegrationKeys.isEnabled })
    .from(unifiIntegrationKeys)
    .where(and(eq(unifiIntegrationKeys.integrationId, integrationId), eq(unifiIntegrationKeys.partnerId, partnerId)))
    .orderBy(...stableOrder());
}

/** The label index compares lower(btrim(label)); so does this probe, in SQL, so the two never disagree. */
async function labelTaken(tx: DbExecutor, integrationId: string, label: string, exceptKeyId: string | null): Promise<boolean> {
  const conditions = [
    eq(unifiIntegrationKeys.integrationId, integrationId),
    sql`lower(btrim(${unifiIntegrationKeys.label})) = lower(btrim(${label}))`,
  ];
  if (exceptKeyId) conditions.push(ne(unifiIntegrationKeys.id, exceptKeyId));
  const rows = await tx.select({ id: unifiIntegrationKeys.id }).from(unifiIntegrationKeys).where(and(...conditions)).limit(1);
  return rows.length > 0;
}

/**
 * Keeps `unifi_integrations.api_key_encrypted` equal to the connection's FIRST
 * key (created_at, id) until W4 drops the column. Two readers still depend on
 * it during a deploy or a rollback (plan D12): pre-W1 code syncs from it, and
 * W1/W2 code ADOPTS it into a connection's only key row when the two differ.
 * Without this, replacing the sole key, or deleting down to one key, would let
 * a W1/W2 worker overwrite the surviving key with a stale or deleted secret.
 * Both columns use the same AAD, so the ciphertext is copied, never re-sealed.
 */
async function mirrorFirstKeyToLegacyColumn(tx: DbExecutor, integrationId: string, partnerId: string): Promise<void> {
  const [first] = await tx
    .select({ apiKeyEncrypted: unifiIntegrationKeys.apiKeyEncrypted })
    .from(unifiIntegrationKeys)
    .where(and(eq(unifiIntegrationKeys.integrationId, integrationId), eq(unifiIntegrationKeys.partnerId, partnerId)))
    .orderBy(...stableOrder())
    .limit(1);
  if (!first) return;
  await tx
    .update(unifiIntegrations)
    .set({ apiKeyEncrypted: first.apiKeyEncrypted })
    .where(and(eq(unifiIntegrations.id, integrationId), eq(unifiIntegrations.partnerId, partnerId)));
}

export async function addKey(
  db: DbExecutor,
  a: { integrationId: string; partnerId: string; label: string; apiKey: string; seenHostIds: string[]; createdBy: string | null },
): Promise<UnifiKeySummary> {
  const label = normalizeLabel(a.label);
  const apiKeyEncrypted = sealUnifiKey(a.apiKey);
  return mapLabelConflict(() => db.transaction(async (tx) => {
    await lockCloudIntegration(tx, a.integrationId, a.partnerId);
    const existing = await lockedKeyRows(tx, a.integrationId, a.partnerId);
    if (existing.length >= UNIFI_MAX_KEYS) throw new UnifiKeyError('UNIFI_KEY_LIMIT');
    if (await labelTaken(tx, a.integrationId, label, null)) throw new UnifiKeyError('UNIFI_KEY_LABEL_TAKEN');
    const [row] = await tx
      .insert(unifiIntegrationKeys)
      .values({
        integrationId: a.integrationId,
        partnerId: a.partnerId,
        label,
        apiKeyEncrypted,
        keyLast4: unifiKeyLast4(a.apiKey),
        isEnabled: true,
        status: 'pending',
        // D5: bounds what this key may reach if its first sync fails.
        lastSeenHostIds: a.seenHostIds,
        createdBy: a.createdBy,
      })
      .returning(summaryColumns());
    if (!row) throw new Error('addKey returned no unifi_integration_keys row');
    return toSummary(row);
  }));
}

export async function updateKey(
  db: DbExecutor,
  a: { integrationId: string; partnerId: string; keyId: string; label?: string; isEnabled?: boolean; apiKey?: string; seenHostIds?: string[] },
): Promise<UnifiKeySummary> {
  const label = a.label === undefined ? undefined : normalizeLabel(a.label);
  const replacement = a.apiKey === undefined ? undefined : { sealed: sealUnifiKey(a.apiKey), last4: unifiKeyLast4(a.apiKey) };
  return mapLabelConflict(() => db.transaction(async (tx) => {
    await lockCloudIntegration(tx, a.integrationId, a.partnerId);
    const rows = await lockedKeyRows(tx, a.integrationId, a.partnerId);
    const target = rows.find((r) => r.id === a.keyId);
    if (!target) throw new UnifiKeyError('UNIFI_KEY_NOT_FOUND');
    if (a.isEnabled === false && target.isEnabled && rows.filter((r) => r.isEnabled).length <= 1) {
      throw new UnifiKeyError('UNIFI_LAST_ENABLED_KEY');
    }
    if (label !== undefined && await labelTaken(tx, a.integrationId, label, a.keyId)) {
      throw new UnifiKeyError('UNIFI_KEY_LABEL_TAKEN');
    }
    const set: PgUpdateSetSource<typeof unifiIntegrationKeys> = { updatedAt: new Date() };
    if (label !== undefined) set.label = label;
    if (a.isEnabled !== undefined) set.isEnabled = a.isEnabled;
    if (replacement) {
      // A new secret starts over: no verdict from the old key carries across.
      // last_sync_at = now fences off runs already in flight with the old
      // secret: recordKeyResults writes only when last_sync_at < run start.
      set.lastSyncAt = new Date();
      set.apiKeyEncrypted = replacement.sealed;
      set.keyLast4 = replacement.last4;
      set.status = 'pending';
      set.lastSyncStatus = null;
      set.lastSyncError = null;
      set.lastSeenHostIds = a.seenHostIds ?? null;
    }
    const [row] = await tx
      .update(unifiIntegrationKeys)
      .set(set)
      .where(and(
        eq(unifiIntegrationKeys.id, a.keyId),
        eq(unifiIntegrationKeys.integrationId, a.integrationId),
        eq(unifiIntegrationKeys.partnerId, a.partnerId),
      ))
      .returning(summaryColumns());
    if (!row) throw new UnifiKeyError('UNIFI_KEY_NOT_FOUND');
    if (replacement) await mirrorFirstKeyToLegacyColumn(tx, a.integrationId, a.partnerId);
    return toSummary(row);
  }));
}

/** Removes a key. `false` when it is already gone (the route answers success: the end state holds). */
export async function deleteKey(db: DbExecutor, a: { integrationId: string; partnerId: string; keyId: string }): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockCloudIntegration(tx, a.integrationId, a.partnerId);
    const rows = await lockedKeyRows(tx, a.integrationId, a.partnerId);
    const target = rows.find((r) => r.id === a.keyId);
    if (!target) return false;
    // D11: never the last key, and never the last ENABLED key (disabled ones do not sync).
    const enabled = rows.filter((r) => r.isEnabled).length;
    if (rows.length <= 1 || (target.isEnabled && enabled <= 1)) throw new UnifiKeyError('UNIFI_LAST_ENABLED_KEY');
    const deleted = await tx
      .delete(unifiIntegrationKeys)
      .where(and(
        eq(unifiIntegrationKeys.id, a.keyId),
        eq(unifiIntegrationKeys.integrationId, a.integrationId),
        eq(unifiIntegrationKeys.partnerId, a.partnerId),
      ))
      .returning({ id: unifiIntegrationKeys.id });
    if (deleted.length === 0) return false;
    await mirrorFirstKeyToLegacyColumn(tx, a.integrationId, a.partnerId);
    return true;
  });
}

/**
 * One key of an active cloud connection by id, decrypted, enabled or not (for
 * the per-key test). null when no such key exists on the connection. Like
 * `getSyncKeys`, the result is for building a UniFi client only.
 */
export async function getKeyForTest(
  db: DbExecutor,
  integrationId: string,
  partnerId: string,
  keyId: string,
): Promise<{ baseUrl: string; key: UnifiSyncKey } | null> {
  const [integration] = await db
    .select({ baseUrl: unifiIntegrations.baseUrl, connectionType: unifiIntegrations.connectionType })
    .from(unifiIntegrations)
    .where(and(
      eq(unifiIntegrations.id, integrationId),
      eq(unifiIntegrations.partnerId, partnerId),
      eq(unifiIntegrations.isActive, true),
    ))
    .limit(1);
  if (!integration || integration.connectionType !== 'cloud') return null;
  const [row] = (await db
    .select({
      id: unifiIntegrationKeys.id,
      label: unifiIntegrationKeys.label,
      apiKeyEncrypted: unifiIntegrationKeys.apiKeyEncrypted,
      keyLast4: unifiIntegrationKeys.keyLast4,
      isEnabled: unifiIntegrationKeys.isEnabled,
      lastSeenHostIds: unifiIntegrationKeys.lastSeenHostIds,
    })
    .from(unifiIntegrationKeys)
    .where(and(
      eq(unifiIntegrationKeys.id, keyId),
      eq(unifiIntegrationKeys.integrationId, integrationId),
      eq(unifiIntegrationKeys.partnerId, partnerId),
    ))
    .limit(1)) as KeyRow[];
  return row ? { baseUrl: integration.baseUrl, key: toSyncKey(row) } : null;
}
