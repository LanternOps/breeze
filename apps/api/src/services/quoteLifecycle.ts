import { formatMoney } from '@breeze/shared';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { quotes, quoteImages, quoteRecipients, type SendQuoteEmailReason } from '../db/schema/quotes';
import { organizations, partners } from '../db/schema/orgs';
import { portalBranding } from '../db/schema/portal';
import {
  getQuote,
  quoteDeviceSetEstimate,
  toCustomerLines,
  type QuoteDeviceSetDrift,
} from './quoteService';
import {
  QuoteServiceError,
  REVISABLE_STATUSES,
  isSupersedable,
  type QuoteActor,
  type SupersedableStatus,
} from './quoteTypes';
import { validateQuoteDeposit, toQuoteDepositConfig, type QuoteLineForMath } from './quoteMath';
import { allocateQuoteCounter, formatQuoteNumber } from './quoteNumbers';
import { createQuoteAcceptToken, regenerateQuoteAcceptToken, type QuoteAcceptTokenIdentity } from './quoteAcceptToken';
import { buildQuoteTemplate } from './quoteEmail';
import { getEmailService } from './email';
import { resolveBillingEmail } from './invoicePdf';
import { isQuoteExpired } from './quoteExpiry';
import { buildSellerSnapshot, buildBillToAddress } from './sellerSnapshot';
import { resolveThemeId, resolvePageSize } from './documentThemes';
import { resolvePartnerDocumentLocale } from './documentLocale';
import { loadContractBlockRenderData, resolveAutoVariables, findUnresolvedVariables, loadContractPdfInputs } from './contractTemplateRender';
import { portalBase } from './portalUrl';
import { emitQuoteEvent } from './quoteEvents';
import { notifyQuoteOutcome } from './quoteOutcomeNotify';
import { captureException } from './sentry';

export { portalBase };

type QuoteRow = typeof quotes.$inferSelect;

