import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join as joinLocalPath, posix as pathPosix, resolve as resolvePath } from 'node:path';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  ListObjectsV2Command,
  PutObjectRetentionCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { deriveS3RegionFromEndpoint } from '@breeze/shared';
import { buildS3Client } from './recoveryMediaService';
import { asRecord, getStringValue } from './recoveryBootstrap';

type SnapshotStorageInput = {
  provider: string | null | undefined;
  providerConfig: unknown;
  snapshotId: string;
  metadata: unknown;
};

// Mirrors agent/internal/backup/snapshot.go's snapshotRootDir/snapshotManifestKey
// constants exactly — the GC mark-and-sweep phase (backupRetention.ts) computes
// the same keys the agent wrote, independently of any per-snapshot metadata.
export const BACKUP_SNAPSHOT_ROOT_DIR = 'snapshots';
export const BACKUP_SNAPSHOT_MANIFEST_KEY = 'manifest.json';

export type BackupObjectListing = { key: string; lastModified: Date | null };
export type BackupObjectDeleteResult = {
  deletedKeys: string[];
  failedKeys: { key: string; error: string }[];
};

type SnapshotImmutabilityInput = SnapshotStorageInput & {
  retainUntil: Date;
};

type SnapshotImmutabilityResult = {
  enforcement: 'provider';
  objectCount: number;
};

export type ProviderCapabilityStatus = {
  objectLock: {
    supported: boolean;
    error: string | null;
  };
};

function buildS3StorageClient(providerConfig: Record<string, unknown>) {
  const bucket = getStringValue(providerConfig, 'bucket') || getStringValue(providerConfig, 'bucketName');
  const region =
    getStringValue(providerConfig, 'region')?.trim() ||
    deriveS3RegionFromEndpoint(getStringValue(providerConfig, 'endpoint'));
  if (!bucket || !region) {
    throw new Error('S3 backup storage is misconfigured');
  }

  return {
    bucket,
    client: buildS3Client({
      provider: 's3',
      bucket,
      region,
      endpoint: getStringValue(providerConfig, 'endpoint') ?? undefined,
      accessKeyId:
        getStringValue(providerConfig, 'accessKey') ||
        getStringValue(providerConfig, 'accessKeyId') ||
        '',
      secretAccessKey:
        getStringValue(providerConfig, 'secretKey') ||
        getStringValue(providerConfig, 'secretAccessKey') ||
        '',
      sessionToken: getStringValue(providerConfig, 'sessionToken') ?? undefined,
    } as any),
  };
}

function normalizeCapabilityError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (normalized.includes('accessdenied') || normalized.includes('access denied')) {
    return 'Access denied checking object lock configuration';
  }
  if (normalized.includes('timed out') || normalized.includes('timeout') || normalized.includes('network')) {
    return 'Timed out checking object lock configuration';
  }
  if (normalized.includes('object lock configuration does not exist')) {
    return 'Bucket object lock is not enabled';
  }

  return message || fallback;
}

function ensureContainedLocalPath(rootPath: string, relativePath: string): string {
  const base = resolvePath(rootPath);
  const resolved = resolvePath(base, relativePath);
  if (resolved !== base && !resolved.startsWith(`${base}/`)) {
    throw new Error('path traversal detected');
  }
  return resolved;
}

