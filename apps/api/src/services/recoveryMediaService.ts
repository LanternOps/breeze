import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { recoveryMediaArtifacts, recoveryTokens } from '../db/schema';
import {
  asRecord,
  getStringValue,
  resolveServerUrl,
  resolveSnapshotProviderConfig,
} from './recoveryBootstrap';
import { verifyBinaryChecksum } from './binaryManifest';
import { getBinarySource, getGithubBackupUrl, getGithubReleaseVersion } from './binarySource';
import { getRecoverySigningKey, isRecoverySigningConfigured, signRecoveryArtifact } from './recoverySigning';

const execFileAsync = promisify(execFile);

export type RecoveryMediaStorageConfig =
  | {
      provider: 'local';
      rootPath: string;
      storageKey: string;
      downloadFilename: string;
    }
  | {
      provider: 's3';
      bucket: string;
      region: string;
      endpoint?: string;
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
      storageKey: string;
      downloadFilename: string;
    };

function getArchiveFileName(platform: string, architecture: string): string {
  return `breeze-recovery-bundle-${platform}-${architecture}.tar.gz`;
}

function getBundleChecksumFileName() {
  return 'CHECKSUM.txt';
}

function getBinaryFileName(platform: string, architecture: string): string {
  const extension = platform === 'windows' ? '.exe' : '';
  return `breeze-backup-${platform}-${architecture}${extension}`;
}

function buildStorageKey(namespace: string, artifactId: string, fileName: string, prefix?: string | null): string {
  const normalizedPrefix = (prefix ?? '').trim().replace(/^\/+|\/+$/g, '');
  const base = `${namespace}/${artifactId}/${fileName}`;
  return normalizedPrefix ? `${normalizedPrefix}/${base}` : base;
}

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function downloadFile(url: string, destinationPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed with status ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  await writeFile(destinationPath, Buffer.from(arrayBuffer));
}

async function resolveBackupBinary(platform: string, architecture: string, workingDir: string): Promise<{
  fileName: string;
  filePath: string;
  verified: Awaited<ReturnType<typeof verifyBinaryChecksum>>;
}> {
  const fileName = getBinaryFileName(platform, architecture);
  const destinationPath = join(workingDir, fileName);
  const sourceType = getBinarySource();
  let sourceRef: string;
  let version: string;

  if (sourceType === 'github') {
    version = getGithubReleaseVersion();
    if (version === 'latest') {
      throw new Error('Recovery helper builds require a pinned GitHub release version, not "latest"');
    }
    sourceRef = `github-release:v${version}`;
    await downloadFile(getGithubBackupUrl(platform, architecture), destinationPath);
  } else {
    const candidatePath = resolve(
      process.env.BACKUP_BINARY_DIR ||
        process.env.AGENT_BINARY_DIR ||
        './agent/bin',
      fileName
    );
    sourceRef = candidatePath;
    version = process.env.BINARY_VERSION || process.env.BREEZE_VERSION || 'workspace-local';
    await copyFile(candidatePath, destinationPath);
  }

  const verified = await verifyBinaryChecksum({
    filePath: destinationPath,
    platform,
    architecture,
    sourceType,
    sourceRef,
    version,
  });
  return { fileName, filePath: destinationPath, verified };
}

function buildBundleReadme(args: {
  platform: string;
  architecture: string;
  serverUrl: string;
  tokenId: string;
  snapshotId: string;
  restoreType: string;
  fileName: string;
}) {
  const launchCommand =
    args.platform === 'windows'
      ? `powershell -ExecutionPolicy Bypass -File .\\run-recovery.ps1 -RecoveryToken <recovery-token>`
      : `RECOVERY_TOKEN=<recovery-token> ./run-recovery.sh`;

  return [
    'Breeze Recovery Bundle',
    '',
    `Platform: ${args.platform}/${args.architecture}`,
    `Server URL: ${args.serverUrl}`,
    `Recovery token ID: ${args.tokenId}`,
    `Snapshot ID: ${args.snapshotId}`,
    `Restore type: ${args.restoreType}`,
    '',
    'This bundle does not store the plaintext recovery token.',
    'Use the recovery token shown when the token was created, then run:',
    `  ${launchCommand}`,
    '',
    'Prerequisites:',
    '- Boot into a compatible recovery environment.',
    '- Ensure the environment can reach the Breeze server and backup storage.',
    '- Provide any required network or storage drivers for the target hardware.',
    '',
    `Included helper binary: ${args.fileName}`,
  ].join('\n');
}