/** Build the public accept link emailed to the prospect: `<portalBase>/quote/<token>`. */
export function buildPublicQuoteAcceptUrl(token: string): string {
  return `${portalBase()}/quote/${encodeURIComponent(token)}`;
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

export interface QuoteSupersedeResult {
  parentQuoteId: string;
  previousStatus: SupersedableStatus;
}

export interface SendQuoteResult {
  quote: QuoteRow;
  emailed: boolean;
  emailReason?: SendQuoteEmailReason;
  acceptUrl: string;
  /** Advisory only: drift never blocks or silently reprices a send. */
  deviceSetDrift: QuoteDeviceSetDrift[];
  superseded?: QuoteSupersedeResult;
}

/**
 * Issue (if draft) + send: assign number, status→sent, sentAt, mint token,
 * best-effort email. When the quote is a revision, its parent is retired to
 * 'superseded' atomically with the draft→sent claim.
 */
export async function sendQuote(
  id: string,
  actor: QuoteActor,
  opts: SendQuoteEmailOptions = {},
): Promise<SendQuoteResult> {
  // Lock the CHILD first, before reading its content: a concurrent draft edit
  // (now blocked on loadDraft's FOR UPDATE) must not land between the content
  // read below and the draft→sent claim, or we email a PDF that no longer
  // matches the stored quote. Locking before the access check is harmless — an
  // inaccessible id 404s at getQuote and the lock dies with the transaction.
  await db.select({ id: quotes.id }).from(quotes).where(eq(quotes.id, id)).limit(1).for('update');
  const { quote, blocks, lines } = await getQuote(id, actor); // getQuote enforces org-access (404)
  if (quote.status !== 'draft') {
    // Phase 2 send is issue-once: a non-draft quote (already sent/viewed/etc.) cannot be re-sent.
    throw new QuoteServiceError(`Cannot send a quote in status ${quote.status}`, 409, 'INVALID_STATE');
  }

  // ---- Revision supersede, part 1: lock + validate the parent -------------
  // Runs INSIDE the ambient request/system transaction so the parent flip and
  // the child's draft→sent claim commit or roll back together. This locks the
  // child first and then its parent; acceptQuote locks exactly one row, and the
  // revision chain is acyclic, so concurrent accept/send operations serialize
  // without forming a lock cycle.
  let parentToSupersede: { id: string; status: SupersedableStatus } | null = null;
  if (quote.revisionOfQuoteId) {
    const [parent] = await db.select({ id: quotes.id, status: quotes.status })
      .from(quotes)
      .where(and(eq(quotes.id, quote.revisionOfQuoteId), eq(quotes.orgId, quote.orgId)))
      .limit(1)
      .for('update');
    if (!parent) throw new QuoteServiceError('Original quote not found', 409, 'INVALID_STATE');
    if (parent.status === 'converted' || parent.status === 'accepted') {
      throw new QuoteServiceError(
        'The original quote was accepted while this revision was being drafted — it can no longer be sent',
        409, 'PARENT_CONVERTED');
    }
    // Parent statuses a revision send may retire deliberately exclude the
    // settled accepted/converted outcomes with an invoice or contract behind them.
    if (!isSupersedable(parent.status)) {
      throw new QuoteServiceError(`Cannot supersede a quote in status ${parent.status}`, 409, 'INVALID_STATE');
    }
    parentToSupersede = { id: parent.id, status: parent.status };
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
      quote.currencyCode,
    );
    if (!check.ok) {
      throw new QuoteServiceError(`Cannot send: ${check.message}`, 409, 'DEPOSIT_INVALID');
    }
  }

  // #3205 W05 decision 12: send REPORTS drift, it never fixes it. A
  // scheduled/undo-window send fires hours later, so refreshing here would
  // reprice a document behind the operator's back after they approved it.
  // Wrapped so it can NEVER block a send: silence is a bug, but so is a send
  // that fails because a group filter is broken.
  let deviceSetDrift: QuoteDeviceSetDrift[] = [];
  if (lines.some((line) => line.contractLineType !== null && line.contractLineType !== undefined)) {
    try {
      const counts = await quoteDeviceSetEstimate(id, actor);
      deviceSetDrift = counts.flatMap<QuoteDeviceSetDrift>((count) => {
        const line = lines.find((candidate) => candidate.id === count.lineId);
        if (!line) return [];
        if (count.error) {
          return [{
            lineId: count.lineId,
            description: line.name ?? line.description ?? '',
            storedQuantity: line.quantity,
            liveQuantity: null,
            error: count.error,
          }];
        }
        return count.billed === Number(line.quantity)
          ? []
          : [{
              lineId: count.lineId,
              description: line.name ?? line.description ?? '',
              storedQuantity: line.quantity,
              liveQuantity: count.billed,
            }];
      });
    } catch (err) {
      console.error('[quoteLifecycle] device-set drift check failed', id, err);
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
  // The addressed recipients are also the authenticated portal identities
  // allowed to accept/decline this quote. Persist a canonical set at send time;
  // CC recipients are informational and intentionally do not gain signer power.
  const billingRecipient = resolveBillingEmail(org?.billingContact);
  // A revision goes back to whoever received the original, not to the org's
  // billing contact — the people already in the conversation. Explicitly
  // org-filtered: this also runs under the send worker's SYSTEM context, where
  // getQuoteRecipients' unfiltered read would be cross-tenant.
  const parentRecipients = parentToSupersede
    ? (await db.select({ email: quoteRecipients.email }).from(quoteRecipients)
        .where(and(eq(quoteRecipients.quoteId, parentToSupersede.id), eq(quoteRecipients.orgId, quote.orgId)))
        .orderBy(quoteRecipients.createdAt)).map((r) => r.email)
    : [];
  const recipientEmails = Array.from(new Set(
    (opts.to && opts.to.length > 0 ? opts.to
      : parentRecipients.length > 0 ? parentRecipients
      : (billingRecipient ? [billingRecipient] : []))
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.length > 0),
  ));
  // Mint the public accept token (expiry = quote.expiryDate if future, else
  // +30d) BEFORE the claim so its identity is stamped atomically with the
  // draft→sent flip — a send can never commit without the parts needed to
  // reproduce the link it emailed. A token minted for a claim that then loses
  // the race is simply discarded with the 409.
  const { token, identity } = await createQuoteAcceptToken({
    quoteId: id, orgId: quote.orgId, partnerId: quote.partnerId,
    expiresAt: quote.expiryDate ? new Date(`${quote.expiryDate}T23:59:59Z`) : null,
  });
  const acceptUrl = buildPublicQuoteAcceptUrl(token);

  // Stamp the presentation ONCE, at send: never overwrite an existing snapshot
  // (a draft that already carries one — e.g. cloned from a sent quote — keeps
  // it verbatim), so a re-read of this same quote always renders the document
  // the customer was actually shown, even if the partner's live theme/pageSize
  // columns change later. Precedence matches resolveQuoteBranding exactly.
  const presentationSnapshot = quote.presentationSnapshot ?? {
    theme: resolveThemeId(partnerRow?.documentTheme),
    pageSize: resolvePageSize(partnerRow?.documentPageSize),
  };

  const documentLocale = quote.documentLocale ?? resolvePartnerDocumentLocale(partnerRow);
  const claimed = await db
    .update(quotes)
    .set({
      status: 'sent', quoteNumber, issueDate, sentAt: now, updatedAt: now,
      ...acceptTokenIdentityColumns(identity),
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
      presentationSnapshot,
      // Render-locale snapshot (#3777): stamped ONCE at first send from the
      // partner's language, never restamped (resendQuote does not write it);
      // `??` keeps a locale the draft already carries.
      documentLocale,
    })
    .where(and(eq(quotes.id, id), eq(quotes.status, 'draft')))
    .returning({ id: quotes.id });
  if (claimed.length === 0) {
    throw new QuoteServiceError('Quote was already sent', 409, 'INVALID_STATE');
  }

  // ---- Revision supersede, part 2: retire the parent ----------------------
  // The predicate re-asserts the allowed set even under the lock (belt to the
  // FOR UPDATE strap). public_link_revoked_at is the DB-authoritative
  // revocation for the parent's public link — deliberately NO Redis revoke:
  // Redis cannot join this transaction. GET /:token re-reads the row and refuses
  // a superseded quote. NOTE: the public asset routes do not yet check status or
  // publicLinkRevokedAt; closing that gap is W04's asset-closure scope.
  // Columns left untouched on purpose: declinedAt, declineReason, expiryDate,
  // viewedAt are the parent's historical record.
  let supersededResult: QuoteSupersedeResult | undefined;
  if (parentToSupersede) {
    const flipped = await db.update(quotes)
      .set({ status: 'superseded', publicLinkRevokedAt: now, updatedAt: now })
      .where(and(
        eq(quotes.id, parentToSupersede.id),
        eq(quotes.orgId, quote.orgId),
        inArray(quotes.status, [...REVISABLE_STATUSES]),
      ))
      .returning({ id: quotes.id });
    if (flipped.length === 0) {
      throw new QuoteServiceError('The original quote settled while sending the revision', 409, 'PARENT_CONVERTED');
    }
    supersededResult = { parentQuoteId: parentToSupersede.id, previousStatus: parentToSupersede.status };
  }

  if (recipientEmails.length > 0) {
    await db.insert(quoteRecipients).values(
      recipientEmails.map((email) => ({ quoteId: id, orgId: quote.orgId, email })),
    ).onConflictDoNothing();
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
    presentationSnapshot,
    // The just-stamped locale, so the same-request PDF + email render with it.
    documentLocale,
  };

  // A revision arrives in the same thread as the original, so the default
  // subject says it replaces something rather than reading as a duplicate
  // first-time proposal. An explicit opts.subject always wins.
  const effectiveOpts = parentToSupersede && !opts.subject
    ? { ...opts, subject: `Updated proposal ${quoteNumber} from ${partnerRow?.name ?? 'your provider'}` }
    : opts;

  const { emailed, emailReason } = await deliverQuoteEmail({
    quote, blocks, lines, partnerRow, quoteNumber, acceptUrl, frozenQuote, billingRecipient,
    opts: effectiveOpts,
  });

  // Persist THIS attempt's outcome, matching resendQuote and the scheduled-send
  // worker: without it a direct send whose PDF render or transport failed is
  // marked sent with send_email_reason NULL, so the detail page's "no email was
  // delivered" banner never fires and nobody learns the customer got nothing.
  // The draft→sent claim above already cleared the column, so only a failure
  // needs writing back.
  //
  // Deliberately NOT wrapped in try/catch. This runs inside the request-wide
  // transaction opened by withDbAccessContext, so a statement error here leaves
  // that transaction aborted: catching the rejection would not roll back to a
  // savepoint, the re-select below would fail with "current transaction is
  // aborted" anyway, and the whole draft→sent claim would roll back regardless.
  // A catch would only hide where it started. Failing here is atomic with the
  // status flip, which is the honest outcome — the email having already left is
  // a pre-existing property of sending inside the request transaction, not
  // something this write introduces.
  // Matched on id alone, deliberately: the SAME predicate the draft→sent claim
  // above used. Adding `orgId` here looks like defence-in-depth and is not —
  // `quote` was read BEFORE the claim, and updateQuote can reassign a draft's
  // org (quoteService.ts, `set.orgId = targetOrgId`). A concurrent move would
  // leave the claim succeeding on id+status while this write matched ZERO rows
  // against the stale org, silently losing the outcome this function exists to
  // record. Keep the write bound to the row the claim actually took.
  if (emailReason) {
    await db.update(quotes).set({ sendEmailReason: emailReason, updatedAt: new Date() }).where(eq(quotes.id, id));
  }

  const [updated] = await db.select().from(quotes).where(eq(quotes.id, id)).limit(1);
  return { quote: updated!, emailed, emailReason, acceptUrl, deviceSetDrift, superseded: supersededResult };
}

/** The `quotes` column patch that persists a freshly-minted token's identity. */
function acceptTokenIdentityColumns(identity: QuoteAcceptTokenIdentity) {
  return {
    acceptTokenJti: identity.jti,
    acceptTokenIssuedAt: new Date(identity.issuedAtSeconds * 1000),
    acceptTokenExpiresAt: new Date(identity.expiresAtSeconds * 1000),
    acceptTokenKid: identity.kid,
  };
}

/** Read a quote's persisted accept-token identity back, or null when it has none
 *  (draft, or sent before identity persistence shipped). */
function readAcceptTokenIdentity(quote: QuoteRow): QuoteAcceptTokenIdentity | null {
  if (!quote.acceptTokenJti || !quote.acceptTokenIssuedAt || !quote.acceptTokenExpiresAt) {
    // All four columns are written together, so a PARTIALLY populated identity
    // is row corruption (a half-run migration, a manual edit), not the ordinary
    // "legacy quote" case. Both degrade to a reissue, but only one is a bug —
    // log so they are distinguishable.
    if (quote.acceptTokenJti || quote.acceptTokenIssuedAt || quote.acceptTokenExpiresAt) {
      console.error(`[quoteLifecycle] quote ${quote.id} has a partially-populated accept-token identity — treating as unreproducible`);
    }
    return null;
  }
  return {
    jti: quote.acceptTokenJti,
    issuedAtSeconds: Math.floor(quote.acceptTokenIssuedAt.getTime() / 1000),
    expiresAtSeconds: Math.floor(quote.acceptTokenExpiresAt.getTime() / 1000),
    kid: quote.acceptTokenKid ?? null,
  };
}

interface DeliverQuoteEmailInput {
  quote: QuoteRow;
  blocks: Awaited<ReturnType<typeof getQuote>>['blocks'];
  lines: Awaited<ReturnType<typeof getQuote>>['lines'];
  partnerRow: typeof partners.$inferSelect | undefined;
  quoteNumber: string;
  acceptUrl: string;
  /** The quote with send-time-frozen bill-to/seller values overlaid — what the
   *  PDF and contract-variable substitution must render from. */
  frozenQuote: QuoteRow;
  /** Org billing-contact email, used when the composer names no recipients. */
  billingRecipient: string | null | undefined;
  opts: SendQuoteEmailOptions;
}

/**
 * Render the customer PDF and deliver the quote email. Shared by the initial
 * send and by resendQuote — extracted so the two paths can never drift on
 * customer-visible-line filtering, contract merging, branding or envelope
 * headers (the details that decide what a customer actually receives).
 *
 * Best effort by contract: every failure is swallowed into an `emailReason` so
 * the caller's transaction still commits.
 *
 * All three callers persist that reason to quotes.send_email_reason, which is
 * what raises the detail page's "no email was delivered" banner: sendQuote,
 * resendQuote, and the scheduled-send worker (jobs/quoteSendQueue.ts). Keep it
 * that way when adding a fourth. A caller that only returns the reason marks
 * the quote sent with the column NULL, so the banner never fires and nobody
 * learns the customer received nothing (#3502).
 */
async function deliverQuoteEmail(
  { quote, blocks, lines, partnerRow, quoteNumber, acceptUrl, frozenQuote, billingRecipient, opts }: DeliverQuoteEmailInput,
): Promise<{ emailed: boolean; emailReason?: SendQuoteEmailReason }> {
  const id = quote.id;
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
          const { renderQuotePdf } = await import('./quotePdf');
          // Snapshot-first precedence (Task 5, shared with resolveQuoteBranding):
          // frozenQuote.presentationSnapshot is the send-stamped value on a first
          // send, and the already-frozen one on a resend — either way it wins over
          // the partner's live theme/pageSize columns.
          const presentationSnap = frozenQuote.presentationSnapshot as { theme?: string; pageSize?: string } | null;
          const emailBranding = {
            partnerName: partnerName ?? 'Proposal', logoUrl: brand?.logoUrl ?? null, primaryColor: brand?.primaryColor ?? null,
            footer: quote.terms ?? brand?.footerText ?? null, currencyCode: quote.currencyCode ?? 'USD',
            theme: resolveThemeId(presentationSnap?.theme ?? partnerRow?.documentTheme),
            pageSize: resolvePageSize(presentationSnap?.pageSize ?? partnerRow?.documentPageSize),
            // Send-time locale snapshot → partner language → 'en' (#3777).
            locale: frozenQuote.documentLocale ?? resolvePartnerDocumentLocale(partnerRow),
          };
          // Same `emailBranding.locale` the page renderer uses, so contract totals
          // and the quote summary on the same PDF never disagree (#3777).
          const { contractRenderData, uploads } = await loadContractPdfInputs(blocks, frozenQuote, emailBranding.locale);
          const rawPdf = await renderQuotePdf(
            frozenQuote,
            blocks, customerLines, loadImage, emailBranding, undefined, contractRenderData);
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
          total: formatMoney(quote.total, quote.currencyCode, frozenQuote.documentLocale ?? resolvePartnerDocumentLocale(partnerRow)), acceptUrl,
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
      console.warn(`[quoteLifecycle] No billing email for org ${quote.orgId} — no recipient for quote ${id}, nothing emailed`);
    }
  } catch (err) {
    emailReason = 'send_failed';
    console.error(`[quoteLifecycle] send email failed for quote ${id}:`, err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }

  return { emailed, emailReason };
}

