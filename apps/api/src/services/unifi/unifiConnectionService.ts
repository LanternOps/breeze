import { and, eq } from 'drizzle-orm';
import { unifiIntegrationKeys, unifiIntegrations } from '../../db/schema';
import { sealUnifiKey, unifiKeyLast4 } from './unifiKeyService';

export type DbExecutor = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  transaction: <T>(fn: (tx: DbExecutor) => Promise<T>) => Promise<T>;
};

// Closed status domain for a partner's UniFi connection (compile-time typo guard).
export type IntegrationStatus = 'pending' | 'connected' | 'reauth_required' | 'error';

export interface UnifiConnection {
  id: string;
  partnerId: string;
  connectionType: 'cloud' | 'self_hosted';
  baseUrl: string;
  accountLabel: string | null;
  isActive: boolean;
  status: IntegrationStatus;
  lastSyncAt: Date | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
}

function toConnection(row: any): UnifiConnection {
  return {
    id: row.id,
    partnerId: row.partnerId,
    connectionType: row.connectionType === 'self_hosted' ? 'self_hosted' : 'cloud',
    baseUrl: row.baseUrl,
    accountLabel: row.accountLabel ?? null,
    isActive: row.isActive,
    status: row.status,
    lastSyncAt: row.lastSyncAt ?? null,
    lastSyncStatus: row.lastSyncStatus ?? null,
    lastSyncError: row.lastSyncError ?? null,
  };
}

