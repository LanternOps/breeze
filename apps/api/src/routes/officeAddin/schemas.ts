import { z } from 'zod';

/** Body of POST /office-addin/auth/exchange (spec §9). */
export const exchangeSchema = z.object({
  /** Entra ID access token from Office SSO / NAA. */
  accessToken: z.string().min(1).max(8192),
});

/** Per-IP exchange rate limit (rateLimiter sliding window) — same posture as client-ai exchange. */
export const EXCHANGE_RATE_LIMIT = { limit: 20, windowSeconds: 300 } as const;

/** Body of POST /office-addin/auth/bind (spec §9, Task 11). */
export const bindSchema = z.object({
  /** Entra ID access token from Office SSO / NAA — proves the (tid, oid) identity to bind. */
  accessToken: z.string().min(1).max(8192),
  /**
   * Login credential only (paired with password + MFA below) — NOT the
   * authorization identifier. The resulting authorization key is the Entra
   * (tid, oid) pair on the binding row, never this email address.
   */
  email: z.string().email().max(255),
  password: z.string().min(1).max(1024),
  mfaCode: z.string().min(6).max(10),
});

/** Per-IP bind rate limit — tighter than exchange since this path does a real password + MFA check. */
export const BIND_RATE_LIMIT = { limit: 10, windowSeconds: 900 } as const;
