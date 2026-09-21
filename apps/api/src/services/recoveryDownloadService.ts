import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { createGuardedS3Client } from './guardedS3Client';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { coerceS3EndpointUrl } from '@breeze/shared';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { backupSnapshotFiles, backupSnapshotOrigins, backupSnapshots, recoveryTokens } from '../db/schema';
import { classifyBackupObjectKey, hasMembershipCapability } from './backupObjectKey';
import {
  asRecord,
  computeRecoveryDownloadExpiry,
  getStringValue,
  resolveSnapshotProviderConfig,
} from './recoveryBootstrap';

type RecoveryDownloadRow = Pick<
  typeof recoveryTokens.$inferSelect,
  'id' | 'orgId' | 'deviceId' | 'snapshotId' | 'status' | 'authenticatedAt' | 'expiresAt' | 'negotiatedCapabilities'
>;

/**
 * W09 (#6464) Task 6 — the download-time half of the exact-membership
 * contract. First confirms the TOKEN snapshot's file index is fully built
 * (`file_index_status = 'complete'` — an `agent`/`failed` index is
 * incomplete or untrustworthy and must never authorize an external
 * reference), then runs two indexed EXISTS-shaped checks: is this exact key
 * a member of the TOKEN snapshot's server-verified file index, and is its
 * origin snapshot verified against the SAME org/device/storage identity as
 * the token. All queries run inside the caller's `runInRecoveryOrgContext`
 * — RLS on both tables (Task 2) additionally enforces the org boundary
 * independent of the explicit `orgId` equality checks here.
 */
export async function authorizeExternalReference(
  dbHandle: typeof import('../db').db,
  args: { snapshotDbId: string; key: string; originSnapshotId: string; orgId: string; deviceId: string; pinnedStorageIdentity: string },
): Promise<{ ok: true; originStoragePrefix: string | null } | { ok: false; reason: string }> {
  const [tokenSnapshot] = await dbHandle
    .select({ fileIndexStatus: backupSnapshots.fileIndexStatus })
    .from(backupSnapshots)
    .where(eq(backupSnapshots.id, args.snapshotDbId))
    .limit(1);
  if (!tokenSnapshot || tokenSnapshot.fileIndexStatus !== 'complete') {
    return { ok: false, reason: 'file index not complete' };
  }

  const [membership] = await dbHandle
    .select({ id: backupSnapshotFiles.id })
    .from(backupSnapshotFiles)
    .where(and(eq(backupSnapshotFiles.snapshotDbId, args.snapshotDbId), eq(backupSnapshotFiles.backupPath, args.key)))
    .limit(1);
  if (!membership) {
    return { ok: false, reason: 'key is not a member of the snapshot file index' };
  }

  const [origin] = await dbHandle
    .select({
      originOrgId: backupSnapshotOrigins.originOrgId,
      originDeviceId: backupSnapshotOrigins.originDeviceId,
      originStorageIdentity: backupSnapshotOrigins.originStorageIdentity,
      originStoragePrefix: backupSnapshotOrigins.originStoragePrefix,
    })
    .from(backupSnapshotOrigins)
    .where(and(eq(backupSnapshotOrigins.snapshotDbId, args.snapshotDbId), eq(backupSnapshotOrigins.originSnapshotId, args.originSnapshotId)))
    .limit(1);
  if (!origin) {
    return { ok: false, reason: 'no verified origin record for this snapshot reference' };
  }
  if (
    origin.originOrgId !== args.orgId ||
    origin.originDeviceId !== args.deviceId ||
    origin.originStorageIdentity !== args.pinnedStorageIdentity
  ) {
    return { ok: false, reason: 'origin identity does not match the recovery token' };
  }

  return { ok: true, originStoragePrefix: origin.originStoragePrefix };
}

