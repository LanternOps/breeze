import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { quotes, quoteImages } from '../db/schema/quotes';
import { organizations, partners } from '../db/schema/orgs';
import { portalBranding } from '../db/schema/portal';
import { getQuote } from './quoteService';
import { QuoteServiceError, type QuoteActor } from './quoteTypes';
import { allocateQuoteCounter, formatQuoteNumber } from './quoteNumbers';
import { createQuoteAcceptToken } from './quoteAcceptToken';
import { buildQuoteTemplate } from './quoteEmail';
import { getEmailService } from './email';
import { resolveBillingEmail } from './invoicePdf';
import { isQuoteExpired } from './quoteExpiry';

type QuoteRow = typeof quotes.$inferSelect;

/**
 * Resolve the public origin (scheme + host [+ base path]) the customer portal is
 * served under, for outbound email links. `PUBLIC_PORTAL_URL` is expected to
 * already include the portal base prefix (default `/portal`, see .env.example) —
 * e.g. `https://example.com/portal` — matching the invoice-link convention in
 * invoicePdf.ts. The public quote route lives at `<portalBase>/quote/<token>`.
 *
 * Hardening (malformed `https:///quote/...` accept links): a configured value
 * that is empty or parses to an empty host (e.g. a bare `https://`) must NEVER
 * silently produce an empty-host URL in a customer-facing email. We walk the
 * configured chain and, if none yields a usable host, throw loudly so the
 * caller's best-effort email swallow records the failure rather than mailing a
 * dead link.
 */
export function portalBase(): string {
  const candidates = [
    process.env.PUBLIC_PORTAL_URL,
    process.env.PUBLIC_APP_URL,
    process.env.DASHBOARD_URL,
    'http://localhost:4321/portal',
  ];

  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      // Not a parseable absolute URL (bare `https://`, host-only string, etc.) — skip.
      continue;
    }
    // A bare scheme like `https://` parses with an empty hostname; reject it so
    // we never emit `https:///quote/...`.
    if (!parsed.hostname) continue;
    return trimmed.replace(/\/+$/, '');
  }

  // The localhost fallback above always has a host, so this is unreachable in
  // practice — but if every configured value were malformed we fail loudly
  // rather than hand back an empty-host link.
  throw new Error(
    '[quoteLifecycle] Cannot build a public quote URL: PUBLIC_PORTAL_URL / PUBLIC_APP_URL / DASHBOARD_URL are unset or malformed (no host).',
  );
}

/** Build the public accept link emailed to the prospect: `<portalBase>/quote/<token>`. */
export function buildPublicQuoteAcceptUrl(token: string): string {
  return `${portalBase()}/quote/${encodeURIComponent(token)}`;
}

/** Light money formatter for the email body (invoicePdf's formatMoney is module-private). */
function formatMoneyish(n: string | null | undefined, currency: string): string {
  const v = Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === 'USD' ? `$${v}` : `${v} ${currency}`;
}

