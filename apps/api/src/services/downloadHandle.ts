import { randomBytes } from 'crypto';
import { getRedis } from './redis';

const HANDLE_TTL_SECONDS = 300; // 5 minutes
const PREFIX = 'dlh_';

export async function issueDownloadHandle(rawEnrollmentKey: string): Promise<string> {
  const redis = getRedis();
  if (!redis) {
    throw new Error('Redis unavailable; cannot issue download handle');
  }
  const handle = PREFIX + randomBytes(16).toString('hex');
  await redis.set(`download-handle:${handle}`, rawEnrollmentKey, 'EX', HANDLE_TTL_SECONDS);
  return handle;
}

export async function consumeDownloadHandle(handle: string): Promise<string | null> {
  if (!handle.startsWith(PREFIX)) return null;
  const redis = getRedis();
  if (!redis) return null;
  const key = `download-handle:${handle}`;
  const value = await redis.get(key);
  if (!value) return null;
  await redis.del(key); // single-use
  return value;
}
