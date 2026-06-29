import { and, eq } from 'drizzle-orm';
import { unifiIntegrations } from '../../db/schema';
import { encryptSecret, decryptForColumn } from '../secretCrypto';

export type DbExecutor = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
};

// Closed status domain for a partner's UniFi connection (compile-time typo guard).
export type IntegrationStatus = 'pending' | 'connected' | 'reauth_required' | 'error';

export interface UnifiConnection {
  id: string;
  partnerId: string;
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

export async function getDecryptedApiKey(db: DbExecutor, partnerId: string): Promise<string | null> {
  const row = await selectActiveRow(db, partnerId);
  if (!row) return null;
  return decryptForColumn('unifi_integrations', 'api_key_encrypted', row.apiKeyEncrypted);
}

// Read baseUrl AND the decrypted key from the SAME active row, keyed by
// (id, partnerId). Keeping both off one row avoids the subtle split where the key
// came from the (partnerId, isActive) row and baseUrl from the (id, partnerId) row.
export async function getSyncCredentials(
  db: DbExecutor,
  integrationId: string,
  partnerId: string,
): Promise<{ baseUrl: string; apiKey: string } | null> {
  const rows = await db
    .select()
    .from(unifiIntegrations)
    .where(
      and(
        eq(unifiIntegrations.id, integrationId),
        eq(unifiIntegrations.partnerId, partnerId),
        eq(unifiIntegrations.isActive, true),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const apiKey = decryptForColumn('unifi_integrations', 'api_key_encrypted', row.apiKeyEncrypted);
  if (!apiKey) return null;
  return { baseUrl: row.baseUrl, apiKey };
}

export async function upsertConnection(
  db: DbExecutor,
  partnerId: string,
  fields: { baseUrl: string; apiKey: string; accountLabel?: string | null; createdBy?: string | null },
): Promise<UnifiConnection> {
  const apiKeyEncrypted = encryptSecret(fields.apiKey, { aad: 'unifi_integrations.api_key_encrypted' });
  const inserted = await db
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
        baseUrl: fields.baseUrl,
        apiKeyEncrypted,
        accountLabel: fields.accountLabel ?? null,
        status: 'connected',
        lastSyncError: null,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!inserted[0]) throw new Error('upsertConnection returned no unifi_integrations row');
  return toConnection(inserted[0]);
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