function normalizeStoragePrefix(
  provider: string | null | undefined,
  providerConfig: Record<string, unknown>,
  snapshotMetadata: Record<string, unknown>,
  snapshotId: string,
): string {
  const rawStoragePrefix = getStringValue(snapshotMetadata, 'storagePrefix');
  if (rawStoragePrefix) {
    const withoutBucket = provider === 's3'
      ? rawStoragePrefix.replace(/^s3:\/\/[^/]+\//, '')
      : rawStoragePrefix;
    const normalized = withoutBucket.replace(/^\/+|\/+$/g, '');
    if (normalized) {
      return normalized;
    }
  }

  const configuredPrefix = getStringValue(providerConfig, 'prefix');
  const snapshotPrefix = `snapshots/${snapshotId}`;
  return configuredPrefix
    ? `${configuredPrefix.replace(/^\/+|\/+$/g, '')}/${snapshotPrefix}`
    : snapshotPrefix;
}

function normalizeObjectPrefix(storagePrefix: string): string {
  return storagePrefix.replace(/^\/+|\/+$/g, '');
}

function keyMatchesSnapshotPrefix(key: string, normalizedPrefix: string): boolean {
  return key === normalizedPrefix || key.startsWith(`${normalizedPrefix}/`);
}

// ── GC support: destination-wide prefix/key helpers ──────────────────────────
//
// Unlike normalizeStoragePrefix (per-snapshot, honors metadata.storagePrefix
// overrides for legacy compat), these compute the single destination-wide
// "snapshot root" GC lists once per storage identity, and the manifest key
// GC expects every retained snapshot to have.
//
// KNOWN GAP: these deliberately IGNORE `providerConfig.prefix` entirely — the agent
// (agent/internal/backup/snapshot.go's snapshotRootDir) writes every object
// under `snapshots/<id>/...` VERBATIM regardless of any configured prefix,
// so applying a prefix here made GC 404 on manifest fetches for any
// destination with a configured prefix. If/when the agent gains real prefix
// support, this function and the agent's snapshotRootDir usage must change
// TOGETHER — applying a prefix on only one side either 404s manifest fetches
// (GC prefixed, agent didn't) or sweeps/lists the wrong bucket region
// (agent prefixed, GC didn't). This is also why GC groups destinations by
// storage identity EXCLUDING prefix (see backupRetention.ts) — two configs
// that only differ by a cosmetically-configured prefix are, in reality, the
// exact same physical object namespace as far as the agent is concerned.

export function backupSnapshotRootPrefix(): string {
  return BACKUP_SNAPSHOT_ROOT_DIR;
}

export function backupSnapshotManifestKey(snapshotId: string): string {
  return `${BACKUP_SNAPSHOT_ROOT_DIR}/${snapshotId}/${BACKUP_SNAPSHOT_MANIFEST_KEY}`;
}

// ── GC support: list objects with last-modified ──────────────────────────────

async function listS3ObjectsWithLastModified(
  providerConfig: Record<string, unknown>,
  prefix: string,
): Promise<BackupObjectListing[]> {
  const { bucket, client } = buildS3StorageClient(providerConfig);
  // A bare "snapshots" Prefix string-matches
  // ANY key that merely starts with those characters — e.g. "snapshots-old/db.dump"
  // or "snapshotsummary.txt" — not just the "snapshots/" namespace. That would
  // make an unrelated object a GC delete candidate. Force exactly one trailing
  // slash so S3's prefix match is scoped to the actual directory-like
  // namespace, same guard `keyMatchesSnapshotPrefix` (above) applies for
  // per-snapshot prefixes elsewhere in this file.
  const normalizedPrefix = `${normalizeObjectPrefix(prefix)}/`;
  const results: BackupObjectListing[] = [];

  let continuationToken: string | undefined;
  do {
    const listed = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: normalizedPrefix,
      ContinuationToken: continuationToken,
    }));

    for (const item of listed.Contents ?? []) {
      // Defense-in-depth: AWS's own Prefix filtering is authoritative, but
      // don't rely on it exclusively — a misbehaving or (in tests) mocked
      // provider returning an out-of-namespace key must never become a
      // delete candidate.
      if (
        typeof item.Key === 'string' &&
        item.Key.length > 0 &&
        item.Key.startsWith(normalizedPrefix)
      ) {
        results.push({
          key: item.Key,
          lastModified: item.LastModified instanceof Date ? item.LastModified : null,
        });
      }
    }

    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);

  return results;
}