function buildLaunchScript(args: {
  platform: string;
  fileName: string;
  serverUrl: string;
}) {
  if (args.platform === 'windows') {
    return {
      fileName: 'run-recovery.ps1',
      content: [
        'param(',
        '  [Parameter(Mandatory = $true)]',
        '  [string]$RecoveryToken',
        ')',
        '$ErrorActionPreference = "Stop"',
        '$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path',
        `$binary = Join-Path $scriptDir "${args.fileName}"`,
        `& $binary bmr-recover --token $RecoveryToken --server "${args.serverUrl}"`,
      ].join('\n'),
    };
  }

  return {
    fileName: 'run-recovery.sh',
    content: [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'TOKEN="${RECOVERY_TOKEN:-${1:-}}"',
      'if [ -z "$TOKEN" ]; then',
      '  echo "Set RECOVERY_TOKEN or pass the recovery token as the first argument." >&2',
      '  exit 1',
      'fi',
      'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      `"$SCRIPT_DIR/${args.fileName}" bmr-recover --token "$TOKEN" --server "${args.serverUrl}"`,
    ].join('\n'),
  };
}

async function createBundleArchive(bundleDir: string, archivePath: string): Promise<void> {
  await execFileAsync('tar', ['-czf', archivePath, '-C', bundleDir, '.']);
}

export function buildS3Client(config: Extract<RecoveryMediaStorageConfig, { provider: 's3' }>) {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: Boolean(config.endpoint),
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken,
    },
  });
}

export async function resolveRecoveryArtifactStorage(
  snapshotDbId: string,
  namespace: string,
  artifactId: string,
  fileName: string
): Promise<RecoveryMediaStorageConfig> {
  const resolved = await resolveSnapshotProviderConfig(snapshotDbId);
  if (!resolved?.providerType || !resolved.providerConfig) {
    throw new Error('Snapshot is missing provider-backed storage configuration');
  }

  const providerConfig = asRecord(resolved.providerConfig);

  if (resolved.providerType === 'local') {
    const rootPath = getStringValue(providerConfig, 'path') || getStringValue(providerConfig, 'basePath');
    if (!rootPath) {
      throw new Error('Local backup provider path is missing');
    }
    return {
      provider: 'local',
      rootPath,
      storageKey: buildStorageKey(namespace, artifactId, fileName),
      downloadFilename: fileName,
    };
  }

  if (resolved.providerType === 's3') {
    const bucket = getStringValue(providerConfig, 'bucket') || getStringValue(providerConfig, 'bucketName');
    const region = getStringValue(providerConfig, 'region');
    const accessKeyId = getStringValue(providerConfig, 'accessKey') || getStringValue(providerConfig, 'accessKeyId');
    const secretAccessKey = getStringValue(providerConfig, 'secretKey') || getStringValue(providerConfig, 'secretAccessKey');
    if (!bucket || !region || !accessKeyId || !secretAccessKey) {
      throw new Error('S3 backup provider credentials are incomplete');
    }
    return {
      provider: 's3',
      bucket,
      region,
      endpoint: getStringValue(providerConfig, 'endpoint') ?? undefined,
      accessKeyId,
      secretAccessKey,
      sessionToken: getStringValue(providerConfig, 'sessionToken') ?? undefined,
      storageKey: buildStorageKey(
        namespace,
        artifactId,
        fileName,
        getStringValue(providerConfig, 'prefix')
      ),
      downloadFilename: fileName,
    };
  }

  throw new Error(`Recovery bundle storage is not supported for provider ${resolved.providerType}`);
}

export async function resolveRecoveryMediaStorage(snapshotDbId: string, artifactId: string, platform: string, architecture: string): Promise<RecoveryMediaStorageConfig> {
  return resolveRecoveryArtifactStorage(
    snapshotDbId,
    'recovery-media',
    artifactId,
    getArchiveFileName(platform, architecture)
  );
}

