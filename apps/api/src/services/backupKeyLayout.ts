import { normalizeBackupDestinationPrefix } from '@breeze/shared/validators';
import { classifyBackupObjectKey } from './backupObjectKey';

/**
 * Object-key layouts a backup snapshot can be written with
 * (`backup_snapshots.key_layout`), and the mapping between a snapshot's
 * LOGICAL keys and the PHYSICAL keys the API reads and writes in a bucket.
 *
 * Logical keys (`snapshots/<snapshotId>/...`, services/backupObjectKey.ts) are
 * what the helper writes, what manifests and external refs embed, and what the
 * attestation statement signs. They never change. The physical key is derived
 * from the snapshot's recorded key root:
 *
 * | layout          | key_prefix | physical key of `snapshots/<id>/<rest>` |
 * |-----------------|------------|-----------------------------------------|
 * | `legacy_flat`   | NULL       | `snapshots/<id>/<rest>` (identity)      |
 * | `prefixed_flat` | `P`        | `P/snapshots/<id>/<rest>`               |
 *
 * The recorded root `(key_layout, key_prefix)` is the only source of a physical
 * key (I1). The destination's `providerConfig.prefix` is read once, when a new
 * snapshot id is reserved (`keyRootForNewSnapshot`); reservation, snapshot and
 * retirement rows then carry the root and it never changes (DB triggers).
 * Physical keys are only ever composed through the helpers in this module.
 *
 * Root disjointness (I3): a valid prefix has no `snapshots` segment
 * (`normalizeBackupDestinationPrefix`), so `snapshots/` and every
 * `P/snapshots/` are pairwise disjoint and a listing of one root never contains
 * another root's objects.
 *
 * Readers refuse (fail closed, I5) a layout not listed in `BACKUP_KEY_LAYOUTS`,
 * a row whose `(key_layout, key_prefix)` pair is inconsistent, and a physical
 * key that does not map back under the expected root. Storage GC uses the
 * narrower `GC_SUPPORTED_KEY_LAYOUTS`: it skips a whole storage identity while
 * any of its snapshots has a layout outside that set, since a root-blind sweep
 * could otherwise treat that snapshot's objects as unreferenced.
 */
export const BACKUP_KEY_LAYOUTS = ['legacy_flat', 'prefixed_flat'] as const;

export type BackupKeyLayout = (typeof BACKUP_KEY_LAYOUTS)[number];

export type SnapshotKeyRoot =
  | { readonly layout: 'legacy_flat'; readonly prefix: null }
  | { readonly layout: 'prefixed_flat'; readonly prefix: string };

export const LEGACY_FLAT_ROOT: SnapshotKeyRoot = Object.freeze({ layout: 'legacy_flat', prefix: null } as const);

export function isSupportedKeyLayout(value: unknown): value is BackupKeyLayout {
  return typeof value === 'string' && (BACKUP_KEY_LAYOUTS as readonly string[]).includes(value);
}

/**
 * Layouts storage GC may sweep. GC lists, marks and deletes per key root
 * (jobs/backupRetention.ts), so every readable layout is sweepable; the set
 * stays separate from `BACKUP_KEY_LAYOUTS` so a layout readers learn first is
 * not swept until GC learns it too (a row in any other layout makes GC skip
 * its storage identity).
 */
export const GC_SUPPORTED_KEY_LAYOUTS = ['legacy_flat', 'prefixed_flat'] as const satisfies readonly BackupKeyLayout[];

export function isGcSupportedKeyLayout(value: unknown): boolean {
  return typeof value === 'string' && (GC_SUPPORTED_KEY_LAYOUTS as readonly string[]).includes(value);
}

/** Root of a snapshot / reservation / retirement row; null = refuse (I5). */
export function snapshotKeyRootOf(row: { keyLayout: unknown; keyPrefix: unknown }): SnapshotKeyRoot | null {
  if (row.keyLayout === 'legacy_flat') return row.keyPrefix == null ? LEGACY_FLAT_ROOT : null;
  if (row.keyLayout === 'prefixed_flat') {
    const n = normalizeBackupDestinationPrefix(row.keyPrefix);
    // The stored value must already be in normalized form; a value that only
    // passes after normalization was not written by this code.
    return n.ok && n.prefix !== null && n.prefix === row.keyPrefix
      ? { layout: 'prefixed_flat', prefix: n.prefix }
      : null;
  }
  return null;
}

