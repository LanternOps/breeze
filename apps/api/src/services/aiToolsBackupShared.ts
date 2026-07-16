/**
 * AI Backup/DR tools — shared site-aware snapshot loader.
 *
 * Restore/DR tools authorize their TARGET device against the caller's site
 * scope (`deviceSiteDenied`), but historically loaded the SOURCE snapshot by
 * org only. Because Postgres RLS enforces the org axis but NOT the site axis,
 * a site-restricted caller who legitimately owns a Site-A target could load a
 * Site-B snapshot (shared provider namespace) and restore it onto their target.
 *
 * `loadSnapshotWithSiteAccess` closes that gap: it loads a snapshot under the
 * caller's org scope AND resolves the snapshot's SOURCE device
 * (`backupSnapshots.deviceId` → `devices.siteId`), then applies the SAME
 * `deviceSiteDenied` gate used for restore targets. A site-restricted caller
 * therefore cannot load a snapshot whose source device lives in a site they
 * cannot reach — so both the source snapshot and the target device must be
 * within the caller's site scope for a restore to proceed.
 *
 * No-op for unrestricted callers (`auth.canAccessSite` undefined): identical
 * behaviour, no extra device query, no regression.
 */

import { and, eq, SQL } from 'drizzle-orm';
import { db } from '../db';
import { backupSnapshots, devices } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { deviceSiteDenied } from './aiToolsSiteScope';

export type SiteScopedSnapshot = {
  id: string;
  orgId: string;
  /** Provider-side snapshot identifier (backup_snapshots.snapshot_id). */
  providerSnapshotId: string;
  /** Source device the snapshot was captured from. */
  deviceId: string;
  /** backup_configs.id this snapshot was written under (nullable on legacy rows). */
  configId: string | null;
  metadata: unknown;
  size: number | null;
  hardwareProfile: unknown;
};

const SNAPSHOT_DENIED = 'Snapshot not found or access denied';

/**
 * Load a backup snapshot by id under the caller's org + site scope.
 *
 * Returns `{ error }` (a single collapsed message so callers cannot distinguish
 * "not found" from "denied") when the snapshot is missing, out of org scope, or
 * — for a site-restricted caller — its source device is in an inaccessible
 * site. Fails closed: a snapshot whose source device is unknown/removed is
 * denied for a restricted caller. Returns `{ snapshot }` otherwise.
 */
export async function loadSnapshotWithSiteAccess(
  auth: AuthContext,
  snapshotId: string,
): Promise<{ error: string } | { snapshot: SiteScopedSnapshot }> {
  const conditions: SQL[] = [eq(backupSnapshots.id, snapshotId)];
  const oc = auth.orgCondition(backupSnapshots.orgId);
  if (oc) conditions.push(oc);

  const [row] = await db
    .select({
      id: backupSnapshots.id,
      orgId: backupSnapshots.orgId,
      providerSnapshotId: backupSnapshots.snapshotId,
      deviceId: backupSnapshots.deviceId,
      configId: backupSnapshots.configId,
      metadata: backupSnapshots.metadata,
      size: backupSnapshots.size,
      hardwareProfile: backupSnapshots.hardwareProfile,
    })
    .from(backupSnapshots)
    .where(and(...conditions))
    .limit(1);

  if (!row) return { error: SNAPSHOT_DENIED };

  // Site axis (app-layer only; RLS does NOT enforce it). Resolve the snapshot's
  // SOURCE device site and gate it exactly like a restore target. Gated on
  // `allowedSiteIds` (the restriction marker) so unrestricted callers incur no
  // extra query — `canAccessSite` is always present, allow-all when unrestricted.
  if (auth.allowedSiteIds && auth.canAccessSite) {
    const [sourceDevice] = row.deviceId
      ? await db
          .select({ siteId: devices.siteId })
          .from(devices)
          .where(eq(devices.id, row.deviceId))
          .limit(1)
      : [];
    // Unknown/removed source device → siteId undefined → denied (fail closed).
    if (deviceSiteDenied(auth, sourceDevice?.siteId ?? null)) {
      return { error: SNAPSHOT_DENIED };
    }
  }

  return { snapshot: row };
}
