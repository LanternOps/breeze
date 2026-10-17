/**
 * Recorded key roots of origin snapshots (#7081): the snapshots an
 * incremental's external refs point into. An origin's root is read from its
 * live snapshot row or, once retired, from its retirement row — never from
 * `backup_snapshot_origins.origin_storage_prefix` or helper-reported
 * metadata. Runs in the caller's DB access context.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { backupSnapshotRetirements, backupSnapshots } from '../db/schema';
import { snapshotKeyRootOf, type SnapshotKeyRoot } from './backupKeyLayout';

/** A row's raw (key_layout, key_prefix) pair; validate it with snapshotKeyRootOf. */
export type KeyRootPair = { keyLayout: string; keyPrefix: string | null };

/**
 * The recorded root pair of each origin snapshot id that still has a live or
 * retirement row in this organization and storage identity. An id with
 * neither is absent from the map.
 */
export async function loadOriginKeyRootRows(input: {
  orgId: string;
  storageIdentity: string;
  originSnapshotIds: readonly string[];
}): Promise<Map<string, KeyRootPair>> {
  const ids = [...new Set(input.originSnapshotIds)];
  const roots = new Map<string, KeyRootPair>();
  if (ids.length === 0) return roots;
  const live = await db
    .select({ snapshotId: backupSnapshots.snapshotId, keyLayout: backupSnapshots.keyLayout, keyPrefix: backupSnapshots.keyPrefix })
    .from(backupSnapshots)
    .where(and(
      eq(backupSnapshots.orgId, input.orgId),
      eq(backupSnapshots.storageIdentity, input.storageIdentity),
      inArray(backupSnapshots.snapshotId, ids),
    ));
  for (const row of live) roots.set(row.snapshotId, { keyLayout: row.keyLayout, keyPrefix: row.keyPrefix });
  const missing = ids.filter((id) => !roots.has(id));
  if (missing.length === 0) return roots;
  const retired = await db
    .select({
      snapshotId: backupSnapshotRetirements.snapshotId,
      keyLayout: backupSnapshotRetirements.keyLayout,
      keyPrefix: backupSnapshotRetirements.keyPrefix,
    })
    .from(backupSnapshotRetirements)
    .where(and(
      eq(backupSnapshotRetirements.orgId, input.orgId),
      eq(backupSnapshotRetirements.storageIdentity, input.storageIdentity),
      inArray(backupSnapshotRetirements.snapshotId, missing),
    ));
  for (const row of retired) roots.set(row.snapshotId, { keyLayout: row.keyLayout, keyPrefix: row.keyPrefix });
  return roots;
}

/** As loadOriginKeyRootRows, keeping only roots this server can read (an unreadable one is omitted, so its refs fail closed). */
export async function loadOriginKeyRoots(input: {
  orgId: string;
  storageIdentity: string;
  originSnapshotIds: readonly string[];
}): Promise<Map<string, SnapshotKeyRoot>> {
  const roots = new Map<string, SnapshotKeyRoot>();
  for (const [id, pair] of await loadOriginKeyRootRows(input)) {
    const root = snapshotKeyRootOf(pair);
    if (root) roots.set(id, root);
  }
  return roots;
}
