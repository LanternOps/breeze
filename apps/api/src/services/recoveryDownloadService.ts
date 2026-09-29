import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { pipeline } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { createGuardedS3Client } from './guardedS3Client';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { coerceS3EndpointUrl, deriveS3RegionFromEndpoint } from '@breeze/shared';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { backupSnapshotFiles, backupSnapshotOrigins, backupSnapshots, recoveryTokens } from '../db/schema';
import { backupSnapshotAttestations } from '../db/schema/backupSnapshotAttestations';
import { isSupportedKeyLayout } from './backupKeyLayout';
import { boundIndexCondition, indexMatchesAttestation } from './backupRestoreIntegrity';
import { classifyBackupObjectKey, hasMembershipCapability } from './backupObjectKey';
import {
  asRecord,
  computeRecoveryDownloadExpiry,
  getStringValue,
  resolveSnapshotProviderConfig,
} from './recoveryBootstrap';
import { RECOVERY_REFUSAL_MESSAGES } from './recoveryCapabilities';
import { normalizeStorageIdentity } from '../jobs/backupRetention';

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
  args: { tokenId: string; snapshotDbId: string; key: string; originSnapshotId: string; orgId: string; deviceId: string; pinnedStorageIdentity: string },
): Promise<{ ok: true; originStoragePrefix: string | null } | { ok: false; reason: string }> {
  // The four internal refusal reasons below collapse into one identical
  // public string at the call site (never leak which gate tripped to an
  // unauthenticated client) — this is the only place an operator can tell
  // "index not built yet" apart from "poisoned manifest in a shared
  // bucket" apart from "cross-org key guess".
  const refuse = (reason: string): { ok: false; reason: string } => {
    console.warn(
      `[authorizeExternalReference] refused token ${args.tokenId}:`,
      { tokenId: args.tokenId, snapshotDbId: args.snapshotDbId, key: args.key, reason },
    );
    return { ok: false, reason };
  };

  const [tokenSnapshot] = await dbHandle
    .select({
      fileIndexStatus: backupSnapshots.fileIndexStatus,
      fileIndexManifestSha256: backupSnapshots.fileIndexManifestSha256,
      integrityStatus: backupSnapshots.integrityStatus,
      attestation: {
        status: backupSnapshotAttestations.status,
        manifestSha256: backupSnapshotAttestations.manifestSha256,
      },
    })
    .from(backupSnapshots)
    .leftJoin(backupSnapshotAttestations, eq(backupSnapshotAttestations.snapshotDbId, backupSnapshots.id))
    .where(eq(backupSnapshots.id, args.snapshotDbId))
    .limit(1);
  if (!tokenSnapshot || tokenSnapshot.fileIndexStatus !== 'complete') {
    return refuse('file index not complete');
  }
  // The index authorizes only when it was built from exactly the manifest
  // bytes the snapshot's attestation names (services/backupRestoreIntegrity.ts).
  const attestation = tokenSnapshot.attestation
    && typeof tokenSnapshot.attestation.status === 'string'
    && typeof tokenSnapshot.attestation.manifestSha256 === 'string'
    ? { status: tokenSnapshot.attestation.status, manifestSha256: tokenSnapshot.attestation.manifestSha256 }
    : null;
  const boundDigest = tokenSnapshot.fileIndexManifestSha256 ?? null;
  if (!indexMatchesAttestation(
    { fileIndexStatus: tokenSnapshot.fileIndexStatus, fileIndexManifestSha256: boundDigest, integrityStatus: tokenSnapshot.integrityStatus ?? null },
    attestation,
  )) {
    return refuse('file index does not match the snapshot attestation');
  }

  // Membership is read in one statement with the index state it was approved
  // on: rows of an index being rebuilt, or rebuilt from other bytes since the
  // check above, never count.
  const [membership] = await dbHandle
    .select({ id: backupSnapshotFiles.id })
    .from(backupSnapshotFiles)
    .innerJoin(backupSnapshots, eq(backupSnapshots.id, backupSnapshotFiles.snapshotDbId))
    .leftJoin(backupSnapshotAttestations, eq(backupSnapshotAttestations.snapshotDbId, backupSnapshots.id))
    .where(and(
      eq(backupSnapshotFiles.snapshotDbId, args.snapshotDbId),
      eq(backupSnapshotFiles.backupPath, args.key),
      boundIndexCondition(boundDigest),
    ))
    .limit(1);
  if (!membership) {
    return refuse('key is not a member of the snapshot file index');
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
    return refuse('no verified origin record for this snapshot reference');
  }
  if (
    origin.originOrgId !== args.orgId ||
    origin.originDeviceId !== args.deviceId ||
    origin.originStorageIdentity !== args.pinnedStorageIdentity
  ) {
    return refuse('origin identity does not match the recovery token');
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

/**
 * Presigned GET for ONE exact object key of an S3 backup destination, built
 * with the same tenant-configuration client as the recovery download path.
 * The key is used verbatim (the agent writes `snapshots/<id>/...` without any
 * configured prefix; see backupSnapshotStorage.ts). The caller is responsible
 * for authorizing the key and for bounding `expiresInSeconds` (clamped here to
 * 1..300).
 */
export async function presignSnapshotObjectGet(args: {
  providerConfig: Record<string, unknown>;
  key: string;
  expiresInSeconds: number;
}): Promise<string> {
  const providerConfig = asRecord(args.providerConfig);
  const bucket = getStringValue(providerConfig, 'bucket') || getStringValue(providerConfig, 'bucketName');
  const region =
    getStringValue(providerConfig, 'region')?.trim() ||
    deriveS3RegionFromEndpoint(getStringValue(providerConfig, 'endpoint'));
  if (!bucket || !region) {
    throw new Error('Snapshot storage is misconfigured.');
  }
  const client = buildS3Client({
    region,
    endpoint: getStringValue(providerConfig, 'endpoint') ?? undefined,
    accessKeyId: getStringValue(providerConfig, 'accessKey') || getStringValue(providerConfig, 'accessKeyId') || undefined,
    secretAccessKey: getStringValue(providerConfig, 'secretKey') || getStringValue(providerConfig, 'secretAccessKey') || undefined,
    sessionToken: getStringValue(providerConfig, 'sessionToken') ?? undefined,
  });
  const expiresIn = Math.max(1, Math.min(300, Math.floor(args.expiresInSeconds)));
  return (getSignedUrl as any)(client, new GetObjectCommand({ Bucket: bucket, Key: args.key }), { expiresIn });
}

function deriveRemoteStorageKey(
  normalizedRemotePath: string,
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

  // #6398: the destination's configured `prefix` is deliberately NOT applied.
  // The agent's storage providers never apply it — every snapshot object is
  // written at `snapshots/<id>/...` verbatim — so presigning
  // `<prefix>/snapshots/...` 404'd every token-mode recovery (bmr-recover,
  // bare-metal / Restore-as-VM rebuild, DR) on a prefixed destination. GC
  // (backupSnapshotStorage.ts backupSnapshotRootPrefix) already relies on the
  // same fact. Only a per-snapshot recorded storagePrefix (above) relocates a
  // snapshot's keys.
  return normalizedRemotePath;
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
    .select({ orgId: backupSnapshots.orgId, deviceId: backupSnapshots.deviceId, keyLayout: backupSnapshots.keyLayout })
    .from(backupSnapshots)
    .where(and(
      eq(backupSnapshots.id, snapshotDbId),
      eq(backupSnapshots.orgId, tokenRow.orgId),
    ))
    .limit(1);
  if (!lineage || lineage.orgId !== tokenRow.orgId || lineage.deviceId !== tokenRow.deviceId) {
    return { unavailable: true, reason: 'Recovery snapshot lineage is unavailable.' } as const;
  }
  // Object keys are derived from the snapshot's layout; one this server does
  // not understand is refused rather than guessed.
  if (!isSupportedKeyLayout(lineage.keyLayout)) {
    return { unavailable: true, reason: 'This backup was written in a storage format this server version cannot read.' } as const;
  }

  const resolved = await resolveSnapshotProviderConfig(snapshotDbId);
  if (!resolved?.snapshot || !resolved.providerType || !resolved.providerConfig) {
    return { unavailable: true, reason: 'Recovery snapshot storage is unavailable.' } as const;
  }

  // #6490: resolveSnapshotProviderConfig prefers the LIVE backup_configs row
  // over snapshot-pinned metadata, so a destination changed after this
  // snapshot was written would stream every key — own-prefix or external —
  // from the wrong bucket/root. Authenticate/exchange already refuse that
  // drift up front (negotiateRecoveryCapabilities); this re-checks on every
  // object because the destination can change mid-session. A legacy
  // snapshot with no pinned identity (NULL) has nothing to compare against;
  // an empty string is not "no identity" and fails closed.
  const pinnedStorageIdentity = resolved.snapshot.storageIdentity ?? null;
  if (pinnedStorageIdentity !== null) {
    const resolvedStorageIdentity = normalizeStorageIdentity(resolved.providerType, asRecord(resolved.providerConfig));
    if (resolvedStorageIdentity !== pinnedStorageIdentity) {
      console.warn(
        `[getAuthenticatedRecoveryDownloadTarget] refused token ${tokenRow.id}: storage identity drift`,
        { tokenId: tokenRow.id, snapshotDbId, pinnedStorageIdentity, resolvedStorageIdentity },
      );
      return { unavailable: true, reason: RECOVERY_REFUSAL_MESSAGES.storage_identity_drift } as const;
    }
  }

  const ownSnapshotId = resolved.snapshot.snapshotId;
  // No leading-slash stripping: the shared object-key contract
  // (`agent/internal/backup/bmr/testdata/object-key-vectors.json`) treats a
  // leading slash as invalid, not as a `snapshots/...`-scoped key to be
  // silently rewritten into scope. Stripping it here previously let a
  // `/snapshots/a/x` request from an odd client normalize into a valid own-
  // prefix key instead of being refused.
  const scope = classifyBackupObjectKey(String(remotePath || ''), ownSnapshotId);
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
      tokenId: tokenRow.id,
      snapshotDbId,
      key: scope.key,
      originSnapshotId: scope.originSnapshotId,
      orgId: tokenRow.orgId,
      deviceId: tokenRow.deviceId,
      pinnedStorageIdentity: pinnedStorageIdentity ?? '',
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
    const key = deriveRemoteStorageKey(normalizedRemotePath, snapshotMetadata, originStoragePrefix);
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
    const fileName = normalizedRemotePath.split('/').pop() || 'recovery-object';
    const contentType = normalizedRemotePath.endsWith('.json') ? 'application/json' : 'application/octet-stream';

    // #6489: agent/internal/backup/providers/local.go gzip-compresses on
    // Upload and gunzips again on Download, keyed purely off a `.gz` key
    // suffix — S3 keys, by contrast, hold raw bytes even when the recorded
    // key ends in `.gz` (W09 plan Part 0, "never add or strip .gz": the
    // suffix is just part of the manifest-recorded key there). Token-mode
    // recovery reads local-provider storage directly rather than through the
    // agent, so without mirroring the agent's gunzip here a bare-metal
    // recovery against a local backend would count compressed bytes as
    // "restored" bytes. Decision recorded on the issue: the SERVER gunzips.
    // The decompressed length isn't knowable without decompressing the
    // object, so this branch deliberately omits a fixed Content-Length and
    // streams instead (see the route handler in routes/backup/bmr.ts, which
    // only sets the header when contentLength is non-null).
    if (normalizedRemotePath.endsWith('.gz')) {
      const rawStream = createReadStream(filePath);
      const gunzip = createGunzip();
      // `pipeline` (not a bare `.pipe()`) so a failure on EITHER side closes
      // the other: a corrupt/truncated gzip payload destroys `gunzip` but
      // `.pipe()` alone never destroys its *source* in response, which would
      // otherwise leak the open file descriptor from `createReadStream`
      // until GC finalization — the exact case the "corrupt gzip" test
      // below exercises. The callback below only needs to swallow the
      // already-consumer-visible error (surfaced via `gunzip`'s own 'error'
      // event, forwarded by the route handler's ReadableStream), not
      // re-report it.
      pipeline(rawStream, gunzip, () => {});
      return {
        unavailable: false,
        type: 'stream' as const,
        fileName,
        contentLength: null,
        contentType,
        stream: gunzip,
      };
    }

    return {
      unavailable: false,
      type: 'stream' as const,
      fileName,
      contentLength: fileInfo.size,
      contentType,
      stream: createReadStream(filePath),
    };
  }

  return {
    unavailable: true,
    reason: `Snapshot downloads are not supported for provider ${resolved.providerType}.`,
  } as const;
}
