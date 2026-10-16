/**
 * The key roots recorded on one physical storage identity (#7081), for storage
 * GC (jobs/backupRetention.ts). GC lists, marks and deletes one root at a time
 * and never across roots; this module tells it which roots exist and which
 * root every snapshot id on the identity is recorded under.
 *
 * A root exists on an identity only when a row records it: a snapshot (by
 * identity, or a NULL-identity row of one of the identity's configurations),
 * a snapshot id reservation, an unswept retirement, or an erasure-fence
 * target. The legacy root is always present. The destinations' configured
 * prefixes are deliberately NOT a source: a prefixed root is only ever written
 * through a brokered write session, whose reservation records it before any
 * object is written, so a configured prefix with no row names a location
 * Breeze has never written to — and listing it would put objects Breeze does
 * not own in front of the orphan sweep.
 *
 * Rows are read system-scoped: what is protected must not depend on any one
 * organization's visibility.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { backupSnapshotIdReservations, backupSnapshotRetirements, backupSnapshots } from '../db/schema';
import { backupErasureTargets } from '../db/schema/backupErasureFences';
import { keyRootId, LEGACY_FLAT_ROOT, sameKeyRoot, snapshotKeyRootOf, type SnapshotKeyRoot } from './backupKeyLayout';

export type KeyRootSource = 'snapshot' | 'reservation' | 'retirement' | 'erasure_target';

export type InvalidKeyRoot = {
  source: KeyRootSource;
  snapshotId: string | null;
  keyLayout: unknown;
  keyPrefix: unknown;
};

export type IdentityKeyRoots = {
  /** Every root recorded on the identity, legacy always included, sorted by keyRootId. */
  roots: SnapshotKeyRoot[];
  /** Rows whose recorded root this server cannot read (I5): GC skips the identity. */
  invalid: InvalidKeyRoot[];
  /** keyRootId of every readable root each snapshot id is recorded under. */
  rootIdsBySnapshotId: Map<string, Set<string>>;
  /**
   * keyRootId -> the organizations with a snapshot, reservation or unswept
   * retirement recorded under that root on the identity. GC runs an org's
   * unit under a root only when the org has rows there or writes there now.
   */
  orgIdsByRootId: Map<string, Set<string>>;
};

type RootRow = { snapshotId: string | null; keyLayout: unknown; keyPrefix: unknown; orgId?: string | null };

