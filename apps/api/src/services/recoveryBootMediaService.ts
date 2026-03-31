import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { and, desc, eq } from 'drizzle-orm';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { db } from '../db';
import { recoveryBootMediaArtifacts, recoveryMediaArtifacts, recoveryTokens } from '../db/schema';
import { asRecord } from './recoveryBootstrap';
import {
  buildS3Client,
  downloadRecoveryArtifactFile,
  normalizeRecoveryMediaStatus,
  resolveRecoveryArtifactStorage,
  toRecoveryMediaSigningDetails,
  uploadRecoveryArtifactFile,
} from './recoveryMediaService';
import { isRecoverySigningConfigured, signRecoveryArtifact } from './recoverySigning';

const execFileAsync = promisify(execFile);

function getBootMediaFileName(platform: string, architecture: string, mediaType: string) {
  return `breeze-recovery-${platform}-${architecture}.${mediaType}`;
}

function getBootMediaChecksumFileName() {
  return 'CHECKSUM.txt';
}

function createSha256(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function getIsoBuilderBinary() {
  return process.env.RECOVERY_BOOT_MEDIA_ISO_BIN?.trim() || 'xorriso';
}

async function buildIsoImage(sourceDir: string, outputPath: string) {
  const builder = getIsoBuilderBinary();
  const args =
    builder.includes('xorriso')
      ? ['-as', 'mkisofs', '-o', outputPath, sourceDir]
      : ['-o', outputPath, sourceDir];
  await execFileAsync(builder, args);
}

async function resolveBundleArtifact(orgId: string, tokenId: string, bundleArtifactId?: string) {
  if (bundleArtifactId) {
    const [artifact] = await db
      .select()
      .from(recoveryMediaArtifacts)
      .where(
        and(
          eq(recoveryMediaArtifacts.id, bundleArtifactId),
          eq(recoveryMediaArtifacts.orgId, orgId),
          eq(recoveryMediaArtifacts.tokenId, tokenId)
        )
      )
      .limit(1);
    return artifact ?? null;
  }

  const [artifact] = await db
    .select()
    .from(recoveryMediaArtifacts)
    .where(
      and(
        eq(recoveryMediaArtifacts.orgId, orgId),
        eq(recoveryMediaArtifacts.tokenId, tokenId),
        eq(recoveryMediaArtifacts.platform, 'linux'),
        eq(recoveryMediaArtifacts.architecture, 'amd64')
      )
    )
    .orderBy(desc(recoveryMediaArtifacts.createdAt))
    .limit(1);
  return artifact ?? null;
}

export async function buildRecoveryBootMediaArtifact(artifactId: string) {
  const [artifact] = await db
    .select()
    .from(recoveryBootMediaArtifacts)
    .where(eq(recoveryBootMediaArtifacts.id, artifactId))
    .limit(1);
  if (!artifact) {
    throw new Error(`Recovery boot media artifact ${artifactId} not found`);
  }

  const [token] = await db
    .select()
    .from(recoveryTokens)
    .where(eq(recoveryTokens.id, artifact.tokenId))
    .limit(1);
  if (!token) {
    throw new Error(`Recovery token ${artifact.tokenId} not found`);
  }

  const [bundleArtifact] = await db
    .select()
    .from(recoveryMediaArtifacts)
    .where(eq(recoveryMediaArtifacts.id, artifact.bundleArtifactId))
    .limit(1);
  if (!bundleArtifact) {
    throw new Error(`Recovery bundle artifact ${artifact.bundleArtifactId} not found`);
  }
  if (normalizeRecoveryMediaStatus(bundleArtifact) !== 'ready_signed') {
    throw new Error('Boot media requires a signed recovery bundle');
  }
  if (!isRecoverySigningConfigured()) {
    throw new Error('Boot media signing is not configured');
  }

  await db.update(recoveryBootMediaArtifacts).set({ status: 'building' }).where(eq(recoveryBootMediaArtifacts.id, artifact.id));

  const baseTemplateDir = process.env.RECOVERY_BOOT_MEDIA_BASE_DIR?.trim();
  if (!baseTemplateDir) {
    throw new Error('RECOVERY_BOOT_MEDIA_BASE_DIR must be configured for bootable ISO generation');
  }

  const workingDir = await mkdtemp(join(tmpdir(), 'recovery-boot-media-'));
  try {
    const imageRoot = join(workingDir, 'iso-root');
    await cp(baseTemplateDir, imageRoot, { recursive: true });
    const payloadDir = join(imageRoot, 'breeze-recovery');
    await mkdir(payloadDir, { recursive: true });

    const bundleFileName = basename(bundleArtifact.storageKey || `bundle-${bundleArtifact.id}.tar.gz`);
    const localBundlePath = join(payloadDir, bundleFileName);
    const bundleStorage = await resolveRecoveryArtifactStorage(
      artifact.snapshotId,
      'recovery-media',
      bundleArtifact.id,
      bundleFileName
    );
    await downloadRecoveryArtifactFile(bundleStorage, localBundlePath);

    if (bundleArtifact.signatureStorageKey) {
      const localSignaturePath = join(payloadDir, basename(bundleArtifact.signatureStorageKey));
      const signatureStorage = await resolveRecoveryArtifactStorage(
        artifact.snapshotId,
        'recovery-media',
        bundleArtifact.id,
        basename(bundleArtifact.signatureStorageKey)
      );
      await downloadRecoveryArtifactFile(signatureStorage, localSignaturePath);
    }

    if (bundleArtifact.checksumStorageKey) {
      const localChecksumPath = join(payloadDir, basename(bundleArtifact.checksumStorageKey));
      const checksumStorage = await resolveRecoveryArtifactStorage(
        artifact.snapshotId,
        'recovery-media',
        bundleArtifact.id,
        basename(bundleArtifact.checksumStorageKey)
      );
      await downloadRecoveryArtifactFile(checksumStorage, localChecksumPath);
    }

    await writeFile(
      join(payloadDir, 'README.txt'),
      [
        'Breeze Bootable Recovery Media',
        '',
        `Token ID: ${token.id}`,
        `Bundle artifact ID: ${bundleArtifact.id}`,
        'Enter the plaintext recovery token after boot to start recovery.',
      ].join('\n')
    );

    const isoFileName = getBootMediaFileName(artifact.platform, artifact.architecture, artifact.mediaType);
    const isoPath = join(workingDir, isoFileName);
    await buildIsoImage(imageRoot, isoPath);

    const isoChecksum = createSha256(await readFile(isoPath));
    const checksumPath = join(workingDir, getBootMediaChecksumFileName());
    await writeFile(checksumPath, `${isoChecksum}  ${isoFileName}\n`);

    const signature = await signRecoveryArtifact(isoPath, `Breeze boot media ${artifact.id}`);
    const storage = await resolveRecoveryArtifactStorage(
      artifact.snapshotId,
      'recovery-boot-media',
      artifact.id,
      isoFileName
    );
    await uploadRecoveryArtifactFile(storage, isoPath, 'application/x-iso9660-image');

    const checksumStorage = await resolveRecoveryArtifactStorage(
      artifact.snapshotId,
      'recovery-boot-media',
      artifact.id,
      getBootMediaChecksumFileName()
    );
    await uploadRecoveryArtifactFile(checksumStorage, checksumPath, 'text/plain; charset=utf-8');

    const signatureStorage = await resolveRecoveryArtifactStorage(
      artifact.snapshotId,
      'recovery-boot-media',
      artifact.id,
      `${isoFileName}.minisig`
    );
    await uploadRecoveryArtifactFile(signatureStorage, signature.signaturePath, 'application/octet-stream');

    await db
      .update(recoveryBootMediaArtifacts)
      .set({
        status: 'ready_signed',
        storageKey: storage.storageKey,
        checksumSha256: isoChecksum,
        checksumStorageKey: checksumStorage.storageKey,
        signatureFormat: signature.format,
        signatureStorageKey: signatureStorage.storageKey,
        signingKeyId: signature.keyId,
        signedAt: new Date(),
        metadata: {
          ...asRecord(artifact.metadata),
          sourceBundleArtifactId: bundleArtifact.id,
          isoFileName,
        },
        completedAt: new Date(),
      })
      .where(eq(recoveryBootMediaArtifacts.id, artifact.id));
  } catch (error) {
    await db
      .update(recoveryBootMediaArtifacts)
      .set({
        status: 'failed',
        metadata: {
          ...asRecord(artifact.metadata),
          error: error instanceof Error ? error.message : String(error),
        },
        completedAt: new Date(),
      })
      .where(eq(recoveryBootMediaArtifacts.id, artifact.id));
    throw error;
  } finally {
    await rm(workingDir, { recursive: true, force: true });
  }
}

export async function listRecoveryBootMediaArtifacts(orgId: string, filters: {
  tokenId?: string;
  snapshotId?: string;
  status?: string;
  limit: number;
  offset: number;
}) {
  return db
    .select({
      id: recoveryBootMediaArtifacts.id,
      orgId: recoveryBootMediaArtifacts.orgId,
      tokenId: recoveryBootMediaArtifacts.tokenId,
      snapshotId: recoveryBootMediaArtifacts.snapshotId,
      bundleArtifactId: recoveryBootMediaArtifacts.bundleArtifactId,
      platform: recoveryBootMediaArtifacts.platform,
      architecture: recoveryBootMediaArtifacts.architecture,
      mediaType: recoveryBootMediaArtifacts.mediaType,
      status: recoveryBootMediaArtifacts.status,
      storageKey: recoveryBootMediaArtifacts.storageKey,
      checksumSha256: recoveryBootMediaArtifacts.checksumSha256,
      checksumStorageKey: recoveryBootMediaArtifacts.checksumStorageKey,
      signatureFormat: recoveryBootMediaArtifacts.signatureFormat,
      signatureStorageKey: recoveryBootMediaArtifacts.signatureStorageKey,
      signingKeyId: recoveryBootMediaArtifacts.signingKeyId,
      metadata: recoveryBootMediaArtifacts.metadata,
      createdAt: recoveryBootMediaArtifacts.createdAt,
      signedAt: recoveryBootMediaArtifacts.signedAt,
      completedAt: recoveryBootMediaArtifacts.completedAt,
      tokenStatus: recoveryTokens.status,
    })
    .from(recoveryBootMediaArtifacts)
    .innerJoin(recoveryTokens, eq(recoveryBootMediaArtifacts.tokenId, recoveryTokens.id))
    .where(
      and(
        eq(recoveryBootMediaArtifacts.orgId, orgId),
        filters.tokenId ? eq(recoveryBootMediaArtifacts.tokenId, filters.tokenId) : undefined,
        filters.snapshotId ? eq(recoveryBootMediaArtifacts.snapshotId, filters.snapshotId) : undefined,
        filters.status ? eq(recoveryBootMediaArtifacts.status, filters.status as never) : undefined
      )
    )
    .orderBy(desc(recoveryBootMediaArtifacts.createdAt))
    .limit(filters.limit)
    .offset(filters.offset);
}

export async function getRecoveryBootMediaArtifact(orgId: string, artifactId: string) {
  const rows = await db
    .select({
      id: recoveryBootMediaArtifacts.id,
      orgId: recoveryBootMediaArtifacts.orgId,
      tokenId: recoveryBootMediaArtifacts.tokenId,
      snapshotId: recoveryBootMediaArtifacts.snapshotId,
      bundleArtifactId: recoveryBootMediaArtifacts.bundleArtifactId,
      platform: recoveryBootMediaArtifacts.platform,
      architecture: recoveryBootMediaArtifacts.architecture,
      mediaType: recoveryBootMediaArtifacts.mediaType,
      status: recoveryBootMediaArtifacts.status,
      storageKey: recoveryBootMediaArtifacts.storageKey,
      checksumSha256: recoveryBootMediaArtifacts.checksumSha256,
      checksumStorageKey: recoveryBootMediaArtifacts.checksumStorageKey,
      signatureFormat: recoveryBootMediaArtifacts.signatureFormat,
      signatureStorageKey: recoveryBootMediaArtifacts.signatureStorageKey,
      signingKeyId: recoveryBootMediaArtifacts.signingKeyId,
      metadata: recoveryBootMediaArtifacts.metadata,
      createdAt: recoveryBootMediaArtifacts.createdAt,
      signedAt: recoveryBootMediaArtifacts.signedAt,
      completedAt: recoveryBootMediaArtifacts.completedAt,
      tokenStatus: recoveryTokens.status,
    })
    .from(recoveryBootMediaArtifacts)
    .innerJoin(recoveryTokens, eq(recoveryBootMediaArtifacts.tokenId, recoveryTokens.id))
    .where(and(eq(recoveryBootMediaArtifacts.id, artifactId), eq(recoveryBootMediaArtifacts.orgId, orgId)))
    .limit(1);
  return rows[0] ?? null;
}

export function toRecoveryBootMediaSigningDetails(row: {
  signatureFormat?: string | null;
  signingKeyId?: string | null;
  signedAt?: Date | null;
}) {
  return toRecoveryMediaSigningDetails(row);
}

export async function getRecoveryBootMediaDownloadTarget(orgId: string, artifactId: string, kind: 'artifact' | 'signature' = 'artifact') {
  const artifact = await getRecoveryBootMediaArtifact(orgId, artifactId);
  if (!artifact) return null;
  if (artifact.status !== 'ready_signed' || artifact.tokenStatus === 'revoked' || artifact.tokenStatus === 'expired' || artifact.tokenStatus === 'used') {
    return { artifact, unavailable: true } as const;
  }

  const fileName =
    kind === 'signature'
      ? `${getBootMediaFileName(artifact.platform, artifact.architecture, artifact.mediaType)}.minisig`
      : getBootMediaFileName(artifact.platform, artifact.architecture, artifact.mediaType);
  const storage = await resolveRecoveryArtifactStorage(
    artifact.snapshotId,
    'recovery-boot-media',
    artifact.id,
    fileName
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

export async function createRecoveryBootMediaRequest(args: {
  orgId: string;
  tokenId: string;
  createdBy?: string | null;
  bundleArtifactId?: string | null;
}) {
  const bundleArtifact = await resolveBundleArtifact(args.orgId, args.tokenId, args.bundleArtifactId ?? undefined);
  if (!bundleArtifact) {
    throw new Error('A signed linux/amd64 recovery bundle is required before building boot media');
  }
  if (normalizeRecoveryMediaStatus(bundleArtifact) !== 'ready_signed') {
    throw new Error('Boot media requires a signed linux/amd64 recovery bundle');
  }

  const [existing] = await db
    .select()
    .from(recoveryBootMediaArtifacts)
    .where(
      and(
        eq(recoveryBootMediaArtifacts.tokenId, args.tokenId),
        eq(recoveryBootMediaArtifacts.platform, 'linux'),
        eq(recoveryBootMediaArtifacts.architecture, 'amd64'),
        eq(recoveryBootMediaArtifacts.mediaType, 'iso')
      )
    )
    .limit(1);

  if (existing && ['pending', 'building', 'ready_signed'].includes(existing.status)) {
    return existing;
  }

  if (existing) {
    const [reset] = await db
      .update(recoveryBootMediaArtifacts)
      .set({
        bundleArtifactId: bundleArtifact.id,
        status: 'pending',
        storageKey: null,
        checksumSha256: null,
        checksumStorageKey: null,
        signatureFormat: null,
        signatureStorageKey: null,
        signingKeyId: null,
        signedAt: null,
        completedAt: null,
        metadata: {
          ...asRecord(existing.metadata),
          restartedAt: new Date().toISOString(),
        },
      })
      .where(eq(recoveryBootMediaArtifacts.id, existing.id))
      .returning();
    return reset!;
  }

  const [row] = await db
    .insert(recoveryBootMediaArtifacts)
    .values({
      orgId: args.orgId,
      tokenId: args.tokenId,
      snapshotId: bundleArtifact.snapshotId,
      bundleArtifactId: bundleArtifact.id,
      platform: 'linux',
      architecture: 'amd64',
      mediaType: 'iso',
      status: 'pending',
      createdBy: args.createdBy ?? null,
      metadata: {
        requestedAt: new Date().toISOString(),
      },
    })
    .returning();

  return row!;
}