export async function uploadRecoveryArtifactFile(
  storage: RecoveryMediaStorageConfig,
  filePath: string,
  contentType = 'application/octet-stream'
): Promise<void> {
  if (storage.provider === 'local') {
    const destinationPath = resolve(storage.rootPath, storage.storageKey);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(filePath, destinationPath);
    return;
  }

  const client = buildS3Client(storage);
  const body = await readFile(filePath);
  await client.send(
    new PutObjectCommand({
      Bucket: storage.bucket,
      Key: storage.storageKey,
      Body: body,
      ContentType: contentType,
      ContentDisposition: `attachment; filename="${storage.downloadFilename}"`,
    })
  );
}

export async function downloadRecoveryArtifactFile(storage: RecoveryMediaStorageConfig, destinationPath: string) {
  if (storage.provider === 'local') {
    const sourcePath = resolve(storage.rootPath, storage.storageKey);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
    return;
  }

  const client = buildS3Client(storage);
  const response = await client.send(
    new GetObjectCommand({
      Bucket: storage.bucket,
      Key: storage.storageKey,
    })
  );
  if (!response.Body) {
    throw new Error('Recovery artifact download returned an empty body');
  }
  await mkdir(dirname(destinationPath), { recursive: true });
  const bytes = Buffer.from(await response.Body.transformToByteArray());
  await writeFile(destinationPath, bytes);
}

function normalizeRecoveryMediaStatus(row: {
  status: string;
  signatureStorageKey?: string | null;
  tokenStatus?: string | null;
}) {
  if (row.tokenStatus === 'revoked' || row.tokenStatus === 'expired' || row.tokenStatus === 'used') {
    return 'expired';
  }
  if (row.status === 'ready' && !row.signatureStorageKey) {
    return 'legacy_unsigned';
  }
  if (row.status === 'ready' && row.signatureStorageKey) {
    return 'ready_signed';
  }
  return row.status;
}

