import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { quotes, quoteImages, type SendQuoteEmailReason } from '../db/schema/quotes';
import { organizations, partners } from '../db/schema/orgs';
import { portalBranding } from '../db/schema/portal';
import { getQuote, toCustomerLines } from './quoteService';
import { QuoteServiceError, type QuoteActor } from './quoteTypes';
import { validateQuoteDeposit, toQuoteDepositConfig, type QuoteLineForMath } from './quoteMath';
import { allocateQuoteCounter, formatQuoteNumber } from './quoteNumbers';
import { createQuoteAcceptToken } from './quoteAcceptToken';
import { buildQuoteTemplate } from './quoteEmail';
import { getEmailService } from './email';
import { resolveBillingEmail } from './invoicePdf';
import { isQuoteExpired } from './quoteExpiry';
import { buildSellerSnapshot, buildBillToAddress } from './sellerSnapshot';
import { loadContractBlockRenderData, resolveAutoVariables, findUnresolvedVariables, loadContractPdfInputs } from './contractTemplateRender';
import { portalBase } from './portalUrl';
import { emitQuoteEvent } from './quoteEvents';
import { captureException } from './sentry';

export { portalBase };

type QuoteRow = typeof quotes.$inferSelect;

/** Build the public accept link emailed to the prospect: `<portalBase>/quote/<token>`. */
export function buildPublicQuoteAcceptUrl(token: string): string {
  return `${portalBase()}/quote/${encodeURIComponent(token)}`;
}

/** Light money formatter for the email body (invoicePdf's formatMoney is module-private). */
function formatMoneyish(n: string | null | undefined, currency: string): string {
  const v = Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === 'USD' ? `$${v}` : `${v} ${currency}`;
}

/** Why the best-effort email did not go out (mirrors invoicePdf's SendInvoiceResult
 * reasons, plus:
 *  - 'pdf_render_failed': building the attachment (contract input load, PDF
 *    render, or uploaded-contract merge) threw — the email was never attempted.
 *  - 'send_failed': the PDF built fine but the transport (emailService.sendEmail)
 *    threw.
 * Both are swallowed here rather than thrown, so this union exists to tell the
 * caller which stage failed. Defined next to the column it's persisted into
 * (db/schema/quotes.ts); re-exported here for the service-layer callers. */
export type { SendQuoteEmailReason } from '../db/schema/quotes';

/** Composer fields for the send email. All optional — defaults reproduce the
 * classic send (billing-contact recipient, standard subject, PDF attached). */
export interface SendQuoteEmailOptions {
  message?: string;
  /** Explicit recipients; falls back to the org's billing contact email. */
  to?: string[];
  cc?: string[];
  /** Subject override; falls back to `Proposal <n> from <partner>`. */
  subject?: string;
  /** Attach the rendered PDF (default true). */
  includePdf?: boolean;
}

