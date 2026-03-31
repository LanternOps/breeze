import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { posix as pathPosix, resolve as resolvePath } from 'node:path';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { recoveryTokens } from '../db/schema';
import {
  asRecord,
  computeRecoveryDownloadExpiry,
  getStringValue,
  resolveSnapshotProviderConfig,
} from './recoveryBootstrap';

type RecoveryDownloadRow = Pick<
  typeof recoveryTokens.$inferSelect,
  'id' | 'snapshotId' | 'status' | 'authenticatedAt' | 'expiresAt'
>;

function normalizeSnapshotPath(remotePath: string, expectedPrefix: string): string | null {
  const cleaned = pathPosix.normalize(String(remotePath || '').trim()).replace(/^\/+/, '');
  const prefix = expectedPrefix.replace(/^\/+|\/+$/g, '');
  if (!cleaned || cleaned === '.' || cleaned.includes('\0')) return null;
  if (cleaned === prefix || cleaned.startsWith(`${prefix}/`)) {
    return cleaned;
  }
  return null;
}

function ensureContainedLocalPath(rootPath: string, relativePath: string): string {
  const base = resolvePath(rootPath);
  const resolved = resolvePath(base, relativePath);
  if (resolved !== base && !resolved.startsWith(`${base}/`)) {
    throw new Error('path traversal detected');
  }
  return resolved;
}

function buildS3Client(config: {
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}) {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: Boolean(config.endpoint),
    credentials:
      config.accessKeyId && config.secretAccessKey
        ? {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
            sessionToken: config.sessionToken,
          }
        : undefined,
  });
}

function deriveRemoteStorageKey(
  normalizedRemotePath: string,
  providerConfig: Record<string, unknown>,
  snapshotMetadata: Record<string, unknown>
) {
  const storagePrefix = getStringValue(snapshotMetadata, 'storagePrefix');
  if (storagePrefix) {
    const marker = snapshotMetadata.snapshotId && typeof snapshotMetadata.snapshotId === 'string'
      ? `snapshots/${snapshotMetadata.snapshotId}`
      : null;
    if (marker) {
      const normalizedStoragePrefix = storagePrefix.replace(/^s3:\/\/[^/]+\//, '').replace(/^\/+|\/+$/g, '');
      const markerIndex = normalizedStoragePrefix.lastIndexOf(marker);
      if (markerIndex >= 0) {
        const basePrefix = normalizedStoragePrefix.slice(0, markerIndex).replace(/\/+$/g, '');
        return basePrefix ? `${basePrefix}/${normalizedRemotePath}` : normalizedRemotePath;
      }
    }
  }

  const prefix = getStringValue(providerConfig, 'prefix');
  return prefix ? `${prefix.replace(/^\/+|\/+$/g, '')}/${normalizedRemotePath}` : normalizedRemotePath;
}

export async function getAuthenticatedRecoveryDownloadTarget(
  tokenRow: RecoveryDownloadRow,
  remotePath: string
) {
  if (tokenRow.status !== 'active') {
    return { unavailable: true, reason: `Token is ${tokenRow.status}` } as const;
  }

  const downloadExpiry = computeRecoveryDownloadExpiry(tokenRow.authenticatedAt, tokenRow.expiresAt);
  if (!tokenRow.authenticatedAt || !downloadExpiry || downloadExpiry.getTime() <= Date.now()) {
    return { unavailable: true, reason: 'Recovery session has expired. Re-authenticate to continue.' } as const;
  }

  const resolved = await resolveSnapshotProviderConfig(tokenRow.snapshotId);
  if (!resolved?.snapshot || !resolved.providerType || !resolved.providerConfig) {
    return { unavailable: true, reason: 'Recovery snapshot storage is unavailable.' } as const;
  }

  const expectedPrefix = `snapshots/${resolved.snapshot.snapshotId}`;
  const normalizedRemotePath = normalizeSnapshotPath(remotePath, expectedPrefix);
  if (!normalizedRemotePath) {
    return { unavailable: true, reason: 'Requested path is outside the allowed snapshot scope.' } as const;
  }

  const providerConfig = asRecord(resolved.providerConfig);
  const snapshotMetadata = {
    ...asRecord(resolved.snapshot.metadata),
    snapshotId: resolved.snapshot.snapshotId,
  };

  if (resolved.providerType === 's3') {
    const bucket = getStringValue(providerConfig, 'bucket') || getStringValue(providerConfig, 'bucketName');
    const region = getStringValue(providerConfig, 'region');
    if (!bucket || !region) {
      return { unavailable: true, reason: 'Snapshot storage is misconfigured.' } as const;
    }

    const client = buildS3Client({
      region,
      endpoint: getStringValue(providerConfig, 'endpoint') ?? undefined,
      accessKeyId: getStringValue(providerConfig, 'accessKey') || getStringValue(providerConfig, 'accessKeyId') || undefined,
      secretAccessKey: getStringValue(providerConfig, 'secretKey') || getStringValue(providerConfig, 'secretAccessKey') || undefined,
      sessionToken: getStringValue(providerConfig, 'sessionToken') ?? undefined,
    });
    const key = deriveRemoteStorageKey(normalizedRemotePath, providerConfig, snapshotMetadata);
    const expiresInSeconds = Math.max(
      1,
      Math.min(300, Math.floor((downloadExpiry.getTime() - Date.now()) / 1000))
    );
    const url = await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
      { expiresIn: expiresInSeconds }
    );
    return {
      unavailable: false,
      type: 'redirect' as const,
      url,
      contentType: normalizedRemotePath.endsWith('.json') ? 'application/json' : 'application/octet-stream',
    };
  }

  if (resolved.providerType === 'local') {
    const rootPath = getStringValue(providerConfig, 'path') || getStringValue(providerConfig, 'basePath');
    if (!rootPath) {
      return { unavailable: true, reason: 'Snapshot storage is misconfigured.' } as const;
    }

    const filePath = ensureContainedLocalPath(rootPath, normalizedRemotePath);
    const fileInfo = await stat(filePath);
    return {
      unavailable: false,
      type: 'stream' as const,
      fileName: normalizedRemotePath.split('/').pop() || 'recovery-object',
      contentLength: fileInfo.size,
      contentType: normalizedRemotePath.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      stream: createReadStream(filePath),
    };
  }

  return {
    unavailable: true,
    reason: `Snapshot downloads are not supported for provider ${resolved.providerType}.`,
  } as const;
}