/**
 * Where a resolved accept link came from. This is NOT a cosmetic flag: the
 * three minted cases have materially different consequences for the customer,
 * and the UI must not collapse them into one "we issued a new link" message.
 *
 *  - `reproduced`             — the exact link the customer already holds.
 *  - `minted_no_identity`     — the quote predates identity persistence. Its
 *      original token was never stored and cannot be revoked, so the customer's
 *      first link is STILL LIVE alongside the new one.
 *  - `minted_key_unavailable` — the signing `kid` is gone from the keyring.
 *      getVerifyKey REFUSES to fall back to JWT_SECRET for an unknown kid
 *      (services/jwt.ts), so the customer's original link no longer verifies at
 *      all — it is dead, not duplicated.
 *  - `minted_expired`         — the stored token's own `exp` has passed. This
 *      happens on a quote with no expiry_date once the token's default 30-day
 *      TTL lapses, or when expiry_date is extended after send. The original
 *      link is already dead; reproducing it would hand over a link certain to
 *      fail.
 */
export type AcceptUrlOrigin =
  | 'reproduced'
  | 'minted_no_identity'
  | 'minted_key_unavailable'
  | 'minted_expired';

/**
 * Resolve the ONE customer-facing accept link for an already-sent quote,
 * minting + persisting a token only when the quote has none it can usefully
 * reproduce. Callers get back WHY, so the UI can tell the truth about what
 * happened to the link the customer already has (see AcceptUrlOrigin).
 *
 * Minting here writes a live accept credential, so callers MUST have refused
 * settled/expired quotes first — see assertLinkableQuote.
 *
 * Not exported: every caller goes through resendQuote or getQuoteShareLink so
 * the permission + status gates are never bypassed.
 */
