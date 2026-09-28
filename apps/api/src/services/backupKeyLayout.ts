/**
 * Object-key layouts a backup snapshot can be written with
 * (`backup_snapshots.key_layout`).
 *
 * Every writer produces `legacy_flat`: all of a snapshot's objects live under
 * `snapshots/<snapshotId>/` (services/backupObjectKey.ts). Every reader —
 * retention, storage GC, storage-session issuance and use, recovery
 * downloads — refuses a snapshot whose layout is not listed here instead of
 * guessing where its objects are. Storage GC skips a whole storage identity
 * while any of its snapshots has an unknown layout, since it could otherwise
 * treat that snapshot's objects as unreferenced.
 *
 * A second layout, if one is ever introduced, uses a separate root prefix
 * (never a new level below `snapshots/`), so a reader that lists only
 * `snapshots/` and groups by the first segment after it never mistakes
 * another layout's objects for a snapshot of its own.
 */
export const BACKUP_KEY_LAYOUTS = ['legacy_flat'] as const;

export type BackupKeyLayout = (typeof BACKUP_KEY_LAYOUTS)[number];

export function isSupportedKeyLayout(value: unknown): value is BackupKeyLayout {
  return typeof value === 'string' && (BACKUP_KEY_LAYOUTS as readonly string[]).includes(value);
}