async function selectActiveRow(db: DbExecutor, partnerId: string): Promise<any | null> {
  const rows = await db
    .select()
    .from(unifiIntegrations)
    .where(and(eq(unifiIntegrations.partnerId, partnerId), eq(unifiIntegrations.isActive, true)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getConnection(db: DbExecutor, partnerId: string): Promise<UnifiConnection | null> {
  const row = await selectActiveRow(db, partnerId);
  return row ? toConnection(row) : null;
}

/**
 * The connection already holds more than one API key (#11808). `/connect`
 * replaces the single key of a connection; with several keys it would have to
 * guess which one, and changing `baseUrl` would send every retained key to a
 * new destination (plan D10). The route answers 409 UNIFI_MULTI_KEY.
 */
export class UnifiMultiKeyError extends Error {
  readonly code = 'UNIFI_MULTI_KEY' as const;
  constructor() {
    super('This connection has several API keys. Manage them from the key list.');
    this.name = 'UnifiMultiKeyError';
  }
}

/** Key labels are 1-100 characters after trimming (DB CHECK); /connect accepts 200. */
function firstKeyLabel(accountLabel: string | null | undefined): string {
  const trimmed = (accountLabel ?? '').trim();
  if (!trimmed) return 'Global';
  return Array.from(trimmed).slice(0, 100).join('').trim() || 'Global';
}

export async function upsertConnection(
  db: DbExecutor,
  partnerId: string,
  fields: { baseUrl: string; apiKey: string; accountLabel?: string | null; createdBy?: string | null },
): Promise<UnifiConnection> {
  return db.transaction(async (tx) => {
    // Refuse a multi-key connection BEFORE any write, so a 409 leaves baseUrl
    // and the stored keys untouched. The row lock serializes concurrent
    // reconnects of the same connection (and W3's key CRUD, which takes it too).
    const [existing] = await tx
      .select({ id: unifiIntegrations.id })
      .from(unifiIntegrations)
      .where(and(eq(unifiIntegrations.partnerId, partnerId), eq(unifiIntegrations.isActive, true)))
      .limit(1)
      .for('update');
    if (existing) {
      const keys = await tx
        .select({ id: unifiIntegrationKeys.id })
        .from(unifiIntegrationKeys)
        .where(and(eq(unifiIntegrationKeys.integrationId, existing.id), eq(unifiIntegrationKeys.partnerId, partnerId)));
      if (keys.length > 1) throw new UnifiMultiKeyError();
    }

    // Same AAD the legacy column has always used: columnAad(UNIFI_KEY_COLUMN_SPEC)
    // is 'unifi_integrations.api_key_encrypted', so one ciphertext serves both.
    const apiKeyEncrypted = sealUnifiKey(fields.apiKey);
    const keyLast4 = unifiKeyLast4(fields.apiKey);
    // The legacy column is still written (until W4), so a rollback to pre-W1
    // code reads the current key (plan D12).
    const inserted = await tx
      .insert(unifiIntegrations)
      .values({
        partnerId,
        baseUrl: fields.baseUrl,
        apiKeyEncrypted,
        accountLabel: fields.accountLabel ?? null,
        createdBy: fields.createdBy ?? null,
        isActive: true,
        status: 'connected',
      })
      .onConflictDoUpdate({
        target: unifiIntegrations.partnerId,
        targetWhere: eq(unifiIntegrations.isActive, true),
        set: {
          connectionType: 'cloud',
          baseUrl: fields.baseUrl,
          apiKeyEncrypted,
          accountLabel: fields.accountLabel ?? null,
          status: 'connected',
          lastSyncError: null,
          updatedAt: new Date(),
        },
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('upsertConnection returned no unifi_integrations row');

    const keys = await tx
      .select({ id: unifiIntegrationKeys.id })
      .from(unifiIntegrationKeys)
      .where(and(eq(unifiIntegrationKeys.integrationId, row.id), eq(unifiIntegrationKeys.partnerId, partnerId)));
    // Unreachable while the row lock above is held; kept so a second key can
    // never be overwritten by a guess.
    if (keys.length > 1) throw new UnifiMultiKeyError();

    if (keys.length === 0) {
      await tx.insert(unifiIntegrationKeys).values({
        integrationId: row.id,
        partnerId,
        label: firstKeyLabel(fields.accountLabel),
        apiKeyEncrypted,
        keyLast4,
        status: 'connected',
        createdBy: fields.createdBy ?? null,
      });
    } else {
      await tx
        .update(unifiIntegrationKeys)
        .set({
          apiKeyEncrypted,
          keyLast4,
          status: 'connected',
          lastSyncError: null,
          lastSeenHostIds: null,
          updatedAt: new Date(),
        })
        .where(and(
          eq(unifiIntegrationKeys.id, keys[0]!.id),
          eq(unifiIntegrationKeys.integrationId, row.id),
          eq(unifiIntegrationKeys.partnerId, partnerId),
        ));
    }
    return toConnection(row);
  });
}

export async function createSelfHostedIntegration(
  db: DbExecutor,
  partnerId: string,
  fields: { accountLabel?: string | null; createdBy?: string | null },
): Promise<{ id: string; connectionType: 'self_hosted' }> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(unifiIntegrations)
      .values({
        partnerId,
        connectionType: 'self_hosted',
        apiKeyEncrypted: null,
        accountLabel: fields.accountLabel ?? null,
        createdBy: fields.createdBy ?? null,
        status: 'connected',
        isActive: true,
      })
      .onConflictDoUpdate({
        target: unifiIntegrations.partnerId,
        targetWhere: eq(unifiIntegrations.isActive, true),
        set: {
          connectionType: 'self_hosted',
          accountLabel: fields.accountLabel ?? null,
          status: 'connected',
          updatedAt: new Date(),
        },
      })
      .returning({ id: unifiIntegrations.id, connectionType: unifiIntegrations.connectionType });
    if (!rows[0]) throw new Error('createSelfHostedIntegration returned no row');
    // Only cloud connections hold Site Manager keys (plan D6). A cloud connection
    // switched to self-hosted drops its keys in the same transaction.
    await tx
      .delete(unifiIntegrationKeys)
      .where(and(eq(unifiIntegrationKeys.integrationId, rows[0].id), eq(unifiIntegrationKeys.partnerId, partnerId)));
    return { id: rows[0].id, connectionType: 'self_hosted' as const };
  });
}

export async function markStatus(
  db: DbExecutor,
  connectionId: string,
  partnerId: string,
  status: IntegrationStatus,
  lastError?: string | null,
): Promise<void> {
  const updated = await db
    .update(unifiIntegrations)
    .set({ status, lastSyncError: lastError ?? null, updatedAt: new Date() })
    .where(and(eq(unifiIntegrations.id, connectionId), eq(unifiIntegrations.partnerId, partnerId)))
    .returning({ id: unifiIntegrations.id });
  if (updated.length === 0) {
    throw new Error(`markStatus matched no unifi_integrations row (id=${connectionId})`);
  }
}

export async function markSynced(
  db: DbExecutor,
  connectionId: string,
  partnerId: string,
  status: string,
  error?: string | null,
): Promise<void> {
  const updated = await db
    .update(unifiIntegrations)
    .set({ lastSyncAt: new Date(), lastSyncStatus: status, lastSyncError: error ?? null, updatedAt: new Date() })
    .where(and(eq(unifiIntegrations.id, connectionId), eq(unifiIntegrations.partnerId, partnerId)))
    .returning({ id: unifiIntegrations.id });
  if (updated.length === 0) {
    throw new Error(`markSynced matched no unifi_integrations row (id=${connectionId})`);
  }
}

export async function deleteConnection(db: DbExecutor, partnerId: string): Promise<boolean> {
  const deleted = await db
    .delete(unifiIntegrations)
    .where(and(eq(unifiIntegrations.partnerId, partnerId), eq(unifiIntegrations.isActive, true)))
    .returning({ id: unifiIntegrations.id });
  // A 0-row delete is the routine idempotent case (no active connection for this
  // partner) — return false, never throw. Disconnecting an already-disconnected
  // partner must not 500.
  return deleted.length > 0;
}