async function resolveAcceptUrl(quote: QuoteRow): Promise<{ acceptUrl: string; origin: AcceptUrlOrigin }> {
  const identity = readAcceptTokenIdentity(quote);
  // An identity whose own `exp` has lapsed is worse than no identity: it
  // reproduces perfectly and then fails at the customer's browser. Treat it as
  // unreproducible so the mint path below replaces it (and says so).
  const expired = identity != null && identity.expiresAtSeconds * 1000 <= Date.now();
  const existing = expired ? null : await regenerateQuoteAcceptToken(
    { quoteId: quote.id, orgId: quote.orgId, partnerId: quote.partnerId },
    identity,
  );
  if (existing) return { acceptUrl: buildPublicQuoteAcceptUrl(existing), origin: 'reproduced' };

  const origin: AcceptUrlOrigin = identity == null
    ? 'minted_no_identity'
    : expired ? 'minted_expired' : 'minted_key_unavailable';

  const { token, identity: fresh } = await createQuoteAcceptToken({
    quoteId: quote.id, orgId: quote.orgId, partnerId: quote.partnerId,
    expiresAt: quote.expiryDate ? new Date(`${quote.expiryDate}T23:59:59Z`) : null,
  });
  // Conditional on the identity we READ still being the one on the row, so two
  // concurrent resolves can't each mint a token and leave the loser's link
  // live-but-unrecorded. The loser re-reads and reproduces the WINNER's token,
  // so both callers hand out the same url and only one credential ever exists.
  // (The share-link route is a GET that writes — a retry or double-click makes
  // this race ordinary, not exotic.)
  const claimed = await db
    .update(quotes)
    .set(acceptTokenIdentityColumns(fresh))
    .where(and(
      eq(quotes.id, quote.id),
      identity == null ? isNull(quotes.acceptTokenJti) : eq(quotes.acceptTokenJti, identity.jti),
    ))
    .returning({ id: quotes.id });
  if (claimed.length === 0) {
    const [winner] = await db.select().from(quotes).where(eq(quotes.id, quote.id)).limit(1);
    const winnerToken = winner && await regenerateQuoteAcceptToken(
      { quoteId: quote.id, orgId: quote.orgId, partnerId: quote.partnerId },
      readAcceptTokenIdentity(winner),
    );
    if (winnerToken) return { acceptUrl: buildPublicQuoteAcceptUrl(winnerToken), origin };
    // Neither our mint nor the winner's is reproducible — nothing safe to
    // return, and silently handing back an unrecorded credential is exactly
    // what the claim above exists to prevent.
    throw new QuoteServiceError('Could not resolve the share link — please try again', 409, 'LINK_RACE');
  }
  return { acceptUrl: buildPublicQuoteAcceptUrl(token), origin };
}