export async function listIdentityKeyRoots(input: {
  storageIdentity: string;
  /** Configurations of the identity whose NULL-identity snapshot rows also count. */
  nullIdentityConfigIds?: readonly string[];
}): Promise<IdentityKeyRoots> {
  const nullIdentityConfigIds = [...new Set(input.nullIdentityConfigIds ?? [])];
  const sources = await withSystemDbAccessContext(async () => {
    const snapshotColumns = {
      snapshotId: backupSnapshots.snapshotId,
      keyLayout: backupSnapshots.keyLayout,
      keyPrefix: backupSnapshots.keyPrefix,
      orgId: backupSnapshots.orgId,
    };
    const snapshots: RootRow[] = await db
      .select(snapshotColumns)
      .from(backupSnapshots)
      .where(eq(backupSnapshots.storageIdentity, input.storageIdentity));
    const nullIdentitySnapshots: RootRow[] = nullIdentityConfigIds.length === 0 ? [] : await db
      .select(snapshotColumns)
      .from(backupSnapshots)
      .where(and(isNull(backupSnapshots.storageIdentity), inArray(backupSnapshots.configId, nullIdentityConfigIds)));
    const reservations: RootRow[] = await db
      .select({
        snapshotId: backupSnapshotIdReservations.snapshotId,
        keyLayout: backupSnapshotIdReservations.keyLayout,
        keyPrefix: backupSnapshotIdReservations.keyPrefix,
        orgId: backupSnapshotIdReservations.orgId,
      })
      .from(backupSnapshotIdReservations)
      .where(eq(backupSnapshotIdReservations.storageIdentity, input.storageIdentity));
    const retirements: RootRow[] = await db
      .select({
        snapshotId: backupSnapshotRetirements.snapshotId,
        keyLayout: backupSnapshotRetirements.keyLayout,
        keyPrefix: backupSnapshotRetirements.keyPrefix,
        orgId: backupSnapshotRetirements.orgId,
      })
      .from(backupSnapshotRetirements)
      .where(and(
        eq(backupSnapshotRetirements.storageIdentity, input.storageIdentity),
        isNull(backupSnapshotRetirements.sweptAt),
      ));
    const erasureTargets: RootRow[] = await db
      .select({
        snapshotId: backupErasureTargets.snapshotId,
        keyLayout: backupErasureTargets.keyLayout,
        keyPrefix: backupErasureTargets.keyPrefix,
      })
      .from(backupErasureTargets)
      .where(and(
        sql`${backupErasureTargets.kind} = 'snapshot_prefix'`,
        eq(backupErasureTargets.storageIdentity, input.storageIdentity),
      ));
    return [
      ['snapshot', [...snapshots, ...nullIdentitySnapshots]],
      ['reservation', reservations],
      ['retirement', retirements],
      ['erasure_target', erasureTargets],
    ] as const satisfies ReadonlyArray<readonly [KeyRootSource, RootRow[]]>;
  });

  const rootsById = new Map<string, SnapshotKeyRoot>([[keyRootId(LEGACY_FLAT_ROOT), LEGACY_FLAT_ROOT]]);
  const invalid: InvalidKeyRoot[] = [];
  const rootIdsBySnapshotId = new Map<string, Set<string>>();
  const orgIdsByRootId = new Map<string, Set<string>>();
  for (const [source, rows] of sources) {
    for (const row of rows) {
      const root = source === 'erasure_target'
        ? erasureTargetKeyRoot(row)
        : snapshotKeyRootOf({ keyLayout: row.keyLayout, keyPrefix: row.keyPrefix });
      if (!root) {
        invalid.push({ source, snapshotId: row.snapshotId, keyLayout: row.keyLayout, keyPrefix: row.keyPrefix });
        continue;
      }
      const id = keyRootId(root);
      if (!rootsById.has(id)) rootsById.set(id, root);
      // Erasure targets name an erased org, which has no unit to run.
      if (row.orgId) {
        let orgs = orgIdsByRootId.get(id);
        if (!orgs) {
          orgs = new Set();
          orgIdsByRootId.set(id, orgs);
        }
        orgs.add(row.orgId);
      }
      if (!row.snapshotId) continue;
      let ids = rootIdsBySnapshotId.get(row.snapshotId);
      if (!ids) {
        ids = new Set();
        rootIdsBySnapshotId.set(row.snapshotId, ids);
      }
      ids.add(id);
    }
  }
  const roots = [...rootsById.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, root]) => root);
  return { roots, invalid, rootIdsBySnapshotId, orgIdsByRootId };
}

/**
 * Root of an erasure-fence target. A target captured before targets carried
 * roots has none recorded: every snapshot was legacy_flat then, and every
 * capture since records the source row's root, so NULL reads as legacy.
 */
export function erasureTargetKeyRoot(row: { keyLayout: unknown; keyPrefix: unknown }): SnapshotKeyRoot | null {
  if (row.keyLayout === null || row.keyLayout === undefined) {
    return row.keyPrefix === null || row.keyPrefix === undefined ? LEGACY_FLAT_ROOT : null;
  }
  return snapshotKeyRootOf(row);
}

/**
 * Whether GC marking a manifest under `root` may follow an external ref into
 * `originSnapshotId` (I4: chains never span roots). The origin must be
 * recorded under exactly this root; an origin with no recorded root is
 * allowed only under the legacy root, where row-less legacy bases have always
 * existed (the same rule readers apply, originKeyRootAllows).
 */
export function keyRootsIndexAllowsOrigin(
  rootIdsBySnapshotId: ReadonlyMap<string, ReadonlySet<string>>,
  root: SnapshotKeyRoot,
  originSnapshotId: string,
): boolean {
  const recorded = rootIdsBySnapshotId.get(originSnapshotId);
  if (!recorded || recorded.size === 0) return sameKeyRoot(root, LEGACY_FLAT_ROOT);
  return recorded.size === 1 && recorded.has(keyRootId(root));
}
