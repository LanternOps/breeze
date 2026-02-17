import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

let s3Client: S3Client | null = null;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function requireBucket(): string {
  return requireEnv('S3_BUCKET');
}

function getS3Client(): S3Client {
  if (!s3Client) {
    const accessKeyId = requireEnv('S3_ACCESS_KEY');
    const secretAccessKey = requireEnv('S3_SECRET_KEY');

    s3Client = new S3Client({
      endpoint: process.env.S3_ENDPOINT || undefined,
      region: process.env.S3_REGION || 'us-east-1',
      credentials: { accessKeyId, secretAccessKey },
      // Required for MinIO and other S3-compatible providers that use path-style URLs
      forcePathStyle: true,
    });
  }
  return s3Client;
}

export function isS3Configured(): boolean {
  return !!(process.env.S3_BUCKET && process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY);
}

async function computeFileChecksum(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  await pipeline(stream, hash);
  return hash.digest('hex');
}

async function getRemoteObjectState(
  bucket: string,
  key: string
): Promise<{ exists: boolean; checksum: string | null; size: number | null }> {
  try {
    const client = getS3Client();
    const resp = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return {
      exists: true,
      checksum: resp.Metadata?.sha256 ?? null,
      size: typeof resp.ContentLength === 'number' ? resp.ContentLength : null,
    };
  } catch (err: unknown) {
    const code = (err as { name?: string }).name;
    if (code === 'NotFound' || code === 'NoSuchKey') {
      return { exists: false, checksum: null, size: null };
    }
    throw err;
  }
}

export async function uploadBinary(localPath: string, s3Key: string, checksum?: string): Promise<void> {
  const bucket = requireBucket();
  const client = getS3Client();
  const body = createReadStream(localPath);
  const stat = statSync(localPath);

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      Body: body,
      ContentLength: stat.size,
      ContentType: 'application/octet-stream',
      Metadata: checksum ? { sha256: checksum } : undefined,
    })
  );
}

export async function getPresignedUrl(s3Key: string, ttlSeconds?: number): Promise<string> {
  const bucket = requireBucket();
  const client = getS3Client();
  const rawTtl = parseInt(process.env.S3_PRESIGN_TTL || '900', 10);
  const ttl = ttlSeconds ?? (Number.isFinite(rawTtl) && rawTtl > 0 ? rawTtl : 900);

  // Presigned URLs are valid even for non-existent keys, so verify first
  await client.send(new HeadObjectCommand({ Bucket: bucket, Key: s3Key }));

  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: s3Key }), {
    expiresIn: ttl,
  });
}

export interface SyncResult {
  uploaded: number;
  skipped: number;
  errors: string[];
}

export async function syncDirectory(localDir: string, s3Prefix: string): Promise<SyncResult> {
  const bucket = requireBucket();
  const result: SyncResult = { uploaded: 0, skipped: 0, errors: [] };

  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(localDir, { withFileTypes: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Failed to read directory ${localDir}: ${msg}`);
    return result;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const filePath = join(localDir, entry.name);
    const s3Key = `${s3Prefix}/${entry.name}`;

    try {
      const localChecksum = await computeFileChecksum(filePath);
      const localSize = statSync(filePath).size;
      const remote = await getRemoteObjectState(bucket, s3Key);

      if (remote.exists && remote.checksum === localChecksum && remote.size === localSize) {
        result.skipped++;
        continue;
      }

      await uploadBinary(filePath, s3Key, localChecksum);
      result.uploaded++;
    } catch (err) {
      result.errors.push(`${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}