/** Statuses a quote can be re-sent or share-linked from. Draft has no link yet
 *  (send it instead); accepted/declined/converted are settled outcomes that a
 *  re-send would only muddy. `expired` is excluded here AND by the explicit
 *  expiry check in assertLinkableQuote, which also catches a quote whose
 *  expiry_date has passed before the sweep has flipped its status. */
const RESENDABLE_STATUSES = new Set(['sent', 'viewed']);

/**
 * The shared gate for both link-dispensing operations.
 *
 * This MUST run before resolveAcceptUrl on every path: resolving can MINT a
 * fresh 30-day credential, and createQuoteAcceptToken deliberately falls back
 * to that default TTL when the quote's expiry is already past. Without this
 * gate, asking for the link of an expired or settled quote would manufacture a
 * working read-credential for a proposal that is finished — outliving the quote
 * it belongs to, and bypassing the single-use jti gates on the public routes.
 */
function assertLinkableQuote(quote: QuoteRow, verb: 're-send' | 'share'): void {
  if (quote.status === 'draft') {
    throw new QuoteServiceError(
      verb === 'share'
        ? 'This quote has not been sent yet — send it to create a share link'
        : 'Cannot re-send a quote in status draft',
      409, 'INVALID_STATE',
    );
  }
  if (!RESENDABLE_STATUSES.has(quote.status)) {
    throw new QuoteServiceError(`Cannot ${verb} a quote in status ${quote.status}`, 409, 'INVALID_STATE');
  }
  if (isQuoteExpired(quote.expiryDate)) {
    throw new QuoteServiceError(`This quote has expired and can no longer be ${verb === 'share' ? 'shared' : 're-sent'}`, 410, 'QUOTE_EXPIRED');
  }
}

