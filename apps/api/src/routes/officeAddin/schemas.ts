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

/** Body of POST /office-addin/email-context (spec §3.1, Task 15). No message identifiers in URLs. */
export const emailContextSchema = z.object({
  from: z.object({ email: z.string().email().max(320), name: z.string().max(255).nullish() }),
  // Provenance only — never used for resolution (send-on-behalf-of).
  sender: z
    .object({ email: z.string().email().max(320), name: z.string().max(255).nullish() })
    .nullish(),
  internetMessageId: z.string().max(998).nullish(),
  references: z.array(z.string().max(998)).max(100).nullish(),
  inReplyTo: z.string().max(998).nullish(),
  subject: z.string().max(1000),
  conversationId: z.string().max(256).nullish(),
  // Echoed back so the pane can reject a stale response (a later item may
  // have been selected before this request resolved).
  itemGeneration: z.number().int(),
});

/** Body of POST /office-addin/orgs/search (Task 15, moved from Task 22). */
export const orgSearchSchema = z.object({
  query: z.string().min(1).max(200),
});

/** Body of POST /office-addin/tickets/from-email (spec §3.2, Task 16). */
export const fromEmailSchema = z.object({
  orgId: z.string().uuid(),
  subject: z.string().min(1).max(255),
  description: z.string().min(1).max(100_000),
  from: z.object({ email: z.string().email().max(320), name: z.string().max(255).nullish() }),
  internetMessageId: z.string().max(998).nullish(),
  requester: z.union([
    z.object({ kind: z.literal('portal_user'), id: z.string().uuid() }),
    z.object({ kind: z.literal('create_contact'), email: z.string().email().max(320), name: z.string().max(255).nullish() }), // deliberate, technician-confirmed
    z.object({ kind: z.literal('raw') }), // submitter_email/name only
  ]),
  followUpOf: z.object({ ticketId: z.string().uuid() }).nullish(), // closed-ticket continuation: carries thread key + prior number
});

/** Body of POST /office-addin/tickets/:id/link-email (spec §3.3, Task 17). */
export const linkEmailSchema = z.object({
  visibility: z.enum(['public', 'internal']),
  from: z.object({ email: z.string().email().max(320), name: z.string().max(255).nullish() }),
  internetMessageId: z.string().max(998).nullish(),
  subject: z.string().max(1000),
  bodyText: z.string().max(200_000), // quoted into the comment
});
