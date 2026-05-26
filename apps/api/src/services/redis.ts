import Redis from 'ioredis';
import type { ConnectionOptions } from 'bullmq';
import { readFileSync } from 'node:fs';

let redisClient: Redis | null = null;
let redisAvailable = true;
let warnedAboutInsecureProdRedis = false;

function isProductionEnv(): boolean {
  // Tolerant match: `Production`, `prod`, `PRODUCTION` all count.
  // The pre-2026-05 exact-string match against `production` silently
  // downgraded misconfigured deploys to dev gates without surfacing
  // anything — a foot-gun for self-hosters.
  const raw = (process.env.NODE_ENV ?? 'development').trim().toLowerCase();
  return raw === 'production' || raw === 'prod';
}

function isHostedSaas(): boolean {
  return (process.env.IS_HOSTED ?? '').toLowerCase() === 'true';
}

function allowUnauthenticatedRedisOverride(): boolean {
  return (process.env.BREEZE_ALLOW_UNAUTH_REDIS ?? '').toLowerCase() === 'true';
}

function hasPasswordInRedisUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.password.length > 0;
  } catch {
    return false;
  }
}

const INSECURE_REDIS_GUIDANCE =
  'Set REDIS_PASSWORD (openssl rand -hex 32) and ensure REDIS_URL is redis://:<password>@host:port. See https://breezermm.com/deploy/production#redis-authentication';

const SELF_HOSTED_OPT_OUT_GUIDANCE =
  'If your deployment intentionally runs Redis on a private network without auth, set BREEZE_ALLOW_UNAUTH_REDIS=true to acknowledge the risk.';

function failOrWarnAboutInsecureRedis(reason: string): void {
  if (!isProductionEnv()) {
    return;
  }

  // Hosted SaaS: always fail-closed.
  if (isHostedSaas()) {
    throw new Error(`[Redis] ${reason}. ${INSECURE_REDIS_GUIDANCE}`);
  }

  // Self-hosted prod: fail-closed by default. An explicit opt-out env
  // (`BREEZE_ALLOW_UNAUTH_REDIS=true`) downgrades to warn-once for
  // private-network deployments where the operator owns the risk. Mirrors
  // the `ENROLLMENT_SECRET_ENFORCEMENT_MODE=warn` pattern.
  if (!allowUnauthenticatedRedisOverride()) {
    throw new Error(`[Redis] ${reason}. ${INSECURE_REDIS_GUIDANCE} ${SELF_HOSTED_OPT_OUT_GUIDANCE}`);
  }

  if (warnedAboutInsecureProdRedis) {
    return;
  }
  warnedAboutInsecureProdRedis = true;
  console.warn(
    `[Redis] ${reason} (allowed via BREEZE_ALLOW_UNAUTH_REDIS=true). ${INSECURE_REDIS_GUIDANCE}`
  );
}

function readRedisPasswordFile(): string | undefined {
  const passwordFile = process.env.REDIS_PASSWORD_FILE?.trim();
  if (!passwordFile) {
    return undefined;
  }

  try {
    const password = readFileSync(passwordFile, 'utf8').trim();
    return password || undefined;
  } catch (err) {
    throw new Error(
      `REDIS_PASSWORD_FILE is set but could not be read: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function resolveRedisUrl(): string {
  const explicitUrl = process.env.REDIS_URL?.trim();
  if (explicitUrl) {
    if (!hasPasswordInRedisUrl(explicitUrl)) {
      failOrWarnAboutInsecureRedis(
        'REDIS_URL must include a password (redis://:<password>@host:port) in production'
      );
    }
    return explicitUrl;
  }

  const host = process.env.REDIS_HOST?.trim() || 'localhost';
  const port = process.env.REDIS_PORT?.trim() || '6379';
  const password = readRedisPasswordFile() || process.env.REDIS_PASSWORD?.trim();

  if (password) {
    return `redis://:${encodeURIComponent(password)}@${host}:${port}`;
  }

  failOrWarnAboutInsecureRedis(
    'REDIS_PASSWORD is not configured in production; falling back to unauthenticated Redis'
  );

  return `redis://${host}:${port}`;
}

export function getRedis(): Redis | null {
  if (!redisAvailable) {
    return null;
  }

  if (!redisClient) {
    const url = resolveRedisUrl();
    redisClient = new Redis(url, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        // Exponential backoff with 30s cap - never stop retrying so recovery is possible
        const delay = Math.min(times * 1000, 30000);
        if (!redisAvailable) {
          console.log(`[Redis] Attempting reconnection (attempt ${times}, next retry in ${delay}ms)`);
        }
        return delay;
      },
      lazyConnect: true
    });

    redisClient.on('error', (err: Error & { code?: string }) => {
      if (err.code === 'ECONNREFUSED') {
        if (redisAvailable) {
          console.error('Redis unavailable - features degraded, will keep retrying');
        }
        redisAvailable = false;
      } else {
        console.error('Redis connection error:', err);
      }
    });

    redisClient.on('connect', () => {
      if (!redisAvailable) {
        console.log('[Redis] Reconnected successfully - resuming normal operation');
      }
      redisAvailable = true;
      console.log('Redis connected');
    });
  }

  return redisClient;
}

export function isRedisAvailable(): boolean {
  return redisAvailable;
}

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
  if (bullmqConnection) {
    await bullmqConnection.quit();
    bullmqConnection = null;
  }
}

let bullmqConnection: Redis | null = null;
let bullmqAvailable = false;

/**
 * Get a shared Redis connection for BullMQ queues and workers.
 * BullMQ requires maxRetriesPerRequest: null for blocking operations.
 * Returns a singleton — all queues/workers share the same connection.
 */
export function getRedisConnection(): Redis {
  if (!redisAvailable) {
    throw new Error('Redis connection required but not available');
  }

  if (!bullmqConnection) {
    const url = resolveRedisUrl();

    bullmqConnection = new Redis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryStrategy(times) {
        const delay = Math.min(times * 1000, 30000);
        return delay;
      }
    });

    bullmqConnection.on('error', (err: Error) => {
      if (bullmqAvailable) {
        console.error('BullMQ Redis connection lost — background jobs may stall:', err.message);
      }
      bullmqAvailable = false;
    });

    bullmqConnection.on('connect', () => {
      if (!bullmqAvailable) {
        console.log('[BullMQ Redis] Connected');
      }
      bullmqAvailable = true;
    });
  }

  return bullmqConnection;
}

/**
 * Get BullMQ-compatible connection options.
 * Wraps getRedisConnection() with the ConnectionOptions type that
 * BullMQ Queue/Worker constructors expect.
 */
export function getBullMQConnection(): ConnectionOptions {
  return getRedisConnection() as unknown as ConnectionOptions;
}

export function isBullMQAvailable(): boolean {
  return bullmqAvailable;
}
