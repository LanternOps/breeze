import { envInt } from '../utils/envInt';

export const DEFAULT_ENROLL_RATE_LIMIT = 10;
export const DEFAULT_ENROLL_RATE_WINDOW_SECONDS = 60;

export interface EnrollmentRateLimit {
  limit: number;
  windowSeconds: number;
}

function positive(name: string, fallback: number): number {
  const v = envInt(name, fallback);
  return v > 0 ? v : fallback;
}

/**
 * Per-source-IP limit on POST /api/v1/agents/enroll (#7472). Operators with
 * many machines behind one NAT address raise AGENT_ENROLL_RATE_LIMIT. Unset,
 * empty, non-numeric or non-positive values fall back to 10 per 60s (boot
 * validation in config/validate.ts rejects the invalid ones outright).
 */
export function getEnrollmentRateLimit(): EnrollmentRateLimit {
  return {
    limit: positive('AGENT_ENROLL_RATE_LIMIT', DEFAULT_ENROLL_RATE_LIMIT),
    windowSeconds: positive('AGENT_ENROLL_RATE_WINDOW_SECONDS', DEFAULT_ENROLL_RATE_WINDOW_SECONDS),
  };
}
