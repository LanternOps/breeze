/**
 * Storage I/O through one snapshot key root (#7081), for the storage GC
 * (jobs/backupRetention.ts). Callers work entirely in LOGICAL keys
 * (`snapshots/<id>/...`, what manifests reference); this module composes the
 * physical key of every list / fetch / delete with `physicalKeyFor` and maps
 * every listed or reported key back with `logicalKeyFrom`. For the legacy
 * root both mappings are the identity, so every call is passed through
 * unchanged.
 *
 * Fail closed (I5): a listed key that does not map back under the root, or a
 * prefixed root on a provider other than S3 (I7), throws
 * `BackupKeyRootInvariantError` before anything is acted on.
 */
import { logicalKeyFrom, physicalKeyFor, keyRootId, type SnapshotKeyRoot } from './backupKeyLayout';
import {
  deleteBackupObjectKeys,
  fetchBackupObjectText,
  iterateBackupObjectsUnderPrefix,
  type BackupObjectDeleteResult,
  type BackupObjectListing,
} from './backupSnapshotStorage';

export type RootedStorage = {
  provider: string | null | undefined;
  providerConfig: unknown;
  root: SnapshotKeyRoot;
};

export class BackupKeyRootInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupKeyRootInvariantError';
  }
}

function assertRootUsable(storage: RootedStorage): void {
  if (storage.root.layout !== 'legacy_flat' && storage.provider !== 's3') {
    throw new BackupKeyRootInvariantError(
      `key root ${keyRootId(storage.root)} is not valid on a ${String(storage.provider)} destination`,
    );
  }
}

/** Streams the objects under a logical prefix of this root, with logical keys. */
export async function* iterateRootedObjects(
  storage: RootedStorage,
  logicalPrefix: string,
): AsyncGenerator<BackupObjectListing[]> {
  assertRootUsable(storage);
  const pages = iterateBackupObjectsUnderPrefix({
    provider: storage.provider,
    providerConfig: storage.providerConfig,
    prefix: physicalKeyFor(storage.root, logicalPrefix),
  });
  if (storage.root.layout === 'legacy_flat') {
    yield* pages;
    return;
  }
  for await (const page of pages) {
    const mapped: BackupObjectListing[] = [];
    for (const item of page) {
      const key = logicalKeyFrom(storage.root, item.key);
      if (key === null) {
        throw new BackupKeyRootInvariantError(
          `listing of key root ${keyRootId(storage.root)} returned an object outside it`,
        );
      }
      mapped.push({ key, lastModified: item.lastModified });
    }
    yield mapped;
  }
}

export async function fetchRootedObjectText(
  storage: RootedStorage,
  logicalKey: string,
  maxBytes?: number,
): Promise<string> {
  assertRootUsable(storage);
  return fetchBackupObjectText({
    provider: storage.provider,
    providerConfig: storage.providerConfig,
    key: physicalKeyFor(storage.root, logicalKey),
    ...(maxBytes !== undefined ? { maxBytes } : {}),
  });
}

/**
 * Deletes these logical keys under the root. Reported keys are mapped back to
 * the logical keys requested; a reported key that was not requested is
 * dropped (never counted as deleted).
 */
export async function deleteRootedObjectKeys(
  storage: RootedStorage,
  logicalKeys: string[],
): Promise<BackupObjectDeleteResult> {
  assertRootUsable(storage);
  if (logicalKeys.length === 0) return { deletedKeys: [], failedKeys: [] };
  const logicalOf = new Map(logicalKeys.map((key) => [physicalKeyFor(storage.root, key), key]));
  const result = await deleteBackupObjectKeys({
    provider: storage.provider,
    providerConfig: storage.providerConfig,
    keys: [...logicalOf.keys()],
  });
  if (storage.root.layout === 'legacy_flat') return result;
  const deletedKeys: string[] = [];
  for (const key of result.deletedKeys) {
    const logical = logicalOf.get(key);
    if (logical !== undefined) deletedKeys.push(logical);
  }
  const failedKeys: BackupObjectDeleteResult['failedKeys'] = [];
  for (const failure of result.failedKeys) {
    const logical = logicalOf.get(failure.key);
    if (logical !== undefined) failedKeys.push({ key: logical, error: failure.error });
  }
  return { deletedKeys, failedKeys };
}