/**
 * Read the addresses a quote was sent to, oldest first.
 *
 * Deliberately carries NO org predicate: quote_recipients has forced RLS with
 * org policies, and every caller reaches this only after getQuote has asserted
 * org access. That makes it safe in a REQUEST context and unsafe anywhere else
 * — calling it from a worker under withSystemDbAccessContext would read across
 * tenants. Add an explicit org filter before any such use.
 */
export async function getQuoteRecipients(quoteId: string): Promise<string[]> {
  const rows = await db
    .select({ email: quoteRecipients.email })
    .from(quoteRecipients)
    .where(eq(quoteRecipients.quoteId, quoteId))
    .orderBy(quoteRecipients.createdAt);
  return rows.map((r) => r.email);
}

/**
 * Hand back the share link for an already-sent quote without emailing anything
 * — for pasting into Teams/SMS/a reply by hand.
 *
 * This dispenses a live accept credential, so the caller MUST have already
 * enforced the quotes:send permission and MUST audit-log the result.
 */
export async function getQuoteShareLink(
  id: string, actor: QuoteActor,
): Promise<{ acceptUrl: string; origin: AcceptUrlOrigin; reissued: boolean; recipients: string[]; orgId: string }> {
  const { quote } = await getQuote(id, actor); // enforces org-access (404)
  // Re-read the status under a row lock and gate on the FRESH value: getQuote's
  // snapshot can be stale by the time we mint or reproduce a link, and handing
  // out a live link to a just-superseded quote is exactly what supersede exists
  // to prevent. This also serializes against the parent-flip lock in sendQuote.
  // 'superseded' is already outside RESENDABLE_STATUSES, so assertLinkableQuote
  // refuses it with no change needed there.
  const [freshShare] = await db.select({ status: quotes.status })
    .from(quotes).where(eq(quotes.id, id)).limit(1).for('update');
  if (!freshShare) throw new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND');
  assertLinkableQuote({ ...quote, status: freshShare.status }, 'share');
  const { acceptUrl, origin } = await resolveAcceptUrl(quote);
  return {
    acceptUrl, origin, reissued: origin !== 'reproduced',
    recipients: await getQuoteRecipients(id), orgId: quote.orgId,
  };
}

