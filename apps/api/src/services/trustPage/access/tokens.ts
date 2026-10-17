// Owner: W02d. Gated-document access tokens (amendment 32, `billing_link_tokens` pattern): the raw token is a
// 48-char nanoid that only ever travels in a URL fragment or a POST body; the database stores its sha256 hex.
// One live token per (request, purpose): minting revokes the previous unrevoked ones, so a resend kills the old link.
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../../db';
import { trustPageAccessTokens, type TrustPageAccessTokenRow } from '../../../db/schema/trustPages';
import type { TrustPageTx } from '../revision';

export type TrustAccessTokenPurpose = 'verify_email' | 'download';
export const TRUST_ACCESS_TOKEN_LENGTH = 48;
const RAW_TOKEN_RE = /^[A-Za-z0-9_-]{48}$/;

export function hashAccessToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** Returns the RAW token (the caller emails it and drops it); revokes this request's earlier tokens of the same purpose. */
export async function mintAccessToken(
  tx: TrustPageTx,
  a: { requestId: string; orgId: string; purpose: TrustAccessTokenPurpose; ttlMs: number; now?: Date },
): Promise<string> {
  const now = a.now ?? new Date();
  await tx.update(trustPageAccessTokens).set({ revokedAt: now }).where(and(
    eq(trustPageAccessTokens.requestId, a.requestId), eq(trustPageAccessTokens.purpose, a.purpose), isNull(trustPageAccessTokens.revokedAt),
  ));
  const raw = nanoid(TRUST_ACCESS_TOKEN_LENGTH);
  await tx.insert(trustPageAccessTokens).values({
    requestId: a.requestId, orgId: a.orgId, purpose: a.purpose, tokenHash: hashAccessToken(raw),
    expiresAt: new Date(now.getTime() + a.ttlMs),
  });
  return raw;
}

/**
 * The caller holds the system db context (the requester is anonymous). Null for a malformed, unknown, expired,
 * revoked or wrong-purpose token, and for a consumed verification token; callers must not tell these apart in
 * a response. A download token is reusable until it expires or is revoked.
 */
export async function findLiveToken(raw: string, purpose: TrustAccessTokenPurpose, now: Date): Promise<TrustPageAccessTokenRow | null> {
  if (typeof raw !== 'string' || !RAW_TOKEN_RE.test(raw)) return null;
  const [row] = await db.select().from(trustPageAccessTokens)
    .where(eq(trustPageAccessTokens.tokenHash, hashAccessToken(raw))).limit(1);
  if (!row) return null;
  if (row.purpose !== purpose) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;
  if (purpose === 'verify_email' && row.consumedAt) return null;
  return row;
}