async function listLocalObjectsWithLastModified(
  providerConfig: Record<string, unknown>,
  prefix: string,
): Promise<BackupObjectListing[]> {
  const rootPath = getStringValue(providerConfig, 'path') || getStringValue(providerConfig, 'basePath');
  if (!rootPath) {
    throw new Error('Local backup storage is misconfigured');
  }

  const normalizedPrefix = pathPosix.normalize(prefix).replace(/^\/+/, '');
  const targetPath = ensureContainedLocalPath(rootPath, normalizedPrefix);
  const results: BackupObjectListing[] = [];

  async function walk(dirPath: string, keyPrefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      const childKey = keyPrefix ? `${keyPrefix}/${entry.name}` : entry.name;
      const childPath = joinLocalPath(dirPath, entry.name);
      if (entry.isDirectory()) {
        await walk(childPath, childKey);
      } else if (entry.isFile()) {
        const info = await stat(childPath);
        results.push({ key: childKey, lastModified: info.mtime });
      }
    }
  }

  await walk(targetPath, normalizedPrefix);
  return results;
}

/**
 * Lists every object under a destination's snapshot root, including
 * last-modified so GC can enforce the grace window. Throws for providers
 * this GC path doesn't support — callers must treat that as "skip this
 * destination" (fail-closed: no age data means no safe sweep decision).
 */
export async function listBackupObjectsUnderPrefix(input: {
  provider: string | null | undefined;
  providerConfig: unknown;
  prefix: string;
}): Promise<BackupObjectListing[]> {
  const provider = input.provider ?? null;
  const providerConfig = asRecord(input.providerConfig);
  if (provider === 's3') return listS3ObjectsWithLastModified(providerConfig, input.prefix);
  if (provider === 'local') return listLocalObjectsWithLastModified(providerConfig, input.prefix);
  throw new Error(`Provider ${provider ?? 'unknown'} does not support object listing for GC`);
}

// ── GC support: fetch a single object's text (manifest fetch) ────────────────

async function fetchS3ObjectText(providerConfig: Record<string, unknown>, key: string): Promise<string> {
  const { bucket, client } = buildS3StorageClient(providerConfig);
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) {
    throw new Error(`Empty response body for ${key}`);
  }
  return response.Body.transformToString('utf-8');
}

async function fetchLocalObjectText(providerConfig: Record<string, unknown>, key: string): Promise<string> {
  const rootPath = getStringValue(providerConfig, 'path') || getStringValue(providerConfig, 'basePath');
  if (!rootPath) {
    throw new Error('Local backup storage is misconfigured');
  }
  const normalizedKey = pathPosix.normalize(key).replace(/^\/+/, '');
  const targetPath = ensureContainedLocalPath(rootPath, normalizedKey);
  return readFile(targetPath, 'utf8');
}

/**
 * Fetches one object's contents as text (used by GC to fetch/parse retained
 * snapshot manifests). Throws on any failure — callers must treat a throw as
 * "mark phase failed, no sweep this run" per the fail-closed GC contract.
 */
export async function fetchBackupObjectText(input: {
  provider: string | null | undefined;
  providerConfig: unknown;
  key: string;
}): Promise<string> {
  const provider = input.provider ?? null;
  const providerConfig = asRecord(input.providerConfig);
  if (provider === 's3') return fetchS3ObjectText(providerConfig, input.key);
  if (provider === 'local') return fetchLocalObjectText(providerConfig, input.key);
  throw new Error(`Provider ${provider ?? 'unknown'} does not support object fetch for GC`);
}

// ── GC support: delete specific object keys ───────────────────────────────────