export async function buildRecoveryMediaArtifact(artifactId: string, requestUrl?: string): Promise<void> {
  const [artifact] = await db
    .select()
    .from(recoveryMediaArtifacts)
    .where(eq(recoveryMediaArtifacts.id, artifactId))
    .limit(1);

  if (!artifact) {
    throw new Error(`Recovery media artifact ${artifactId} not found`);
  }

  const [token] = await db
    .select()
    .from(recoveryTokens)
    .where(eq(recoveryTokens.id, artifact.tokenId))
    .limit(1);

  if (!token) {
    throw new Error(`Recovery token ${artifact.tokenId} not found`);
  }

  if (token.status === 'revoked' || token.status === 'expired' || token.status === 'used') {
    await db
      .update(recoveryMediaArtifacts)
      .set({
        status: 'expired',
        completedAt: new Date(),
        metadata: {
          ...asRecord(artifact.metadata),
          error: `Recovery token is ${token.status}`,
        },
      })
      .where(eq(recoveryMediaArtifacts.id, artifact.id));
    return;
  }

  await db
    .update(recoveryMediaArtifacts)
    .set({ status: 'building' })
    .where(eq(recoveryMediaArtifacts.id, artifact.id));

  const workingDir = await mkdtemp(join(tmpdir(), 'bmr-bundle-'));
  try {
    const bundleDir = join(workingDir, 'bundle');
    await mkdir(bundleDir, { recursive: true });

    const binary = await resolveBackupBinary(artifact.platform, artifact.architecture, workingDir);
    const binaryTargetPath = join(bundleDir, artifact.platform === 'windows' ? 'breeze-backup.exe' : 'breeze-backup');
    await copyFile(binary.filePath, binaryTargetPath);

    const serverUrl = resolveServerUrl(requestUrl);
    const launchScript = buildLaunchScript({
      platform: artifact.platform,
      fileName: artifact.platform === 'windows' ? 'breeze-backup.exe' : 'breeze-backup',
      serverUrl,
    });

    const readme = buildBundleReadme({
      platform: artifact.platform,
      architecture: artifact.architecture,
      serverUrl,
      tokenId: token.id,
      snapshotId: token.snapshotId,
      restoreType: token.restoreType,
      fileName: binary.fileName,
    });

    const bootstrapConfig = {
      version: 1,
      tokenId: token.id,
      snapshotId: token.snapshotId,
      restoreType: token.restoreType,
      serverUrl,
      notes: 'Provide the plaintext recovery token when running the helper.',
    };

    await writeFile(join(bundleDir, launchScript.fileName), launchScript.content, { mode: 0o755 });
    await writeFile(join(bundleDir, 'README.txt'), readme);
    await writeFile(join(bundleDir, 'bootstrap.json'), JSON.stringify(bootstrapConfig, null, 2));

    const binaryChecksum = sha256Hex(await readFile(binaryTargetPath));
    await writeFile(
      join(bundleDir, 'CHECKSUM.txt'),
      `${binaryChecksum}  ${artifact.platform === 'windows' ? 'breeze-backup.exe' : 'breeze-backup'}\n`
    );

    const archivePath = join(workingDir, getArchiveFileName(artifact.platform, artifact.architecture));
    await createBundleArchive(bundleDir, archivePath);
    const archiveBuffer = await readFile(archivePath);
    const archiveChecksum = sha256Hex(archiveBuffer);
    const checksumPath = join(workingDir, getBundleChecksumFileName());
    await writeFile(
      checksumPath,
      `${archiveChecksum}  ${getArchiveFileName(artifact.platform, artifact.architecture)}\n`
    );

    const storage = await resolveRecoveryMediaStorage(
      artifact.snapshotId,
      artifact.id,
      artifact.platform,
      artifact.architecture
    );
    await uploadRecoveryArtifactFile(storage, archivePath, 'application/gzip');

    let normalizedStatus: string = 'legacy_unsigned';
    let signatureFormat: string | null = null;
    let signatureStorageKey: string | null = null;
    let signingKeyId: string | null = null;
    let signedAt: Date | null = null;

    const checksumStorage = await resolveRecoveryArtifactStorage(
      artifact.snapshotId,
      'recovery-media',
      artifact.id,
      getBundleChecksumFileName()
    );
    await uploadRecoveryArtifactFile(checksumStorage, checksumPath, 'text/plain; charset=utf-8');

    if (isRecoverySigningConfigured()) {
      const signature = await signRecoveryArtifact(
        archivePath,
        `Breeze recovery bundle ${artifact.id}`
      );
      const signatureStorage = await resolveRecoveryArtifactStorage(
        artifact.snapshotId,
        'recovery-media',
        artifact.id,
        `${getArchiveFileName(artifact.platform, artifact.architecture)}.minisig`
      );
      await uploadRecoveryArtifactFile(signatureStorage, signature.signaturePath, 'application/octet-stream');
      normalizedStatus = 'ready';
      signatureFormat = signature.format;
      signatureStorageKey = signatureStorage.storageKey;
      signingKeyId = signature.keyId;
      signedAt = new Date();
    }

    await db
      .update(recoveryMediaArtifacts)
      .set({
        status: normalizedStatus,
        storageKey: storage.storageKey,
        checksumSha256: archiveChecksum,
        checksumStorageKey: checksumStorage.storageKey,
        signatureFormat,
        signatureStorageKey,
        signingKeyId,
        signedAt,
        metadata: {
          ...asRecord(artifact.metadata),
          storageProvider: storage.provider,
          downloadFilename: storage.downloadFilename,
          releaseSource: getBinarySource(),
          bundleFiles: [
            launchScript.fileName,
            'README.txt',
            'bootstrap.json',
            'CHECKSUM.txt',
            artifact.platform === 'windows' ? 'breeze-backup.exe' : 'breeze-backup',
          ],
          bundleBinaryChecksum: binaryChecksum,
          helperBinaryVersion: binary.verified.version,
          helperBinaryDigestVerified: true,
          helperBinarySourceType: binary.verified.sourceType,
          helperBinarySourceRef:
            binary.verified.sourceType === 'local'
              ? binary.verified.sourceRef.replace(`${process.cwd()}/`, '')
              : binary.verified.sourceRef,
          helperBinaryManifestVersion: binary.verified.manifestVersion,
          serverUrl,
          signingConfigured: isRecoverySigningConfigured(),
        },
        completedAt: new Date(),
      })
      .where(eq(recoveryMediaArtifacts.id, artifact.id));
  } catch (error) {
    await db
      .update(recoveryMediaArtifacts)
      .set({
        status: 'failed',
        metadata: {
          ...asRecord(artifact.metadata),
          error: error instanceof Error ? error.message : String(error),
        },
        completedAt: new Date(),
      })
      .where(eq(recoveryMediaArtifacts.id, artifact.id));
    throw error;
  } finally {
    await rm(workingDir, { recursive: true, force: true });
  }
}

