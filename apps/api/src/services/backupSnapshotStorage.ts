import { rm, stat } from 'node:fs/promises';
import { posix as pathPosix, resolve as resolvePath } from 'node:path';
import {
  DeleteObjectsCommand,
  GetObjectLockConfigurationCommand,
  ListObjectsV2Command,
  PutObjectRetentionCommand,
} from '@aws-sdk/client-s3';
import { buildS3Client } from './recoveryMediaService';
import { asRecord, getStringValue } from './recoveryBootstrap';

type SnapshotStorageInput = {
  provider: string | null | undefined;
  providerConfig: unknown;
  snapshotId: string;
  metadata: unknown;
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
  const region = getStringValue(providerConfig, 'region');
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

async function deleteS3Prefix(
  providerConfig: Record<string, unknown>,
  storagePrefix: string,
): Promise<void> {
  const { bucket, client } = buildS3StorageClient(providerConfig);

  let continuationToken: string | undefined;
  do {
    const listed = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: storagePrefix.replace(/^\/+|\/+$/g, ''),
      ContinuationToken: continuationToken,
    }));
    const objects = (listed.Contents ?? [])
      .map((item) => item.Key)
      .filter((key): key is string => typeof key === 'string' && key.length > 0);

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

  let continuationToken: string | undefined;
  let objectCount = 0;

  do {
    const listed = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: storagePrefix.replace(/^\/+|\/+$/g, ''),
      ContinuationToken: continuationToken,
    }));

    const objects = (listed.Contents ?? [])
      .map((item) => item.Key)
      .filter((key): key is string => typeof key === 'string' && key.length > 0);

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

  try {
    const { bucket, client } = buildS3StorageClient(providerConfig);
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
