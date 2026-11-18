import { inArray } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { backupProviderConnections } from '../db/schema';

/**
 * Connections are partner-scoped and invisible to portal org RLS. Callers must
 * supply only connection IDs obtained from inventory rows readable in their
 * current DB context. The elevated lookup exposes only freshness, never config
 * or credentials, and cannot discover additional connections.
 */
export async function loadBackupConnectionFreshness(connectionIds: string[]) {
  const ids = [...new Set(connectionIds)];
  if (ids.length === 0) return new Map<string, {
    isActive: boolean; lastSyncAt: Date | null; syncIntervalMinutes: number;
  }>();
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.select({
    id: backupProviderConnections.id,
    isActive: backupProviderConnections.isActive,
    lastSyncAt: backupProviderConnections.lastSyncAt,
    syncIntervalMinutes: backupProviderConnections.syncIntervalMinutes,
  }).from(backupProviderConnections).where(inArray(backupProviderConnections.id, ids)), 'backup-connection-freshness'));
  return new Map(rows.map(({ id, ...freshness }) => [id, freshness]));
}