export async function getRecoveryMediaArtifact(orgId: string, artifactId: string) {
  const [row] = await db
    .select({
      id: recoveryMediaArtifacts.id,
      orgId: recoveryMediaArtifacts.orgId,
      tokenId: recoveryMediaArtifacts.tokenId,
      snapshotId: recoveryMediaArtifacts.snapshotId,
      platform: recoveryMediaArtifacts.platform,
      architecture: recoveryMediaArtifacts.architecture,
      status: recoveryMediaArtifacts.status,
      storageKey: recoveryMediaArtifacts.storageKey,
      checksumSha256: recoveryMediaArtifacts.checksumSha256,
      checksumStorageKey: recoveryMediaArtifacts.checksumStorageKey,
      signatureFormat: recoveryMediaArtifacts.signatureFormat,
      signatureStorageKey: recoveryMediaArtifacts.signatureStorageKey,
      signingKeyId: recoveryMediaArtifacts.signingKeyId,
      metadata: recoveryMediaArtifacts.metadata,
      createdAt: recoveryMediaArtifacts.createdAt,
      signedAt: recoveryMediaArtifacts.signedAt,
      completedAt: recoveryMediaArtifacts.completedAt,
      tokenStatus: recoveryTokens.status,
      tokenExpiresAt: recoveryTokens.expiresAt,
      tokenCompletedAt: recoveryTokens.completedAt,
    })
    .from(recoveryMediaArtifacts)
    .innerJoin(recoveryTokens, eq(recoveryMediaArtifacts.tokenId, recoveryTokens.id))
    .where(
      and(
        eq(recoveryMediaArtifacts.id, artifactId),
        eq(recoveryMediaArtifacts.orgId, orgId)
      )
    )
    .limit(1);

  return row ?? null;
}

export async function listRecoveryMediaArtifacts(orgId: string, filters: {
  tokenId?: string;
  snapshotId?: string;
  status?: string;
  limit: number;
  offset: number;
}) {
  const rows = await db
    .select({
      id: recoveryMediaArtifacts.id,
      orgId: recoveryMediaArtifacts.orgId,
      tokenId: recoveryMediaArtifacts.tokenId,
      snapshotId: recoveryMediaArtifacts.snapshotId,
      platform: recoveryMediaArtifacts.platform,
      architecture: recoveryMediaArtifacts.architecture,
      status: recoveryMediaArtifacts.status,
      storageKey: recoveryMediaArtifacts.storageKey,
      checksumSha256: recoveryMediaArtifacts.checksumSha256,
      checksumStorageKey: recoveryMediaArtifacts.checksumStorageKey,
      signatureFormat: recoveryMediaArtifacts.signatureFormat,
      signatureStorageKey: recoveryMediaArtifacts.signatureStorageKey,
      signingKeyId: recoveryMediaArtifacts.signingKeyId,
      metadata: recoveryMediaArtifacts.metadata,
      createdAt: recoveryMediaArtifacts.createdAt,
      signedAt: recoveryMediaArtifacts.signedAt,
      completedAt: recoveryMediaArtifacts.completedAt,
      tokenStatus: recoveryTokens.status,
    })
    .from(recoveryMediaArtifacts)
    .innerJoin(recoveryTokens, eq(recoveryMediaArtifacts.tokenId, recoveryTokens.id))
    .where(
      and(
        eq(recoveryMediaArtifacts.orgId, orgId),
        filters.tokenId ? eq(recoveryMediaArtifacts.tokenId, filters.tokenId) : undefined,
        filters.snapshotId ? eq(recoveryMediaArtifacts.snapshotId, filters.snapshotId) : undefined,
        filters.status ? eq(recoveryMediaArtifacts.status, filters.status as never) : undefined
      )
    )
    .orderBy(desc(recoveryMediaArtifacts.createdAt))
    .limit(filters.limit)
    .offset(filters.offset);

  return rows;
}

