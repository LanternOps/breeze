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
        if (times > 3) {
          redisAvailable = false;
          console.warn('Redis unavailable - rate limiting disabled');
          return null; // Stop retrying
        }
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      lazyConnect: true
    });

    redisClient.on('error', (err: Error & { code?: string }) => {
      if (err.code === 'ECONNREFUSED') {
        redisAvailable = false;
        console.warn('Redis unavailable - rate limiting disabled');
      } else {
        console.error('Redis connection error:', err);
      }
    });

    redisClient.on('connect', () => {
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
 * Returns the IORedis client instance.
 * Throws if Redis is not available.
 */
export function getRedisConnection(): Redis {
  const redis = getRedis();
  if (!redis) {
    throw new Error('Redis connection required but not available');
  }
  return redis;
}
