import Redis from 'ioredis';
import type { ConnectionOptions } from 'bullmq';

let redisClient: Redis | null = null;
let redisAvailable = true;
let warnedAboutInsecureProdRedis = false;

function isProductionEnv(): boolean {
  return (process.env.NODE_ENV ?? 'development') === 'production';
}

function hasPasswordInRedisUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.password.length > 0;
  } catch {
    return false;
  }
}

function warnAboutInsecureRedis(message: string): void {
  if (!isProductionEnv() || warnedAboutInsecureProdRedis) {
    return;
  }

  warnedAboutInsecureProdRedis = true;
  console.warn(`[Redis] ${message}`);
}

function resolveRedisUrl(): string {
  const explicitUrl = process.env.REDIS_URL?.trim();
  if (explicitUrl) {
    if (!hasPasswordInRedisUrl(explicitUrl)) {
      warnAboutInsecureRedis(
        'REDIS_URL in production does not include authentication; security-sensitive features may fail closed during Redis outages'
      );
    }
    return explicitUrl;
  }

  const host = process.env.REDIS_HOST?.trim() || 'localhost';
  const port = process.env.REDIS_PORT?.trim() || '6379';
  const password = process.env.REDIS_PASSWORD?.trim();

  if (password) {
    return `redis://:${encodeURIComponent(password)}@${host}:${port}`;
  }

  warnAboutInsecureRedis(
    'REDIS_URL/REDIS_PASSWORD not configured in production; falling back to unauthenticated Redis'
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