/** Issue (if draft) + send: assign number, status→sent, sentAt, mint token, best-effort email. */
export async function sendQuote(
  id: string,
  actor: QuoteActor,
  opts: SendQuoteEmailOptions = {},
): Promise<{ quote: QuoteRow; emailed: boolean; emailReason?: SendQuoteEmailReason; acceptUrl: string }> {
  const { quote, blocks, lines } = await getQuote(id, actor); // getQuote enforces org-access (404)
  if (quote.status !== 'draft') {
    // Phase 2 send is issue-once: a non-draft quote (already sent/viewed/etc.) cannot be re-sent.
    throw new QuoteServiceError(`Cannot send a quote in status ${quote.status}`, 409, 'INVALID_STATE');
  }

  // Send-time contract-variable gate (Task 12): a contract block's declared
  // variables (auto or manual) can be left unresolved — sending would ship a
  // raw `{{token}}` placeholder straight into a legal document. Read-only and
  // MUST run before any org-scoped write below: loadContractBlockRenderData
  // is a system-context read that escapes the ambient request transaction via
  // runOutsideDbContext (contract_templates/contract_template_versions are
  // dual-axis and invisible under this org-scoped RLS context — same contract
  // as Task 10), and pinned version content is immutable, so this early read
  // can never race a template edit happening concurrently.
  const contractRenderData = await loadContractBlockRenderData(blocks);
  if (contractRenderData.length > 0) {
    const autoValues = resolveAutoVariables(quote);
    const contentByBlockId = new Map(blocks.map((b) => [b.id, b.content as { variableValues?: Record<string, string> } | null]));
    const unresolved = new Set<string>();
    for (const data of contractRenderData) {
      const variableValues = contentByBlockId.get(data.blockId)?.variableValues ?? {};
      for (const name of findUnresolvedVariables(data, variableValues, autoValues)) unresolved.add(name);
    }
    if (unresolved.size > 0) {
      throw new QuoteServiceError(
        `Contract variables unresolved: ${[...unresolved].sort().join(', ')}`,
        422,
        'CONTRACT_VARIABLES_UNRESOLVED',
      );
    }
  }

  // A deposit config can silently become unsatisfiable while drafting (e.g. the
  // last one-time line was deleted after the deposit was set) — recompute stores
  // NULL then, and this hard gate stops the quote going out with broken terms.
  if (quote.depositType && quote.depositType !== 'none') {
    const check = validateQuoteDeposit(
      lines as QuoteLineForMath[],
      quote.taxRate ? parseFloat(quote.taxRate) : null,
      toQuoteDepositConfig(quote.depositType, quote.depositPercent),
    );
    if (!check.ok) {
      throw new QuoteServiceError(`Cannot send: ${check.message}`, 409, 'DEPOSIT_INVALID');
    }
  }

  // Quotes are numbered at creation now; keep that number on issue. Only legacy
  // drafts created before number-at-creation still allocate here.
  let quoteNumber = quote.quoteNumber;
  if (!quoteNumber) {
    const year = new Date(quote.issueDate ?? Date.now()).getUTCFullYear();
    const counter = await allocateQuoteCounter(quote.partnerId, year);
    quoteNumber = formatQuoteNumber('Q', year, counter);
  }

  const now = new Date();
  const issueDate = quote.issueDate ?? now.toISOString().slice(0, 10);
  // Conditional on status='draft' so two concurrent sends can't both flip the
  // quote (the second matches 0 rows and 409s). Counter gaps from the losing
  // send are acceptable, per allocateQuoteCounter's contract (C3).
  const [partnerRow] = await db.select().from(partners).where(eq(partners.id, quote.partnerId)).limit(1);
  // Freeze the customer bill-to snapshot at send time from the org's Billing
  // settings — the same fields, from the same columns, that the invoice issue
  // path snapshots (invoiceService.ts). Without this, quotes.bill_to_address
  // stays NULL and the org's saved billing address never renders on the PDF. A
  // tech's explicit draft billToName override wins over the org name; taxId/
  // address come straight from the org. This single fetch also supplies the
  // email recipient below (billingContact), replacing the old post-update read.
  const [org] = await db
    .select({
      name: organizations.name,
      taxId: organizations.taxId,
      billingContact: organizations.billingContact,
      billingAddressLine1: organizations.billingAddressLine1,
      billingAddressLine2: organizations.billingAddressLine2,
      billingAddressCity: organizations.billingAddressCity,
      billingAddressRegion: organizations.billingAddressRegion,
      billingAddressPostalCode: organizations.billingAddressPostalCode,
      billingAddressCountry: organizations.billingAddressCountry,
    })
    .from(organizations)
    .where(eq(organizations.id, quote.orgId))
    .limit(1);
  if (!org) {
    // getQuote just read this quote in the SAME context, so its org should be
    // visible too — an unreadable org here (orphaned/deleted row) is anomalous.
    // The snapshot freezes ONCE at send, so a blank bill-to is permanent; log it
    // rather than let the loss be indistinguishable from "org saved no address".
    console.error(`[quoteLifecycle] org ${quote.orgId} not readable while freezing bill-to for quote ${id} — sending with an empty bill-to snapshot`);
  }
  const billToAddress = buildBillToAddress(org);
  // Preserve a real tech-entered "Prepared for" override, but fall back to the org
  // name when it's absent OR blank — updateQuote persists billToName verbatim,
  // including '', which a bare `?? org.name` would freeze as an empty name.
  const billToName = quote.billToName?.trim() ? quote.billToName : (org?.name ?? null);
  const claimed = await db
    .update(quotes)
    .set({
      status: 'sent', quoteNumber, issueDate, sentAt: now, updatedAt: now,
      // Retire any schedule state atomically with the flip: a scheduled-send
      // claim, a stale failure marker from an earlier attempt, or a pending
      // window must not survive onto a sent quote (a leftover send_email_reason
      // would render a false "no email was delivered" banner).
      sendScheduledAt: null, sendJobId: null, sendEmailReason: null,
      billToName,
      billToAddress,
      billToTaxId: quote.billToTaxId ?? org?.taxId ?? null,
      sellerSnapshot: buildSellerSnapshot(partnerRow),
      termsAndConditions: quote.termsAndConditions ?? partnerRow?.billingTermsAndConditions ?? null,
      terms: quote.terms ?? partnerRow?.invoiceFooter ?? null,
    })
    .where(and(eq(quotes.id, id), eq(quotes.status, 'draft')))
    .returning({ id: quotes.id });
  if (claimed.length === 0) {
    throw new QuoteServiceError('Quote was already sent', 409, 'INVALID_STATE');
  }

  // The in-memory `quote` row was read (getQuote) BEFORE the freeze above, so its
  // billTo*/sellerSnapshot columns are still the pre-freeze values (NULL on a
  // draft). Overlay the just-frozen values so contract variable substitution
  // ({{client.name}}/{{client.address}}/{{seller.name}}) and the PDF cover page
  // render the same customer/seller identity the executed snapshot and every
  // later render use — matching the admin PDF route's overlay
  // (routes/quotes/quotes.ts). Without this the emailed legal contract renders
  // those variables as empty strings and omits "PREPARED FOR" silently.
  const sellerSnapshot = quote.sellerSnapshot ?? buildSellerSnapshot(partnerRow);
  const frozenQuote: QuoteRow = {
    ...quote,
    status: 'sent',
    quoteNumber,
    billToName,
    billToAddress,
    billToTaxId: quote.billToTaxId ?? org?.taxId ?? null,
    sellerSnapshot,
  };

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
  let emailReason: SendQuoteEmailReason | undefined;
  try {
    // Reuse partnerRow (already fetched above for the seller snapshot) rather than
    // re-querying the partner just for its name — one fewer round-trip per send.
    const partnerName = partnerRow?.name;
    // Composer-picked recipients win; the org's billing contact is the fallback
    // so a bare "Send" keeps working exactly as before.
    const billingRecipient = resolveBillingEmail(org?.billingContact);
    const recipients = opts.to && opts.to.length > 0 ? opts.to : (billingRecipient ? [billingRecipient] : []);
    const emailService = getEmailService();
    if (emailService && recipients.length > 0) {
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
      // Customer-emailed PDF: filter to customer-visible lines (mirrors the
      // portal-download route, apps/api/src/routes/portal/quotes.ts). `lines`
      // itself stays unfiltered above — the deposit send-gate (and any other
      // internal computation over `lines`) intentionally covers ALL lines /
      // applies its own visibility rules internally. Internal-only line names
      // + prices must never reach the customer's inbox.
      const customerLines = toCustomerLines(lines.filter((l) => l.customerVisible));
      // PDF attachment is composer-optional (default on). When off, the render
      // + contract-merge work is skipped entirely and the email copy drops its
      // "A PDF copy is attached." sentence.
      const includePdf = opts.includePdf !== false;
      let pdf: Buffer | null = null;
      let pdfBuildFailed = false;
      if (includePdf) {
        // Own try/catch, deliberately separate from the transport try/catch below:
        // a failure building the attachment (contract input load, PDF render, or
        // uploaded-contract merge — e.g. an uploaded contract block with no stored
        // bytes, contractTemplateRender.ts's CONTRACT_RENDER_DATA_MISSING) is a
        // different failure mode than emailService.sendEmail throwing, and must not
        // collapse to the same 'send_failed' reason — the send was never attempted.
        try {
          // Same pre-fetch as the admin/portal PDF routes (Task 14): substituted HTML
          // per authored contract block + any uploaded contract PDFs to append after
          // rendering, so the emailed attachment matches the on-demand download.
          const { contractRenderData, uploads } = await loadContractPdfInputs(blocks, frozenQuote);
          const { renderQuotePdf } = await import('./quotePdf');
          const rawPdf = await renderQuotePdf(
            frozenQuote,
            blocks, customerLines, loadImage, {
              partnerName: partnerName ?? 'Proposal', logoUrl: brand?.logoUrl ?? null, primaryColor: brand?.primaryColor ?? null,
              footer: quote.terms ?? brand?.footerText ?? null, currencyCode: quote.currencyCode ?? 'USD',
            }, undefined, contractRenderData);
          const { mergeUploadedContractPdfs } = await import('./pdfMerge');
          pdf = await mergeUploadedContractPdfs(rawPdf, uploads);
        } catch (pdfErr) {
          pdfBuildFailed = true;
          emailReason = 'pdf_render_failed';
          console.error(`[quoteLifecycle] contract PDF build failed for quote ${id}:`, pdfErr);
          captureException(pdfErr instanceof Error ? pdfErr : new Error(String(pdfErr)));
        }
      }
      if (!pdfBuildFailed) {
        const template = buildQuoteTemplate({
          quoteNumber, partnerName: partnerName ?? 'your provider',
          total: formatMoneyish(quote.total, quote.currencyCode), acceptUrl,
          expiryDate: quote.expiryDate ?? undefined,
          message: opts.message,
          subject: opts.subject,
          pdfAttached: includePdf,
          signature: partnerRow?.emailSignature ?? undefined,
        });
        // MSP-branded envelope: display name "<Partner> via Breeze" on the
        // platform's own from-address (SPF/DKIM stays aligned — we never spoof
        // the MSP's domain), and replies go to the MSP's billing email so a
        // customer's "quick question" reply reaches the seller, not a no-reply box.
        const replyTo = partnerRow?.billingEmail?.trim() || undefined;
        await emailService.sendEmail({
          to: recipients,
          cc: opts.cc && opts.cc.length > 0 ? opts.cc : undefined,
          from: partnerName ? emailService.fromWithDisplayName(`${partnerName} via Breeze`) : undefined,
          replyTo,
          subject: template.subject, html: template.html, text: template.text,
          attachments: pdf ? [{ filename: `${quoteNumber}.pdf`, content: pdf, contentType: 'application/pdf' }] : undefined,
        });
        emailed = true;
      }
    } else if (!emailService) {
      emailReason = 'no_email_service';
      console.warn(`[quoteLifecycle] Email not configured — quote ${id} sent but not emailed`);
    } else {
      emailReason = 'no_billing_contact';
      console.warn(`[quoteLifecycle] No billing email for org ${quote.orgId} — quote ${id} sent but not emailed`);
    }
  } catch (err) {
    emailReason = 'send_failed';
    console.error(`[quoteLifecycle] send email failed for quote ${id}:`, err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }

  const [updated] = await db.select().from(quotes).where(eq(quotes.id, id)).limit(1);
  return { quote: updated!, emailed, emailReason, acceptUrl };
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
    // First view only (invoice.viewed parity): the sales-timing signal a future
    // notification worker cares about. Fire-and-forget — never fails the view.
    if (!q.firstViewedAt) await emitQuoteEvent({ type: 'quote.viewed', quoteId, orgId: q.orgId, partnerId: q.partnerId });
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
