import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { invoices } from '../db/schema';
import { encryptSecret, decryptSecret } from './secretCrypto';
import { columnAad, encryptedColumnRegistry } from './encryptedColumnRegistry';
import { portalBase } from './portalUrl';
import { captureException } from './sentry';

/**
 * The durable public invoice link — the customer's no-login view-and-pay URL
 * (spec: docs/superpowers/specs/billing/2026-08-21-public-invoice-pay-link-design.md).
 *
 * Deliberately NOT a JWT (quorum decision): verification must read the invoice
 * row anyway (status + revocation), so a signed token would be stateless in
 * name only while inheriting the general JWT keyring's rotation lifetime —
 * which is sized for access tokens, not year-scale links (the quote accept
 * link's kid-loss failure mode, see regenerateQuoteAcceptToken). Instead:
 *
 * - Token: 32 random bytes, base64url (~43 chars — email-friendly). No claims;
 *   the invoice is resolved BY token hash.
 * - `public_link_token_hash` (SHA-256 hex, unique partial index) is the lookup
 *   key AND the revocation mechanism: replacing it kills every issued link.
 * - `public_link_token_ct` stores the token encrypted at rest (row-bound AAD
 *   via encryptedColumnRegistry) so copy-link / re-send reproduce the SAME url
 *   instead of minting a growing family of live credentials. Verification never
 *   touches the encryption key — key loss degrades to "next copy-link mints a
 *   fresh url", it can never brick existing links.
 * - `public_link_expires_at` is persisted at mint (never recomputed from the
 *   mutable due date).
 *
 * Callers establish the DB context: MSP routes run under the request context
 * (RLS-scoped), the public routes wrap in runOutsideDbContext(withSystemDbAccessContext).
 */

const TOKEN_BYTES = 32;
/** 12 months from mint… */
const LINK_TTL_MS = 365 * 24 * 60 * 60 * 1000;
/** …but never earlier than due date + 180 days (an overdue invoice is precisely
 *  when the link must still work). */
const DUE_DATE_GRACE_MS = 180 * 24 * 60 * 60 * 1000;

const CT_SPEC = encryptedColumnRegistry.find(
  (s) => s.table === 'invoices' && s.column === 'public_link_token_ct',
);
if (!CT_SPEC) throw new Error('[invoiceLinkToken] invoices.public_link_token_ct missing from encryptedColumnRegistry');

export type InvoiceLinkOrigin = 'reproduced' | 'minted' | 'minted_expired' | 'minted_unreadable' | 'reset';

export interface InvoiceLinkResult {
  token: string;
  expiresAt: Date;
  /** How the url came to be — 'reproduced' means the customer's existing link
   *  is unchanged; every 'minted_*' means prior links are now dead. */
  origin: InvoiceLinkOrigin;
}

export function hashInvoiceLinkToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function buildPublicInvoiceUrl(token: string): string {
  return `${portalBase()}/invoice/${encodeURIComponent(token)}`;
}

function mintToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

function computeExpiry(dueDate: string | null, now = Date.now()): Date {
  const fromMint = now + LINK_TTL_MS;
  if (!dueDate) return new Date(fromMint);
  const due = Date.parse(`${dueDate}T23:59:59Z`);
  if (Number.isNaN(due)) return new Date(fromMint);
  return new Date(Math.max(fromMint, due + DUE_DATE_GRACE_MS));
}

type LinkColumns = {
  id: string;
  dueDate: string | null;
  publicLinkTokenHash: string | null;
  publicLinkTokenCt: string | null;
  publicLinkExpiresAt: Date | null;
};

/** Decrypt the stored token; null (never throw) when the ciphertext is missing,
 *  unreadable, or fails the hash cross-check (tampered/mismatched row). */