/** Issue (if draft) + send: assign number, status→sent, sentAt, mint token, best-effort email. */
export async function sendQuote(id: string, actor: QuoteActor): Promise<{ quote: QuoteRow; emailed: boolean; acceptUrl: string }> {
  const { quote, blocks, lines } = await getQuote(id, actor); // getQuote enforces org-access (404)
  if (quote.status !== 'draft') {
    // Phase 2 send is issue-once: a non-draft quote (already sent/viewed/etc.) cannot be re-sent.
    throw new QuoteServiceError(`Cannot send a quote in status ${quote.status}`, 409, 'INVALID_STATE');
  }

  // Assign a number on first issue. (A draft never has a number yet.)
  const year = new Date(quote.issueDate ?? Date.now()).getUTCFullYear();
  const counter = await allocateQuoteCounter(quote.partnerId, year);
  const quoteNumber = formatQuoteNumber('Q', year, counter);

  const now = new Date();
  const issueDate = quote.issueDate ?? now.toISOString().slice(0, 10);
  // Conditional on status='draft' so two concurrent sends can't both flip the
  // quote (the second matches 0 rows and 409s). Counter gaps from the losing
  // send are acceptable, per allocateQuoteCounter's contract (C3).
  const claimed = await db
    .update(quotes)
    .set({ status: 'sent', quoteNumber, issueDate, sentAt: now, updatedAt: now })
    .where(and(eq(quotes.id, id), eq(quotes.status, 'draft')))
    .returning({ id: quotes.id });
  if (claimed.length === 0) {
    throw new QuoteServiceError('Quote was already sent', 409, 'INVALID_STATE');
  }

  // Mint the public accept token (expiry = quote.expiryDate if future, else +30d).
  const { token } = await createQuoteAcceptToken({
    quoteId: id, orgId: quote.orgId, partnerId: quote.partnerId,
    expiresAt: quote.expiryDate ? new Date(`${quote.expiryDate}T23:59:59Z`) : null,
  });
  const acceptUrl = buildPublicQuoteAcceptUrl(token);

  // Best-effort email, rendered + sent here within the request transaction
  // (it commits when the handler returns). A failure is swallowed so the send
  // still commits. NOTE: unlike the invoice path (contractService returns a
  // deferred so the caller emails AFTER commit), this is not yet truly
  // post-commit — moving PDF+email outside the request txn is a tracked
  // follow-up (atom-3); the email-failure swallow keeps the send safe meanwhile.
  let emailed = false;
  try {
    const [org] = await db.select({ billingContact: organizations.billingContact }).from(organizations).where(eq(organizations.id, quote.orgId)).limit(1);
    const [partner] = await db.select({ name: partners.name }).from(partners).where(eq(partners.id, quote.partnerId)).limit(1);
    const recipient = resolveBillingEmail(org?.billingContact);
    const emailService = getEmailService();
    if (emailService && recipient) {
      const [brand] = await db.select({ logoUrl: portalBranding.logoUrl, primaryColor: portalBranding.primaryColor, footerText: portalBranding.footerText }).from(portalBranding).where(eq(portalBranding.orgId, quote.orgId)).limit(1);
      // Real image loader: pull bytes from quote_images, scoped to BOTH the image id
      // AND this quote (RLS blocks cross-tenant; the quote_id match closes the
      // same-org cross-quote case). Same loader the PDF route uses.
      const loadImage = async (imageId: string): Promise<{ data: Buffer } | null> => {
        const [img] = await db
          .select({ data: quoteImages.imageData })
          .from(quoteImages)
          .where(and(eq(quoteImages.id, imageId), eq(quoteImages.quoteId, id)))
          .limit(1);
        return img?.data ? { data: img.data } : null;
      };
      const { renderQuotePdf } = await import('./quotePdf');
      const pdf = await renderQuotePdf({ ...quote, status: 'sent', quoteNumber }, blocks, lines, loadImage, {
        partnerName: partner?.name ?? 'Proposal', logoUrl: brand?.logoUrl ?? null, primaryColor: brand?.primaryColor ?? null,
        footer: quote.terms ?? brand?.footerText ?? null, currencyCode: quote.currencyCode ?? 'USD',
      });
      const template = buildQuoteTemplate({
        quoteNumber, partnerName: partner?.name ?? 'your provider',
        total: formatMoneyish(quote.total, quote.currencyCode), acceptUrl,
        expiryDate: quote.expiryDate ?? undefined,
      });
      await emailService.sendEmail({ to: recipient, subject: template.subject, html: template.html, text: template.text, attachments: [{ filename: `${quoteNumber}.pdf`, content: pdf, contentType: 'application/pdf' }] });
      emailed = true;
    } else if (!emailService) {
      console.warn(`[quoteLifecycle] Email not configured — quote ${id} sent but not emailed`);
    } else {
      console.warn(`[quoteLifecycle] No billing email for org ${quote.orgId} — quote ${id} sent but not emailed`);
    }
  } catch (err) {
    console.error(`[quoteLifecycle] send email failed for quote ${id}:`, err);
  }

  const [updated] = await db.select().from(quotes).where(eq(quotes.id, id)).limit(1);
  return { quote: updated!, emailed, acceptUrl };
}

/**
 * sent→viewed + first_viewed_at (once). orgId is the resolved tenant (from the
 * portal session or the verified public token). Runs under a system DB context
 * (escaping any caller context first) so the read+stamp is never a silent 0-row
 * no-op under forced `breeze_app` RLS on the unauthenticated public path
 * (the rls_silent_zero_row_write class). Tenant scoping is preserved by the
 * `q.orgId !== orgId` guard. Never throws on a view stamp.
 */
export async function markQuoteViewed(quoteId: string, orgId: string): Promise<void> {
  await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [q] = await db.select().from(quotes).where(eq(quotes.id, quoteId)).limit(1);
    if (!q || q.orgId !== orgId) return; // scoped no-op
    const now = new Date();
    const set: Record<string, unknown> = { viewedAt: now, updatedAt: now };
    if (!q.firstViewedAt) set.firstViewedAt = now;
    if (q.status === 'sent') set.status = 'viewed';
    await db.update(quotes).set(set).where(eq(quotes.id, quoteId));
  }));
}

/** Internal/portal decline. */
export async function declineQuoteByActor(id: string, reason: string | undefined, actor: QuoteActor): Promise<QuoteRow> {
  const { quote } = await getQuote(id, actor);
  if (quote.status !== 'sent' && quote.status !== 'viewed') {
    throw new QuoteServiceError(`Cannot decline a quote in status ${quote.status}`, 409, 'INVALID_STATE');
  }
  // Read-time expiry guard (Phase 3): an expired quote is terminal — no decline
  // (nor accept) even before the sweep flips its status. Mirrors acceptQuote.
  if (isQuoteExpired(quote.expiryDate)) {
    throw new QuoteServiceError('This quote has expired', 410, 'QUOTE_EXPIRED');
  }
  const now = new Date();
  await db.update(quotes).set({ status: 'declined', declineReason: reason ?? null, declinedAt: now, updatedAt: now }).where(eq(quotes.id, id));
  const [updated] = await db.select().from(quotes).where(eq(quotes.id, id)).limit(1);
  return updated!;
}