async function deleteS3ObjectKeys(
  providerConfig: Record<string, unknown>,
  keys: string[],
): Promise<BackupObjectDeleteResult> {
  const deletedKeys: string[] = [];
  const failedKeys: { key: string; error: string }[] = [];

  // Client construction is inside the soft-failure contract this function
  // documents: a config error (bad endpoint, missing bucket/region) must be
  // reported as "these keys were not confirmed deleted", not thrown, or the GC
  // sweep aborts wholesale instead of recording a resumable partial failure.
  let bucket: string;
  let client: S3Client;
  try {
    ({ bucket, client } = buildS3StorageClient(providerConfig));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { deletedKeys, failedKeys: keys.map((key) => ({ key, error: message })) };
  }

  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    try {
      const response = await client.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: false },
      }));

      const erroredKeys = new Set(
        (response.Errors ?? [])
          .map((e) => e.Key)
          .filter((k): k is string => typeof k === 'string'),
      );

      for (const key of batch) {
        if (!erroredKeys.has(key)) deletedKeys.push(key);
      }
      for (const err of response.Errors ?? []) {
        if (typeof err.Key === 'string') {
          // A per-key rejection (e.g. object-lock GOVERNANCE mode denying
          // delete) must not crash the sweep — counted as failed, left in
          // place for a future run once the lock lifts.
          failedKeys.push({ key: err.Key, error: err.Message ?? err.Code ?? 'unknown S3 delete error' });
        }
      }
    } catch (error) {
      // Whole-batch failure (network/auth/etc): every key in this batch is
      // "not confirmed deleted" — count as failed rather than assume success.
      const message = error instanceof Error ? error.message : String(error);
      for (const key of batch) failedKeys.push({ key, error: message });
    }
  }

  return { deletedKeys, failedKeys };
}

async function deleteLocalObjectKeys(
  providerConfig: Record<string, unknown>,
  keys: string[],
): Promise<BackupObjectDeleteResult> {
  const rootPath = getStringValue(providerConfig, 'path') || getStringValue(providerConfig, 'basePath');
  if (!rootPath) {
    throw new Error('Local backup storage is misconfigured');
  }

  const deletedKeys: string[] = [];
  const failedKeys: { key: string; error: string }[] = [];

  for (const key of keys) {
    try {
      const normalizedKey = pathPosix.normalize(key).replace(/^\/+/, '');
      const targetPath = ensureContainedLocalPath(rootPath, normalizedKey);
      await rm(targetPath, { force: true });
      deletedKeys.push(key);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedKeys.push({ key, error: message });
    }
  }

  return { deletedKeys, failedKeys };
}

/**
 * Deletes specific object keys (GC sweep phase — never a prefix-wide delete).
 * Per-key failures (including object-lock rejections) are caught and counted
 * in `failedKeys`, never thrown — a locked/undeletable object must not abort
 * the rest of the sweep.
 */
export async function deleteBackupObjectKeys(input: {
  provider: string | null | undefined;
  providerConfig: unknown;
  keys: string[];
}): Promise<BackupObjectDeleteResult> {
  if (input.keys.length === 0) return { deletedKeys: [], failedKeys: [] };
  const provider = input.provider ?? null;
  const providerConfig = asRecord(input.providerConfig);
  if (provider === 's3') return deleteS3ObjectKeys(providerConfig, input.keys);
  if (provider === 'local') return deleteLocalObjectKeys(providerConfig, input.keys);
  throw new Error(`Provider ${provider ?? 'unknown'} does not support object deletion for GC`);
}

async function deleteS3Prefix(
  providerConfig: Record<string, unknown>,
  storagePrefix: string,
): Promise<void> {
  const { bucket, client } = buildS3StorageClient(providerConfig);
  const normalizedPrefix = normalizeObjectPrefix(storagePrefix);

  let continuationToken: string | undefined;
  do {
    const listed = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: normalizedPrefix,
      ContinuationToken: continuationToken,
    }));
    const objects = (listed.Contents ?? [])
      .map((item) => item.Key)
      .filter((key): key is string =>
        typeof key === 'string' &&
        key.length > 0 &&
        keyMatchesSnapshotPrefix(key, normalizedPrefix)
      );

    if (objects.length > 0) {
      await client.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: objects.map((Key) => ({ Key })),
          Quiet: true,
        },
      }));
    }

    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
}

