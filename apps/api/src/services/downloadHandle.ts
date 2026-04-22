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
  if (!redis) {
    console.error('[downloadHandle] Redis unavailable — treating handle as invalid');
    return null;
  }
  // Atomic get-and-delete (Redis 6.2+). Prevents the race where two
  // concurrent consumes both observe the value before either deletes it.
  const key = `download-handle:${handle}`;
  return await redis.getdel(key);
}
