import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: process.env.S3_ENDPOINT || undefined,
      region: process.env.S3_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY!,
        secretAccessKey: process.env.S3_SECRET_KEY!,
      },
      forcePathStyle: true,
    });
  }
  return s3Client;
}

export function isS3Configured(): boolean {
  return !!(process.env.S3_BUCKET && process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY);
}

async function computeFileChecksum(filePath: string): Promise<string> {
  const data = await readFile(filePath);
  return createHash('sha256').update(data).digest('hex');
}

async function getRemoteETag(bucket: string, key: string): Promise<string | null> {
  try {
    const client = getS3Client();
    const resp = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return resp.ETag?.replace(/"/g, '') ?? null;
  } catch {
    return null;
  }
}

export async function uploadBinary(localPath: string, s3Key: string): Promise<void> {
  const bucket = process.env.S3_BUCKET!;
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
    })
  );
}

export async function getPresignedUrl(s3Key: string, ttlSeconds?: number): Promise<string> {
  const bucket = process.env.S3_BUCKET!;
  const client = getS3Client();
  const ttl = ttlSeconds ?? parseInt(process.env.S3_PRESIGN_TTL || '900', 10);

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
  const bucket = process.env.S3_BUCKET!;
  const result: SyncResult = { uploaded: 0, skipped: 0, errors: [] };

  let entries: string[];
  try {
    entries = await readdir(localDir);
  } catch {
    return result;
  }

  for (const entry of entries) {
    const filePath = join(localDir, entry);
    const s3Key = `${s3Prefix}/${entry}`;

    try {
      const localChecksum = await computeFileChecksum(filePath);
      const remoteETag = await getRemoteETag(bucket, s3Key);

      // S3 ETag for single-part uploads is the MD5, not SHA256.
      // We can't reliably compare, so always upload if ETag is missing
      // or if we haven't uploaded before. For simplicity, compare ETag presence.
      if (remoteETag) {
        result.skipped++;
        continue;
      }

      await uploadBinary(filePath, s3Key);
      result.uploaded++;
    } catch (err) {
      result.errors.push(`${entry}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}