/** Root a NEW reservation on this destination gets (mint only; I1). */
export function keyRootForNewSnapshot(
  provider: string,
  providerConfig: Record<string, unknown>,
): { ok: true; root: SnapshotKeyRoot } | { ok: false; reason: 'invalid_destination_prefix' } {
  if (provider !== 's3') return { ok: true, root: LEGACY_FLAT_ROOT };
  const n = normalizeBackupDestinationPrefix(providerConfig.prefix);
  if (!n.ok) return { ok: false, reason: 'invalid_destination_prefix' };
  return { ok: true, root: n.prefix === null ? LEGACY_FLAT_ROOT : { layout: 'prefixed_flat', prefix: n.prefix } };
}

export function physicalKeyFor(root: SnapshotKeyRoot, logicalKey: string): string {
  return root.layout === 'legacy_flat' ? logicalKey : `${root.prefix}/${logicalKey}`;
}

/** Inverse of physicalKeyFor; null when the key is not under this root. */
export function logicalKeyFrom(root: SnapshotKeyRoot, physicalKey: string): string | null {
  if (root.layout === 'legacy_flat') return physicalKey;
  const head = `${root.prefix}/`;
  return physicalKey.startsWith(head) ? physicalKey.slice(head.length) : null;
}

/** The `snapshots/` root GC / reconcile list for this root (always ends in '/'). */
export function physicalSnapshotRootPrefix(root: SnapshotKeyRoot): string {
  return physicalKeyFor(root, 'snapshots/');
}

/** Stable grouping key: 'legacy' | 'prefixed:<P>'. */
export function keyRootId(root: SnapshotKeyRoot): string {
  return root.layout === 'legacy_flat' ? 'legacy' : `prefixed:${root.prefix}`;
}

export function sameKeyRoot(a: SnapshotKeyRoot, b: SnapshotKeyRoot): boolean {
  return a.layout === b.layout && a.prefix === b.prefix;
}

/** S3 object keys are at most 1024 bytes of UTF-8. Checked on the COMPOSED physical key. */
export const PHYSICAL_KEY_MAX_BYTES = 1024;

export function physicalKeyFits(physicalKey: string): boolean {
  return Buffer.byteLength(physicalKey, 'utf8') <= PHYSICAL_KEY_MAX_BYTES;
}

/**
 * I6: the layout the helper's attestation statement describes. The helper only
 * ever sees logical keys, so every readable layout attests as `legacy_flat`.
 */
export function logicalKeyLayout(_layout: BackupKeyLayout): 'legacy_flat' {
  return 'legacy_flat';
}

/**
 * The `keyLayout` an attestation statement for a snapshot with this layout
 * carries: the logical layout for a readable one (I6), and the value itself
 * otherwise, compared verbatim as before (readers refuse such snapshots on
 * their layout separately).
 */
export function attestedKeyLayoutFor(layout: string): string {
  return isSupportedKeyLayout(layout) ? logicalKeyLayout(layout) : layout;
}

/**
 * Physical key for a logical key referenced by a snapshot (its own objects or
 * an external ref into an origin snapshot). External refs resolve through the
 * ORIGIN's recorded root, which must equal the referencing snapshot's own root
 * (I4: chains never span roots). Returns null — refuse — when the key is not
 * a snapshot object key, the origin root is unknown, or the roots differ.
 */
export function resolveSnapshotPhysicalKey(input: {
  ownRoot: SnapshotKeyRoot;
  ownSnapshotId: string;
  logicalKey: string;
  originRoots: ReadonlyMap<string, SnapshotKeyRoot>;
}): string | null {
  const scope = classifyBackupObjectKey(input.logicalKey, input.ownSnapshotId);
  if (!scope) return null;
  if (scope.kind === 'own') return physicalKeyFor(input.ownRoot, input.logicalKey);
  const originRoot = input.originRoots.get(scope.originSnapshotId);
  if (!originRoot || !sameKeyRoot(originRoot, input.ownRoot)) return null;
  return physicalKeyFor(originRoot, input.logicalKey);
}

/**
 * Whether an external reference into an origin snapshot may be served under
 * the referencing snapshot's own root (I4). `originRow` is the origin's live
 * snapshot row or, once retired, its retirement row; `undefined` when neither
 * is left. A recorded origin root must be readable and equal the own root.
 * With no row left, a legacy chain resolves exactly as it always has (the
 * origin was verified when the file index was built, and no other root
 * existed before roots were recorded); a prefixed chain is refused (I5).
 */
export function originKeyRootAllows(
  ownRoot: SnapshotKeyRoot,
  originRow: { keyLayout: unknown; keyPrefix: unknown } | undefined,
): boolean {
  if (originRow === undefined) return ownRoot.layout === 'legacy_flat';
  const originRoot = snapshotKeyRootOf(originRow);
  return originRoot !== null && sameKeyRoot(originRoot, ownRoot);
}