function isDownloadEligibleStatus(status: string, authenticatedAt: Date | null): boolean {
  return status === 'authenticated' || (status === 'active' && authenticatedAt !== null);
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
  // These configs may have been persisted before endpoint validation existed
  // (validateS3Details in routes/backup/schemas.ts), so a scheme-less
  // endpoint here would otherwise reach the SDK and fail opaquely inside
  // @smithy/core's endpoint resolver instead of pointing at the actual
  // problem (Sentry BREEZE-P). See coerceS3EndpointUrl for the two distinct
  // failure modes a scheme-less value produces.
  const endpoint = coerceS3EndpointUrl(config.endpoint);
  return createGuardedS3Client({
    region: config.region,
    endpoint,
    forcePathStyle: Boolean(endpoint),
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
  snapshotMetadata: Record<string, unknown>,
  originStoragePrefixOverride?: string | null
) {
  // W09 (#6464) Task 6: an external reference is served from the ORIGIN
  // snapshot's own verified storage prefix, never the token snapshot's —
  // origin.originStoragePrefix was captured and verified by
  // hydrateSnapshotFileIndex (Task 4) at index-build time.
  if (originStoragePrefixOverride) {
    return `${originStoragePrefixOverride.replace(/^\/+|\/+$/g, '')}/${normalizedRemotePath}`;
  }
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
  if (tokenRow.status === 'revoked' || tokenRow.status === 'expired' || tokenRow.status === 'used') {
    return { unavailable: true, reason: `Token is ${tokenRow.status}` } as const;
  }

  const downloadExpiry = computeRecoveryDownloadExpiry(tokenRow.authenticatedAt, tokenRow.expiresAt);
  if (
    !isDownloadEligibleStatus(tokenRow.status, tokenRow.authenticatedAt) ||
    !tokenRow.authenticatedAt ||
    !downloadExpiry ||
    downloadExpiry.getTime() <= Date.now()
  ) {
    return { unavailable: true, reason: 'Recovery session has expired. Re-authenticate to continue.' } as const;
  }

  // D17 (2026-10-15-140004): recovery_tokens.snapshot_id is now ON DELETE SET
  // NULL, so a still-eligible-for-download token can point at a snapshot
  // retention already deleted. Nothing is downloadable in that case — same
  // "unavailable" shape every other guard in this function returns.
  const snapshotDbId = tokenRow.snapshotId;
  if (!snapshotDbId) {
    return { unavailable: true, reason: 'Recovery snapshot lineage is unavailable.' } as const;
  }

  const [lineage] = await db
    .select({ orgId: backupSnapshots.orgId, deviceId: backupSnapshots.deviceId })
    .from(backupSnapshots)
    .where(and(
      eq(backupSnapshots.id, snapshotDbId),
      eq(backupSnapshots.orgId, tokenRow.orgId),
    ))
    .limit(1);
  if (!lineage || lineage.orgId !== tokenRow.orgId || lineage.deviceId !== tokenRow.deviceId) {
    return { unavailable: true, reason: 'Recovery snapshot lineage is unavailable.' } as const;
  }

  const resolved = await resolveSnapshotProviderConfig(snapshotDbId);
  if (!resolved?.snapshot || !resolved.providerType || !resolved.providerConfig) {
    return { unavailable: true, reason: 'Recovery snapshot storage is unavailable.' } as const;
  }

  const ownSnapshotId = resolved.snapshot.snapshotId;
  const scope = classifyBackupObjectKey(String(remotePath || '').replace(/^\/+/, ''), ownSnapshotId);
  if (!scope) {
    return { unavailable: true, reason: 'Requested path is outside the allowed snapshot scope.' } as const;
  }

  let originStoragePrefix: string | null = null;
  if (scope.kind === 'external') {
    if (!hasMembershipCapability(tokenRow.negotiatedCapabilities)) {
      return {
        unavailable: true,
        reason: 'Requested path references an object this recovery is not authorized to read.',
      } as const;
    }
    const authorization = await authorizeExternalReference(db, {
      snapshotDbId,
      key: scope.key,
      originSnapshotId: scope.originSnapshotId,
      orgId: tokenRow.orgId,
      deviceId: tokenRow.deviceId,
      pinnedStorageIdentity: resolved.snapshot.storageIdentity ?? '',
    });
    if (!authorization.ok) {
      return {
        unavailable: true,
        reason: 'Requested path references an object this recovery is not authorized to read.',
      } as const;
    }
    originStoragePrefix = authorization.originStoragePrefix;
  }
  const normalizedRemotePath = scope.key;

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
    const key = deriveRemoteStorageKey(normalizedRemotePath, providerConfig, snapshotMetadata, originStoragePrefix);
    const expiresInSeconds = Math.max(
      1,
      Math.min(300, Math.floor((downloadExpiry.getTime() - Date.now()) / 1000))
    );
    const url = await (getSignedUrl as any)(
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

    const filePath = ensureContainedLocalPath(
      rootPath,
      originStoragePrefix ? `${originStoragePrefix}/${normalizedRemotePath}` : normalizedRemotePath
    );
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