/**
 * Re-email an already-sent quote, reusing its existing accept link.
 *
 * Deliberately NOT a second send: status, sentAt, quote_number and the
 * send-time bill-to/seller snapshots all stay pinned to the original issue, so
 * the customer's copy and ours keep describing the same document.
 *
 * What it DOES write: the recipient set (when the composer names new
 * addresses), the email-outcome marker, `updated_at`, and — only when the
 * original link could not be usefully reproduced — the accept-token identity
 * columns (see resolveAcceptUrl). Nothing else.
 *
 * Settled and expired quotes are refused by assertLinkableQuote. For an expired
 * quote that is not just about the status: its stored token is expired too, and
 * resolving would MINT a replacement — manufacturing a fresh 30-day credential
 * for a dead proposal. Clone instead.
 */
export async function resendQuote(
  id: string, actor: QuoteActor, opts: SendQuoteEmailOptions = {},
): Promise<{ quote: QuoteRow; emailed: boolean; emailReason?: SendQuoteEmailReason; acceptUrl: string; origin: AcceptUrlOrigin; reissued: boolean }> {
  const { quote, blocks, lines } = await getQuote(id, actor); // enforces org-access (404)
  // Same fresh-status gate as getQuoteShareLink: re-mailing a link for a quote
  // that was superseded between the read and here would put a dead document
  // back in the customer's inbox. The lock serializes against sendQuote's
  // parent flip.
  const [freshResend] = await db.select({ status: quotes.status })
    .from(quotes).where(eq(quotes.id, id)).limit(1).for('update');
  if (!freshResend) throw new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND');
  assertLinkableQuote({ ...quote, status: freshResend.status }, 're-send');
  if (!quote.quoteNumber) {
    // A sent quote always has a number (sendQuote allocates one on the way
    // through). Missing here means the row was tampered with or half-migrated.
    throw new QuoteServiceError('This quote has no quote number and cannot be re-sent', 409, 'INVALID_STATE');
  }

  const { acceptUrl, origin } = await resolveAcceptUrl(quote);

  const [partnerRow] = await db.select().from(partners).where(eq(partners.id, quote.partnerId)).limit(1);
  const [org] = await db
    .select({ billingContact: organizations.billingContact })
    .from(organizations)
    .where(eq(organizations.id, quote.orgId))
    .limit(1);

  // Recipient precedence: composer picks > who it originally went to > the
  // org's billing contact. The middle term is what makes a bare "Re-send"
  // reach the same people as the first send, even if the org's billing
  // contact has changed since — which is why `previous` is consulted BEFORE
  // billingRecipient (the latter is only ever reached when `previous` is
  // empty, i.e. a legacy send with no recorded addresses).
  const previous = await getQuoteRecipients(id);
  const billingRecipient = resolveBillingEmail(org?.billingContact);
  // Normalize composer addresses the same way the first send does, so a
  // service-layer caller (MCP, a future bulk action) that bypasses the route's
  // zod validation can't put a differently-cased address on the envelope than
  // the one recorded as an authorized signer.
  const normalizedTo = Array.from(new Set(
    (opts.to ?? []).map((email) => email.trim().toLowerCase()).filter((email) => email.length > 0),
  ));
  const effectiveTo = normalizedTo.length > 0 ? normalizedTo : previous;

  // New addresses become authorized portal signers, exactly as on a first send.
  // Existing rows are kept: revoking a prior recipient's ability to act on the
  // quote is a separate, deliberate operation, not a side effect of re-sending.
  if (normalizedTo.length > 0) {
    await db.insert(quoteRecipients).values(
      normalizedTo.map((email) => ({ quoteId: id, orgId: quote.orgId, email })),
    ).onConflictDoNothing();
  }

  const frozenQuote: QuoteRow = {
    ...quote,
    sellerSnapshot: quote.sellerSnapshot ?? buildSellerSnapshot(partnerRow),
  };

  const { emailed, emailReason } = await deliverQuoteEmail({
    quote, blocks, lines, partnerRow, quoteNumber: quote.quoteNumber, acceptUrl,
    frozenQuote, billingRecipient,
    opts: { ...opts, to: effectiveTo },
  });

  // Refresh the outcome marker so the detail page's "no email was delivered"
  // banner reflects THIS attempt — a successful re-send must clear a stale
  // failure from the original send, and vice versa.
  //
  // Bookkeeping only, and it runs AFTER the email has left: a throw here (or in
  // the re-select) would surface as "Could not re-send the proposal" while the
  // customer already has the message in hand, and the tech's natural next move
  // is to send it a second time. Swallow it onto the returned row instead.
  let updated: QuoteRow | undefined;
  try {
    await db.update(quotes).set({ sendEmailReason: emailReason ?? null, updatedAt: new Date() }).where(eq(quotes.id, id));
    [updated] = await db.select().from(quotes).where(eq(quotes.id, id)).limit(1);
  } catch (err) {
    console.error(`[quoteLifecycle] re-send delivered for quote ${id} but persisting its outcome failed:`, err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }

  // Fall back to the pre-send row overlaid with this attempt's outcome, so the
  // caller (and the route's audit record, which reads quote.orgId) always gets
  // a usable row even when the bookkeeping write failed.
  return {
    quote: updated ?? { ...quote, sendEmailReason: emailReason ?? null },
    emailed, emailReason, acceptUrl, origin, reissued: origin !== 'reproduced',
  };
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
    // CAS on the status we actually read. `q` is an unlocked snapshot, so a
    // supersede can commit between that read and this write — an unguarded
    // `WHERE id = ?` would then resurrect a retired quote to 'viewed' or stamp
    // a superseded row. Matching zero rows is the correct outcome here, not an
    // error: someone settled the quote first, and this is a cosmetic stamp, so
    // the caller still succeeds. The event cannot lose with the write, though:
    // emitting it without a committed stamp would describe a view that did not happen.
    const viewed = await db.update(quotes).set(set).where(and(
      eq(quotes.id, quoteId),
      q.status === 'sent' ? eq(quotes.status, 'sent') : ne(quotes.status, 'superseded'),
    )).returning({ id: quotes.id });
    // First view only (invoice.viewed parity): the sales-timing signal a future
    // notification worker cares about. Fire-and-forget — never fails the view.
    if (viewed.length > 0 && !q.firstViewedAt) await emitQuoteEvent({ type: 'quote.viewed', quoteId, orgId: q.orgId, partnerId: q.partnerId });
  }));
}

