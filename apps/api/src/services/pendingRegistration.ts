import { createHash, randomBytes } from 'crypto';
import { getRedis } from './redis';

/**
 * SR2-21 — email-first partner registration.
 *
 * `/auth/register-partner` must not reveal whether the submitted address already
 * has an account. It therefore does NO existence lookup and creates NO tenant in
 * the request: it parks the attacker-supplied signup data (email, company name,
 * name, and — critically — the ALREADY-HASHED password) in Redis under the
 * sha256 of a fresh high-entropy token, then enqueues an opaque worker job. The
 * account is created only after the verification link (which carries the RAW
 * token) is clicked, in `routes/auth/verifyEmail.ts`.
 *
 * The plaintext password is NEVER parked — the route hashes it (argon2) before
 * calling here. The key is the token HASH; the value holds the record plus the
 * raw token so the worker can rebuild the verification URL after a peek without
 * the raw token ever touching the queue payload (BullMQ retains completed/failed
 * job data — see authEmailQueue.ts).
 */

const PENDING_REG_PREFIX = 'pending-reg:';
const PENDING_REG_TTL_SECONDS = 3600; // 1 hour — matches the reset-token envelope.

export interface PendingRegistration {
  email: string;
  companyName: string;
  name: string;
  passwordHash: string;
  acceptTerms: boolean;
  termsVersion: string;
  hostedExpectation: boolean;
  createdAt: number;
  // Step-1 abuse attribution (#2343): captured from the LIVE step-1 request and
  // threaded into createPartner at step 2 — never the verification click's
  // IP/UA (routinely a mail scanner in another country, which would poison the
  // signup-abuse corpus).
  signupIp?: string;
  signupUserAgent?: string;
}

/** Peek/consume return the stored value, which additionally carries the raw token. */
export type StoredPendingRegistration = PendingRegistration & { rawToken: string };

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function pendingKey(tokenHash: string): string {
  return `${PENDING_REG_PREFIX}${tokenHash}`;
}

type RedisWithGetDel = NonNullable<ReturnType<typeof getRedis>> & {
  getdel?: (key: string) => Promise<string | null>;
  eval?: (script: string, keyCount: number, ...keys: string[]) => Promise<unknown>;
};

/**
 * Atomic GET+DEL — copies the same capability dance `routes/auth/password.ts`
 * uses for the reset-token envelope so exactly one concurrent caller wins.
 */
async function getDelAtomic(redis: RedisWithGetDel, key: string): Promise<string | null> {
  if (typeof redis.getdel === 'function') {
    return redis.getdel(key);
  }
  if (typeof redis.eval === 'function') {
    const raw = await redis.eval(
      `
      local value = redis.call('GET', KEYS[1])
      if value then
        redis.call('DEL', KEYS[1])
      end
      return value
    `,
      1,
      key,
    );
    return typeof raw === 'string' ? raw : null;
  }
  throw new Error('Redis client does not support atomic pending-registration consumption');
}

/**
 * Park a pending registration. Returns the raw token (goes into the verification
 * email only) and its hash (goes into the queue job + is the Redis key stem).
 *
 * Fails CLOSED: no Redis ⇒ throw. The route maps that to the generic 503 and
 * creates nothing — there is no in-memory fallback that could silently drop a
 * signup or, worse, hold a plaintext-adjacent secret outside its TTL envelope.
 */
export async function createPendingRegistration(
  record: Omit<PendingRegistration, 'createdAt'>,
): Promise<{ rawToken: string; tokenHash: string }> {
  const redis = getRedis();
  if (!redis) {
    throw new Error('[pending-registration] Redis unavailable; cannot park pending registration');
  }

  // >=256 bits of entropy (32 random bytes) per the design.
  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = sha256Hex(rawToken);

  const stored: StoredPendingRegistration = {
    ...record,
    createdAt: Date.now(),
    rawToken,
  };

  await redis.setex(pendingKey(tokenHash), PENDING_REG_TTL_SECONDS, JSON.stringify(stored));

  return { rawToken, tokenHash };
}

/**
 * Atomically consume (GET+DEL) the pending record. Exactly one winner under
 * concurrency; a second click on the same token gets null. Called by the
 * verification handler (the click consumes it).
 */
export async function consumePendingRegistration(
  tokenHash: string,
): Promise<PendingRegistration | null> {
  const redis = getRedis();
  if (!redis) return null;

  const raw = await getDelAtomic(redis as RedisWithGetDel, pendingKey(tokenHash));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingRegistration;
  } catch {
    return null;
  }
}

/**
 * Non-consuming GET. Used by the auth-email WORKER, which must read the record
 * to decide which email to send but MUST NOT consume it — only the user's click
 * consumes it.
 */
export async function peekPendingRegistration(
  tokenHash: string,
): Promise<StoredPendingRegistration | null> {
  const redis = getRedis();
  if (!redis) return null;

  const raw = await redis.get(pendingKey(tokenHash));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredPendingRegistration;
  } catch {
    return null;
  }
}

/**
 * Re-park a record under its original key with a remaining TTL. Used only by the
 * step-2 verification handler when `createPartner` throws AFTER the single-winner
 * consume already removed the record, so the user can click the same link again.
 * Best-effort; the caller does not depend on it succeeding.
 */
export async function rewritePendingRegistration(
  tokenHash: string,
  record: StoredPendingRegistration,
  ttlSeconds: number,
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const ttl = Math.max(1, Math.floor(ttlSeconds));
  await redis.setex(pendingKey(tokenHash), ttl, JSON.stringify(record));
}