export async function getRecoveryMediaDownloadTarget(orgId: string, artifactId: string) {
  const artifact = await getRecoveryMediaArtifact(orgId, artifactId);
  if (!artifact) return null;

  const normalizedStatus = normalizeRecoveryMediaStatus(artifact);
  if ((normalizedStatus !== 'ready_signed' && normalizedStatus !== 'legacy_unsigned') || artifact.tokenStatus === 'revoked' || artifact.tokenStatus === 'expired' || artifact.tokenStatus === 'used') {
    return {
      artifact,
      unavailable: true,
    } as const;
  }

  const storage = await resolveRecoveryMediaStorage(
    artifact.snapshotId,
    artifact.id,
    artifact.platform,
    artifact.architecture
  );

  if (storage.provider === 's3') {
    const client = buildS3Client(storage);
    const url = await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: storage.bucket,
        Key: storage.storageKey,
        ResponseContentDisposition: `attachment; filename="${storage.downloadFilename}"`,
      }),
      { expiresIn: 300 }
    );
    return {
      artifact,
      unavailable: false,
      type: 'redirect' as const,
      url,
    };
  }

  const filePath = resolve(storage.rootPath, storage.storageKey);
  const fileInfo = await stat(filePath);
  return {
    artifact,
    unavailable: false,
    type: 'stream' as const,
    stream: createReadStream(filePath),
    fileName: storage.downloadFilename,
    contentLength: fileInfo.size,
  };
}

export async function getRecoveryMediaSignatureDownloadTarget(orgId: string, artifactId: string) {
  const artifact = await getRecoveryMediaArtifact(orgId, artifactId);
  if (!artifact) return null;
  const normalizedStatus = normalizeRecoveryMediaStatus(artifact);
  if (normalizedStatus !== 'ready_signed' || !artifact.signatureStorageKey) {
    return { artifact, unavailable: true } as const;
  }

  const storage = await resolveRecoveryArtifactStorage(
    artifact.snapshotId,
    'recovery-media',
    artifact.id,
    `${getArchiveFileName(artifact.platform, artifact.architecture)}.minisig`
  );

  if (storage.provider === 's3') {
    const client = buildS3Client(storage);
    const url = await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: storage.bucket,
        Key: storage.storageKey,
        ResponseContentDisposition: `attachment; filename="${storage.downloadFilename}"`,
      }),
      { expiresIn: 300 }
    );
    return { artifact, unavailable: false, type: 'redirect' as const, url };
  }

  const filePath = resolve(storage.rootPath, storage.storageKey);
  const fileInfo = await stat(filePath);
  return {
    artifact,
    unavailable: false,
    type: 'stream' as const,
    stream: createReadStream(filePath),
    fileName: storage.downloadFilename,
    contentLength: fileInfo.size,
  };
}

export function toRecoveryMediaSigningDetails(row: {
  signatureFormat?: string | null;
  signingKeyId?: string | null;
  signedAt?: Date | null;
}) {
  const signingKey = row.signingKeyId ? getRecoverySigningKey(row.signingKeyId) : null;
  return {
    signatureFormat: row.signatureFormat ?? null,
    signingKeyId: row.signingKeyId ?? null,
    signedAt: row.signedAt?.toISOString() ?? null,
    publicKey: signingKey?.publicKey ?? null,
    publicKeyPath: row.signingKeyId
      ? signingKey?.isCurrent
        ? '/api/v1/backup/bmr/signing-key'
        : `/api/v1/backup/bmr/signing-keys/${row.signingKeyId}`
      : null,
  };
}

export { normalizeRecoveryMediaStatus };