/** Internal/portal decline. */
export async function declineQuoteByActor(
  id: string, reason: string | undefined, actor: QuoteActor,
  // Attribution for the outcome notification: 'customer' (portal decline on the
  // customer's behalf) emails the quote creator; 'msp' (a tech marking their own
  // quote declined — AI tool / internal route) only emits the bus event, so an
  // internal action is never misattributed to the customer.
  source: 'customer' | 'msp' = 'msp',
): Promise<QuoteRow> {
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
  // CAS on the status guard above: `quote` is an unlocked read, so a supersede
  // (or a concurrent accept/decline) can land in between. Unlike markQuoteViewed
  // this is NOT cosmetic — declining is a real customer-visible outcome, so zero
  // rows matched must surface rather than silently pretend to succeed.
  const declined = await db.update(quotes)
    .set({ status: 'declined', declineReason: reason ?? null, declinedAt: now, updatedAt: now })
    .where(and(eq(quotes.id, id), inArray(quotes.status, ['sent', 'viewed'])))
    .returning({ id: quotes.id });
  if (declined.length === 0) {
    throw new QuoteServiceError('This quote can no longer be declined', 409, 'INVALID_STATE');
  }
  const [updated] = await db.select().from(quotes).where(eq(quotes.id, id)).limit(1);
  // Tell the tech who sent it (decline-completion spec §A). Deliberately
  // UNAWAITED: it emails over SMTP and must never add latency to (or fail)
  // the decline the caller already committed; it swallows its own errors.
  void notifyQuoteOutcome({ quoteId: id, outcome: 'declined', source });
  return updated!;
}
