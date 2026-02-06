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
      if (times > 10) {
        return null; // Stop retrying
      }
      const delay = Math.min(times * 100, 3000);
      return delay;
    }
  });

  connection.on('error', (err: Error) => {
    console.error('BullMQ Redis connection error:', err.message);
  });

  return connection;
}