function reproduceToken(row: LinkColumns): string | null {
  if (!row.publicLinkTokenHash || !row.publicLinkTokenCt) return null;
  let token: string | null = null;
  try {
    token = decryptSecret(row.publicLinkTokenCt, { aad: columnAad(CT_SPEC!, row.id) });
  } catch {
    token = null;
  }
  if (!token) return null;
  // Defensive cross-check: the decrypted token must hash to the stored lookup
  // key, or the two columns have diverged and the "reproduced" url would 401.
  const a = Buffer.from(hashInvoiceLinkToken(token), 'utf8');
  const b = Buffer.from(row.publicLinkTokenHash, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return token;
}

/**
 * Return the invoice's public link, minting one if absent/expired/unreadable.
 *
 * Concurrent-mint safe (same shape as quoteLifecycle.resolveAcceptUrl): the
 * UPDATE is conditional on the hash we READ still being on the row, so two
 * racing callers can't each mint — the loser re-reads and reproduces the
 * winner's token, and exactly one credential ever exists.
 */
export async function getOrMintInvoiceLink(row: LinkColumns): Promise<InvoiceLinkResult> {
  const expired = row.publicLinkExpiresAt != null && row.publicLinkExpiresAt.getTime() <= Date.now();
  if (!expired) {
    const existing = reproduceToken(row);
    if (existing && row.publicLinkExpiresAt) {
      return { token: existing, expiresAt: row.publicLinkExpiresAt, origin: 'reproduced' };
    }
  }
  const origin: InvoiceLinkOrigin = row.publicLinkTokenHash == null
    ? 'minted'
    : expired ? 'minted_expired' : 'minted_unreadable';
  if (origin === 'minted_unreadable') {
    // Unreadable ciphertext with a live hash means every link already in
    // customers' inboxes is about to be silently replaced — that's a key/AAD
    // problem worth an alert, not a log line (mirrors the quote kid-loss path).
    const err = new Error(`[invoiceLinkToken] stored link for invoice ${row.id} is unreadable — minting a replacement (existing links die)`);
    console.error(err.message);
    captureException(err);
  }

  const token = mintToken();
  const expiresAt = computeExpiry(row.dueDate);
  const claimed = await db.update(invoices)
    .set({
      publicLinkTokenHash: hashInvoiceLinkToken(token),
      publicLinkTokenCt: encryptSecret(token, { aad: columnAad(CT_SPEC!, row.id) }),
      publicLinkExpiresAt: expiresAt,
      updatedAt: new Date(),
    })
    .where(and(
      eq(invoices.id, row.id),
      row.publicLinkTokenHash == null
        ? isNull(invoices.publicLinkTokenHash)
        : eq(invoices.publicLinkTokenHash, row.publicLinkTokenHash),
    ))
    .returning({ id: invoices.id });
  if (claimed.length > 0) return { token, expiresAt, origin };

  // Lost the race — reproduce the winner's token.
  const [winner] = await db.select({
    id: invoices.id, dueDate: invoices.dueDate,
    publicLinkTokenHash: invoices.publicLinkTokenHash,
    publicLinkTokenCt: invoices.publicLinkTokenCt,
    publicLinkExpiresAt: invoices.publicLinkExpiresAt,
  }).from(invoices).where(eq(invoices.id, row.id)).limit(1);
  const winnerToken = winner && reproduceToken(winner);
  if (winnerToken && winner.publicLinkExpiresAt) {
    return { token: winnerToken, expiresAt: winner.publicLinkExpiresAt, origin };
  }
  // Winner's token unreadable too (or row vanished) — give up loudly rather
  // than loop; the caller surfaces a 500 and the next attempt re-races.
  throw new Error(`[invoiceLinkToken] could not mint or reproduce the public link for invoice ${row.id}`);
}

/**
 * Unconditionally replace the link — the MSP's "Reset link" action. Every
 * previously issued url dies the moment the hash is overwritten.
 */
export async function resetInvoiceLink(row: Pick<LinkColumns, 'id' | 'dueDate'>): Promise<InvoiceLinkResult> {
  const token = mintToken();
  const expiresAt = computeExpiry(row.dueDate);
  const updated = await db.update(invoices)
    .set({
      publicLinkTokenHash: hashInvoiceLinkToken(token),
      publicLinkTokenCt: encryptSecret(token, { aad: columnAad(CT_SPEC!, row.id) }),
      publicLinkExpiresAt: expiresAt,
      updatedAt: new Date(),
    })
    .where(eq(invoices.id, row.id))
    .returning({ id: invoices.id });
  if (updated.length === 0) throw new Error(`[invoiceLinkToken] reset matched no row for invoice ${row.id}`);
  return { token, expiresAt, origin: 'reset' };
}

/**
 * Resolve an invoice row by a presented bearer token. Returns null for an
 * unknown, expired, or draft-invoice token — callers render ONE generic
 * "invalid or expired" message for all three (no existence leak). Status
 * gating beyond draft (paid/void presentation) is the route's concern.
 *
 * The hash lookup is global by construction (the customer is anonymous); the
 * caller MUST scope every subsequent read/write to the returned row's id/orgId.
 */
export async function resolveInvoiceByLinkToken(token: string) {
  // Cheap shape gate before hashing: base64url, sane length.
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null;
  const hash = hashInvoiceLinkToken(token);
  const [inv] = await db.select().from(invoices)
    .where(eq(invoices.publicLinkTokenHash, hash))
    .limit(1);
  if (!inv) return null;
  // A draft must never resolve publicly (drafts are MSP-internal; a link
  // shouldn't exist for one, but a voided-then-recreated flow could).
  if (inv.status === 'draft') return null;
  if (inv.publicLinkExpiresAt == null || inv.publicLinkExpiresAt.getTime() <= Date.now()) return null;
  return inv;
}
