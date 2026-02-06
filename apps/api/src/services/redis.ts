import Redis from 'ioredis';

let redisClient: Redis | null = null;
let redisAvailable = true;

export function getRedis(): Redis | null {
  if (!redisAvailable) {
    return null;
  }

  if (!redisClient) {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
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
}

/**
 * Get Redis connection for BullMQ queues.
 * BullMQ requires maxRetriesPerRequest: null for blocking operations.
 * Creates a NEW connection each time - caller should manage lifecycle.
 */
export function getRedisConnection(): Redis {
  if (!redisAvailable) {
    throw new Error('Redis connection required but not available');
  }

  const url = process.env.REDIS_URL || 'redis://localhost:6379';

  // BullMQ requires maxRetriesPerRequest: null for blocking commands
  const connection = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy(times) {
      // Exponential backoff with 30s cap - never stop retrying
      const delay = Math.min(times * 1000, 30000);
      return delay;
    }
  });

  connection.on('error', (err: Error) => {
    console.error('BullMQ Redis connection error:', err.message);
  });

  return connection;
}
