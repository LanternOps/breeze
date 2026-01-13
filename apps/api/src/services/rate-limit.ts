import type { Redis } from 'ioredis';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}

export interface RateLimitConfig {
  limit: number;
  windowSeconds: number;
}

export async function rateLimiter(
  redis: Redis,
  key: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;
  const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;

  const results = await redis
    .multi()
    .zremrangebyscore(key, '-inf', windowStart)
    .zadd(key, now, member)
    .zcard(key)
    .zrange(key, 0, 0, 'WITHSCORES')
    .expire(key, windowSeconds)
    .exec();

  if (!results) {
    throw new Error('Rate limiter transaction aborted');
  }

  const countResult = results[2]?.[1];
  const count = typeof countResult === 'number' ? countResult : Number(countResult ?? 0);
  const oldestResult = results[3]?.[1];
  const oldestScore = Array.isArray(oldestResult) && oldestResult.length >= 2
    ? Number(oldestResult[1])
    : now;
  const resetAt = new Date(oldestScore + windowSeconds * 1000);

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    resetAt
  };
}

export const loginLimiter: RateLimitConfig = {
  limit: 5,
  windowSeconds: 5 * 60
};

export const forgotPasswordLimiter: RateLimitConfig = {
  limit: 3,
  windowSeconds: 60 * 60
};

export const mfaLimiter: RateLimitConfig = {
  limit: 5,
  windowSeconds: 5 * 60
};
