import { z } from 'zod';

/** Body of POST /office-addin/auth/exchange (spec §9). */
export const exchangeSchema = z.object({
  /** Entra ID access token from Office SSO / NAA. */
  accessToken: z.string().min(1).max(8192),
});

/** Per-IP exchange rate limit (rateLimiter sliding window) — same posture as client-ai exchange. */
export const EXCHANGE_RATE_LIMIT = { limit: 20, windowSeconds: 300 } as const;