async function deleteLocalPrefix(
  providerConfig: Record<string, unknown>,
  storagePrefix: string,
): Promise<void> {
  const rootPath = getStringValue(providerConfig, 'path') || getStringValue(providerConfig, 'basePath');
  if (!rootPath) {
    throw new Error('Local backup storage is misconfigured');
  }

  const normalizedRelative = pathPosix.normalize(storagePrefix).replace(/^\/+/, '');
  const targetPath = ensureContainedLocalPath(rootPath, normalizedRelative);
  try {
    const fileInfo = await stat(targetPath);
    await rm(targetPath, { recursive: fileInfo.isDirectory(), force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ENOENT') {
      throw error;
    }
  }
}

async function applyS3PrefixRetention(
  providerConfig: Record<string, unknown>,
  storagePrefix: string,
  retainUntil: Date,
): Promise<SnapshotImmutabilityResult> {
  const { bucket, client } = buildS3StorageClient(providerConfig);
  const normalizedPrefix = normalizeObjectPrefix(storagePrefix);

  let continuationToken: string | undefined;
  let objectCount = 0;

  do {
    const listed = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: normalizedPrefix,
      ContinuationToken: continuationToken,
    }));

    const objects = (listed.Contents ?? [])
      .map((item) => item.Key)
      .filter((key): key is string =>
        typeof key === 'string' &&
        key.length > 0 &&
        keyMatchesSnapshotPrefix(key, normalizedPrefix)
      );

    for (const key of objects) {
      await client.send(new PutObjectRetentionCommand({
        Bucket: bucket,
        Key: key,
        Retention: {
          Mode: 'GOVERNANCE',
          RetainUntilDate: retainUntil,
        },
      }));
      objectCount++;
    }

    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);

  if (objectCount === 0) {
    throw new Error('No snapshot objects found for provider-enforced immutability');
  }

  return {
    enforcement: 'provider',
    objectCount,
  };
}

export async function deleteBackupSnapshotArtifacts(input: SnapshotStorageInput): Promise<void> {
  const provider = input.provider ?? null;
  if (provider !== 's3' && provider !== 'local') {
    return;
  }

  const providerConfig = asRecord(input.providerConfig);
  const snapshotMetadata = asRecord(input.metadata);
  const storagePrefix = normalizeStoragePrefix(provider, providerConfig, snapshotMetadata, input.snapshotId);

  if (provider === 's3') {
    await deleteS3Prefix(providerConfig, storagePrefix);
    return;
  }

  await deleteLocalPrefix(providerConfig, storagePrefix);
}

export async function applyBackupSnapshotImmutability(
  input: SnapshotImmutabilityInput,
): Promise<SnapshotImmutabilityResult> {
  const provider = input.provider ?? null;
  const providerConfig = asRecord(input.providerConfig);
  const snapshotMetadata = asRecord(input.metadata);
  const storagePrefix = normalizeStoragePrefix(provider, providerConfig, snapshotMetadata, input.snapshotId);

  if (provider === 's3') {
    return applyS3PrefixRetention(providerConfig, storagePrefix, input.retainUntil);
  }

  throw new Error(`Provider ${provider ?? 'unknown'} does not support provider-enforced immutability`);
}

export async function checkBackupProviderCapabilities(input: {
  provider: string | null | undefined;
  providerConfig: unknown;
}): Promise<ProviderCapabilityStatus> {
  const provider = input.provider ?? null;
  if (provider !== 's3') {
    return {
      objectLock: {
        supported: false,
        error: 'Object lock is only supported for S3 providers',
      },
    };
  }

  const providerConfig = asRecord(input.providerConfig);

  // Client construction is deliberately OUTSIDE the try below. A failure here
  // means the stored config itself is unusable (bad endpoint, missing bucket
  // or region) — that is not an "object lock is unsupported" answer, and
  // folding it into objectLock.error made callers report a broken endpoint to
  // the user as "Bucket object lock is not enabled" (routes/backup/snapshots.ts)
  // and silently downgrade WORM enforcement (services/backupResultPersistence.ts).
  // Let a config error propagate so callers can tell the two apart.
  const { bucket, client } = buildS3StorageClient(providerConfig);

  try {
    const response = await client.send(new GetObjectLockConfigurationCommand({
      Bucket: bucket,
    }));
    const enabled = response.ObjectLockConfiguration?.ObjectLockEnabled === 'Enabled';

    return {
      objectLock: {
        supported: enabled,
        error: enabled ? null : 'Bucket object lock is not enabled',
      },
    };
  } catch (error) {
    return {
      objectLock: {
        supported: false,
        error: normalizeCapabilityError(error, 'Failed to check object lock configuration'),
      },
    };
  }
}
