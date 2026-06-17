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

type QuoteRow = typeof quotes.$inferSelect;

function portalBase(): string {
  // The customer portal app (apps/portal) is where /quote/<token> is served.
  return (process.env.PUBLIC_PORTAL_URL || process.env.PUBLIC_APP_URL || process.env.DASHBOARD_URL || 'http://localhost:4321').replace(/\/$/, '');
}

/** Light money formatter for the email body (invoicePdf's formatMoney is module-private). */
function formatMoneyish(n: string | null | undefined, currency: string): string {
  const v = Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === 'USD' ? `$${v}` : `${v} ${currency}`;
}

/** Issue (if draft) + send: assign number, status→sent, sentAt, mint token, email post-commit. */
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
  await db.update(quotes).set({ status: 'sent', quoteNumber, issueDate, sentAt: now, updatedAt: now }).where(eq(quotes.id, id));

  // Mint the public accept token (expiry = quote.expiryDate if future, else +30d).
  const { token } = await createQuoteAcceptToken({
    quoteId: id, orgId: quote.orgId, partnerId: quote.partnerId,
    expiresAt: quote.expiryDate ? new Date(`${quote.expiryDate}T23:59:59Z`) : null,
  });
  const acceptUrl = `${portalBase()}/quote/${token}`;

  // Post-commit email — never block or fail the send on email/PDF I/O (mirrors invoice send).
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
  const now = new Date();
  await db.update(quotes).set({ status: 'declined', declineReason: reason ?? null, declinedAt: now, updatedAt: now }).where(eq(quotes.id, id));
  const [updated] = await db.select().from(quotes).where(eq(quotes.id, id)).limit(1);
  return updated!;
}
