import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { quotes, quoteBlocks, quoteLines, quoteAcceptances, quoteRecipients } from '../db/schema/quotes';
import { invoices, invoiceLines } from '../db/schema/invoices';
import { partners, sites } from '../db/schema/orgs';
import { deviceGroups } from '../db/schema/devices';
import { resolvePartnerDocumentLocale } from './documentLocale';
import { QuoteServiceError } from './quoteTypes';
import { computeQuoteSha256 } from './quoteContentHash';
import { getAcceptanceProvider } from './acceptanceProvider';
import { computeLineTotal, computeInvoiceTotals } from './invoiceMath';
import { formatInvoiceNumber } from './invoiceNumbers';
import { isQuoteExpired } from './quoteExpiry';
import { emitInvoiceEvent } from './invoiceEvents';
import { enqueueInvoicePdfRender } from '../jobs/invoiceWorker';
import { buildContractSpecsFromQuote, type QuoteLineForContract } from './quoteToContract';
import { createContractWithLinesDetailed } from './contractService';
import { stagePax8OrderFromQuote } from './quoteToPax8Order';
import { captureException } from './sentry';
import type { ContractBlockRenderData } from './contractTemplateRender';
import { getOrMintInvoiceLink, buildPublicInvoiceUrl } from './invoiceLinkToken';
import {
  assertContractRenderDataComplete,
  buildContractHashParts,
  createExecutedDocuments,
} from './contractDocumentService';

export interface AcceptQuoteParams {
  quoteId: string;
  signerName: string;
  signerEmail?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  acceptanceTokenJti?: string | null;
  actorUserId?: string | null;
  // Pre-fetched contract-block render data (pinned template versions), resolved
  // by the route handler OUTSIDE this transaction — the dual-axis template rows
  // are invisible to an org-scoped RLS context (see contractTemplateRender's
  // loadContractBlockRenderData). Required whenever the quote embeds contract
  // blocks; a missing/incomplete set hard-fails the accept (CONTRACT_RENDER_DATA_MISSING).
  contractRenderData?: ContractBlockRenderData[];
}

type QuoteRow = typeof quotes.$inferSelect;

export interface AcceptQuoteResult {
  quote: QuoteRow;
  acceptanceId: string;
  invoiceId: string;
  invoiceIssued: boolean;
  contractIds: string[];
  pax8OrderId: string | null;
  // Executed contract_documents snapshot ids created for this accept (one per
  // contract block); empty when the quote embeds no contract blocks.
  contractDocumentIds: string[];
}

/**
 * #3205 W05. A device-set line whose group or site was deleted carries a
 * stamped NAME and a NULL id. Accepting it would either fail deep inside
 * contract creation (group) or silently build an ORG-WIDE contract line from a
 * site-scoped quote (site). Refuse the whole accept here — before the hash,
 * before provider.capture, before any insert — so nothing is written.
 *
 * Aborting the WHOLE accept (not just the line) is right: the customer is
 * signing one document at one total, and dropping a line would change the price
 * they agreed to.
 *
 * The message is customer-safe: the accept path is unauthenticated and the
 * error reaches the person clicking Accept. The refusal is logged here with
 * ids only (never names) so the operator can find the line; `meta` carries the
 * detail for in-process callers and is not serialized to the customer.
 */
const QUOTE_LINE_REFERENCE_DELETED_MESSAGE =
  'This quote can no longer be accepted: one of the device sets it prices no longer exists. Please contact your provider for an updated quote.';

/** The subset of a quote_lines row this guard reads. The two ids are mutable
 *  here because the FOR SHARE re-read above nulls one that did not come back —
 *  "the row is not ours / is gone" and "the FK already nulled it" are the same
 *  state and must be reported the same way. */
interface AcceptableQuoteLine {
  id: string;
  contractLineType: string | null;
  deviceGroupId: string | null;
  deviceGroupName: string | null;
  siteId: string | null;
  siteName: string | null;
}

export function assertQuoteLinesAcceptable(lines: readonly AcceptableQuoteLine[]): void {
  for (const l of lines) {
    if (!l.contractLineType) continue;
    if (l.deviceGroupName !== null && l.deviceGroupId === null) {
      console.warn('[quotes] accept refused: line %s references a deleted device group', l.id);
      throw new QuoteServiceError(
        QUOTE_LINE_REFERENCE_DELETED_MESSAGE,
        409,
        'QUOTE_LINE_REFERENCE_DELETED',
        { quoteLineId: l.id, reference: 'device_group', name: l.deviceGroupName },
      );
    }
    if (l.siteName !== null && l.siteId === null) {
      console.warn('[quotes] accept refused: line %s references a deleted site', l.id);
      throw new QuoteServiceError(
        QUOTE_LINE_REFERENCE_DELETED_MESSAGE,
        409,
        'QUOTE_LINE_REFERENCE_DELETED',
        { quoteLineId: l.id, reference: 'site', name: l.siteName },
      );
    }
  }
}

/**
 * Shared accept pipeline for both the portal and public paths. The CALLER is
 * responsible for establishing the DB access context: portal handlers run under
 * org scope; the public route wraps this in
 * runOutsideDbContext(withSystemDbAccessContext(...)) because it's unauthenticated.
 *
 * Pipeline: lock quote row → guard status → compute content hash →
 * provider.capture → insert quote_acceptances → convert ONE-TIME lines to a
 * draft invoice via invoiceMath → status→converted.
 *
 * The caller's context wraps this in ONE Postgres transaction, so the whole
 * accept is atomic. The opening SELECT ... FOR UPDATE serializes concurrent
 * accepts of the same quote (double-submit / two tabs): the second transaction
 * blocks on the row lock, then re-reads status='converted' and 409s — preventing
 * duplicate acceptances + duplicate draft invoices. Revoking the public token's
 * jti is left to the caller, post-commit (so a rolled-back accept never revokes).
 */
export async function acceptQuote(
  params: AcceptQuoteParams
): Promise<AcceptQuoteResult> {
  // FOR UPDATE: serialize concurrent accepts on the same quote (we're already in
  // the caller's transaction). Without the row lock two READ COMMITTED accepts
  // both pass the status guard and each create an invoice (atom-1/C2).
  const [quote] = await db.select().from(quotes).where(eq(quotes.id, params.quoteId)).for('update').limit(1);
  if (!quote) throw new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND');
  // Durable single-use backstop (#2875, wave-3 schema 2026-08-06-c): a
  // token-based response whose jti was already consumed on this row is a
  // replay — even when the Redis revocation marker was lost (flush/failover/
  // TTL). Checked BEFORE the status guard and with a 401 (not 409) so a
  // replayed link fails exactly like the Redis resolve() gate does.
  if (
    params.acceptanceTokenJti
    && quote.publicResponseConsumedAt != null
    && quote.publicResponseJti === params.acceptanceTokenJti
  ) {
    throw new QuoteServiceError('This link is invalid or has expired', 401, 'RESPONSE_CONSUMED');
  }
  // Forward-compat guard for the wave-3 v1 model (response jti persisted at
  // send with public_token_version=1): a version-1 row may only ever be
  // consumed by the exact jti it was issued with — a different signed token
  // must never claim or rewrite the stored response jti. Inert for today's
  // version-0 rows.
  if (
    params.acceptanceTokenJti
    && (quote.publicTokenVersion ?? 0) !== 0
    && quote.publicResponseJti !== params.acceptanceTokenJti
  ) {
    throw new QuoteServiceError('This link is invalid or has expired', 401, 'RESPONSE_CONSUMED');
  }
  // A replaced quote is gone, not merely in a wrong state: 410 tells the
  // customer (and the portal) that this specific document is permanently
  // retired rather than temporarily unacceptable. Checked BEFORE the generic
  // status guard so a superseded quote never reports as a plain 409.
  // publicLinkRevokedAt remains a forward-compatibility guard for any future
  // standalone link revoke that does not also change the quote status.
  if (quote.status === 'superseded' || quote.publicLinkRevokedAt != null) {
    throw new QuoteServiceError('This quote has been replaced by a newer version', 410, 'QUOTE_SUPERSEDED');
  }
  if (quote.status !== 'sent' && quote.status !== 'viewed') {
    throw new QuoteServiceError(`Cannot accept a quote in status ${quote.status}`, 409, 'INVALID_STATE');
  }
  // Read-time expiry guard (Phase 3): a quote past its expiry_date can't be accepted
  // even if the sweep hasn't flipped it to 'expired' yet — closes the gap between
  // expiry and the next sweep tick. Shares the date-only definition with the sweep.
  if (isQuoteExpired(quote.expiryDate)) {
    throw new QuoteServiceError('This quote has expired and can no longer be accepted', 410, 'QUOTE_EXPIRED');
  }

  const blocks = await db
    .select()
    .from(quoteBlocks)
    .where(eq(quoteBlocks.quoteId, quote.id))
    .orderBy(quoteBlocks.sortOrder);
  const lines = await db
    .select()
    .from(quoteLines)
    .where(eq(quoteLines.quoteId, quote.id))
    .orderBy(quoteLines.sortOrder);

  // Accept date, resolved ONCE so the acceptance timestamps, the Phase-4 contract
  // start date, the {{dates.effective}} auto variable, and the executed-document
  // snapshot all agree. Date-only UTC for the contract/variable use.
  const now = new Date();
  const effectiveDate = now.toISOString().slice(0, 10);

  // Contract legal snapshot (Task 15): a quote that embeds contract blocks must
  // carry its pre-fetched render data. Guard BEFORE computing the hash / recording
  // anything so a missing snapshot aborts the accept with nothing written. The
  // contract parts (version sha + resolved variables) fold into the content hash,
  // so a later template republish or manual-variable edit invalidates the signature.
  assertContractRenderDataComplete(blocks, params.contractRenderData);

  // #3205 W05 decision 10. The stamps tell us what the line REFERENCES; these
  // reads tell us the rows still exist, and FOR SHARE keeps them existing until
  // COMMIT. Both predicates are org-scoped, so a forged id from another tenant
  // simply does not come back and is reported as deleted.
  //
  // FOR SHARE is the correct strength: acceptance does not modify these rows, it
  // only needs them to still exist. Its counterpart is deleteDeviceGroup's
  // FOR UPDATE (W02) — mutually exclusive, so a concurrent delete either WAITS
  // for this accept to commit and then finds the quote converted, or it WINS and
  // this lock request blocks until it commits, at which point the read below
  // comes back empty and the accept fails cleanly, before provider.capture().
  // Lock order is quote row (already held) → groups then sites, each by id
  // ascending. That deterministic order is strictly deeper than
  // deleteDeviceGroup's group-then-contract order and shares no cycle with it.
  const setLines = lines.filter((l) => l.contractLineType !== null);
  if (setLines.length > 0) {
    const groupIds = [...new Set(setLines.map((l) => l.deviceGroupId).filter((v): v is string => !!v))].sort();
    const siteIds = [...new Set(setLines.map((l) => l.siteId).filter((v): v is string => !!v))].sort();
    const liveGroups = groupIds.length === 0 ? [] : await db.select({ id: deviceGroups.id })
      .from(deviceGroups)
      .where(and(inArray(deviceGroups.id, groupIds), eq(deviceGroups.orgId, quote.orgId)))
      .orderBy(deviceGroups.id)
      .for('share');
    const liveSites = siteIds.length === 0 ? [] : await db.select({ id: sites.id })
      .from(sites)
      .where(and(inArray(sites.id, siteIds), eq(sites.orgId, quote.orgId)))
      .orderBy(sites.id)
      .for('share');
    const liveGroupIds = new Set(liveGroups.map((g) => g.id));
    const liveSiteIds = new Set(liveSites.map((s) => s.id));
    // Treat "the id is set but the row did not come back" exactly like the
    // stamped-orphan state below: deleted, or never ours.
    for (const l of setLines) {
      if (l.deviceGroupId && !liveGroupIds.has(l.deviceGroupId)) l.deviceGroupId = null;
      if (l.siteId && !liveSiteIds.has(l.siteId)) l.siteId = null;
    }
  }
  assertQuoteLinesAcceptable(lines);

  const contractRenderData = params.contractRenderData ?? [];
  // Partner row (language setting + invoice numbering), read ONCE: the render
  // locale below and the invoice issue fields further down must agree on it.
  const [partner] = await db
    .select({ prefix: partners.invoiceNumberPrefix, termsDays: partners.invoiceTermsDays, settings: partners.settings })
    .from(partners).where(eq(partners.id, quote.partnerId)).limit(1);
  // Render locale for the contract parts + executed PDF: the quote's send-time
  // snapshot (every non-draft quote carries one since 2026-09-01-b), falling
  // back to the PARTNER's language for an unstamped row — the same fallback the
  // portal/public render, the quote branding and the invoice stamp below use.
  // A bare 'en' fallback here would hash and PDF in English a document the
  // customer was shown in the partner's language. Legacy acceptances do not
  // depend on this: 2026-09-01-b stamped render_locale on every historical row,
  // so verification reads the persisted value (acceptanceRenderLocale).
  const renderLocale = quote.documentLocale ?? resolvePartnerDocumentLocale(partner);
  const contractParts = buildContractHashParts(blocks, contractRenderData, quote, effectiveDate, renderLocale);

  const quoteSha256 = computeQuoteSha256(quote as any, blocks as any, lines as any, contractParts, 2);
  const captured = await getAcceptanceProvider().capture({
    quoteId: quote.id,
    signerName: params.signerName,
    signerEmail: params.signerEmail,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
    acceptanceTokenJti: params.acceptanceTokenJti,
  });

  // 1. Record the acceptance.
  const [acceptance] = await db
    .insert(quoteAcceptances)
    .values({
      quoteId: quote.id,
      orgId: quote.orgId,
      signerName: captured.signerName,
      signerEmail: captured.signerEmail,
      // Defense-in-depth: routes already resolve a single validated client IP,
      // but ip_address is varchar(64) — clamp so a stray long value can never
      // overflow and roll back the whole accept (C1).
      ipAddress: params.ipAddress ? params.ipAddress.slice(0, 64) : null,
      userAgent: params.userAgent ?? null,
      quoteSha256,
      hashVersion: 2,
      acceptanceTokenJti: params.acceptanceTokenJti ?? null,
      renderLocale,
    })
    .returning({ id: quoteAcceptances.id });

  // 2. Convert ONE-TIME lines to a draft invoice (Phase 2: recurring lines deferred to the Phase 4 Contract).
  //    document_locale is NOT copied onto the draft here: it is an issue-time
  //    snapshot, stamped below when the invoice auto-issues (one-time lines) or
  //    by issueInvoice when it issues later (#3777).
  const oneTime = lines.filter((l) => l.recurrence === 'one_time' && l.customerVisible);
  const [invoice] = await db
    .insert(invoices)
    .values({
      partnerId: quote.partnerId,
      orgId: quote.orgId,
      siteId: quote.siteId ?? null,
      status: 'draft',
      currencyCode: quote.currencyCode,
      taxRate: quote.taxRate ?? null,
      createdBy: params.actorUserId ?? null,
      notes: quote.quoteNumber ? `Converted from quote ${quote.quoteNumber}` : 'Converted from quote',
    })
    .returning();

  const totalsLines: { lineTotal: string; taxable: boolean; customerVisible: boolean }[] = [];
  for (let i = 0; i < oneTime.length; i++) {
    const l = oneTime[i]!;
    const lineTotal = computeLineTotal(l.quantity, l.unitPrice, quote.currencyCode);
    await db.insert(invoiceLines).values({
      invoiceId: invoice!.id,
      orgId: quote.orgId,
      sourceType: 'manual',
      sourceId: null,
      catalogItemId: l.catalogItemId ?? null,
      parentLineId: null,
      ticketId: null,
      // Carry BOTH label fields from the quote line (#3319). invoice_lines.name
      // is the title and `description` the sub-line blurb (migration
      // 2026-07-03-quote-invoice-line-name); renderers read `name ?? description`.
      // Dropping `name` here made every converted invoice look like a legacy
      // line, so an accepted "Onboarding & network setup" line showed only its
      // blurb on the invoice and PDF.
      //
      // Blank-normalized, not just null-coalesced: the renderers key the blurb
      // off `name` being truthy, so a name of '' would render the title as '—'
      // AND suppress the description — losing BOTH labels. '' is reachable
      // because the line validators allow an empty string. Storing NULL makes
      // such a line a well-formed legacy line instead.
      name: l.name?.trim() || null,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      costBasis: null,
      taxable: l.taxable,
      customerVisible: true,
      lineTotal,
      isUnapprovedTime: false,
      sortOrder: i,
    });
    totalsLines.push({ lineTotal, taxable: l.taxable, customerVisible: true });
  }
  const totals = computeInvoiceTotals(totalsLines, quote.taxRate ?? null, quote.currencyCode);

  // Auto-issue on accept (Phase 3): if the converted invoice has payable (one-time)
  // lines, ISSUE it now — allocate a gapless invoice number and flip to 'sent' — so
  // the customer can pay immediately via createInvoicePayLink (PAYABLE excludes
  // 'draft'). We deliberately KEEP the quote's snapshotted totals/taxRate (computed
  // above) rather than re-resolving org/partner tax like issueInvoice does: the
  // charge must equal the accepted quote. A degenerate recurring-only quote ($0, no
  // one-time lines) stays draft — there's nothing to collect. The counter upsert is
  // inlined (no runOutsideDbContext) to stay atomic inside the caller's accept
  // transaction; the quote row lock above already serializes concurrent accepts, so
  // there's no double-allocation.
  // Partial<$inferInsert> (not Record<string, unknown>) so a typo'd column or a
  // wrong value type (e.g. money-string vs number) is a compile error, not a silent
  // no-op on the update.
  const issueFields: Partial<typeof invoices.$inferInsert> = {
    subtotal: totals.subtotal,
    taxTotal: totals.taxTotal,
    total: totals.total,
    balance: totals.total,
    updatedAt: now,
  };
  if (oneTime.length > 0) {
    const year = now.getUTCFullYear();
    const counterRows = await db.execute(sql`
      INSERT INTO partner_invoice_sequences (partner_id, year, counter)
      VALUES (${quote.partnerId}, ${year}, 1)
      ON CONFLICT (partner_id, year)
      DO UPDATE SET counter = partner_invoice_sequences.counter + 1
      RETURNING counter
    `);
    const counter = Number((counterRows as unknown as Array<{ counter: number }>)[0]?.counter
      ?? (counterRows as unknown as { rows?: Array<{ counter: number }> }).rows?.[0]?.counter);
    if (!Number.isFinite(counter) || counter < 1) {
      throw new QuoteServiceError('Failed to allocate invoice number', 500, 'INVALID_STATE');
    }
    const dueDate = new Date(now.getTime() + (partner?.termsDays ?? 30) * 86400000);
    issueFields.status = 'sent';
    issueFields.invoiceNumber = formatInvoiceNumber(partner?.prefix ?? 'INV', year, counter);
    issueFields.issueDate = now.toISOString().slice(0, 10);
    issueFields.dueDate = dueDate.toISOString().slice(0, 10);
    issueFields.billToName = quote.billToName ?? null;
    issueFields.billToAddress = quote.billToAddress ?? null;
    issueFields.billToTaxId = quote.billToTaxId ?? null;
    issueFields.sellerSnapshot = quote.sellerSnapshot ?? null;
    // This IS the invoice's issue moment (it never goes through issueInvoice),
    // so stamp its render locale here (#3777). The accepted quote's own stamp
    // is the natural value — the same rule sellerSnapshot follows above — with
    // the partner's language only as a fallback for an unstamped quote. Same
    // expression as `renderLocale` above, so the executed contract and the
    // invoice it issues can never be rendered in two different languages.
    issueFields.documentLocale = renderLocale;
    issueFields.termsAndConditions = quote.termsAndConditions ?? null;
    issueFields.terms = quote.terms ?? null;
    // Deposit terms travel from the signed quote onto the issued invoice.
    // depositAmount was validated < dueOnAcceptanceTotal at send and the quote
    // is locked since, so it is safe to snapshot verbatim. Guard on a POSITIVE
    // amount, not just non-null: a $0.00 deposit is "no deposit" and must never
    // be snapshotted. (computeQuoteTotals now persists null for a zero deposit;
    // this is belt-and-suspenders against any legacy/foreign write that stored "0.00".)
    if (quote.depositType !== 'none' && Number(quote.depositAmount) > 0) {
      issueFields.depositDue = quote.depositAmount;
    }
  }
  await db.update(invoices).set(issueFields).where(eq(invoices.id, invoice!.id));

  // 3. Transition the quote to converted.
  await db
    .update(quotes)
    .set({
      status: 'converted',
      acceptedAt: now,
      convertedAt: now,
      convertedInvoiceId: invoice!.id,
      updatedAt: now,
      // Durable response-capability consumption (#2875): for a token-based
      // (public) accept, claim + consume the response jti in the SAME
      // transaction as the status change. Redis stays the hot-path revocation
      // check; these columns are the durable authority a Redis flush cannot
      // erase. Portal accepts carry no token and leave them NULL — the quote
      // status machine already blocks any later public response.
      ...(params.acceptanceTokenJti
        ? {
            publicResponseJti: params.acceptanceTokenJti,
            publicResponseConsumedAt: now,
            publicResponseOutcome: 'accepted',
          }
        : {}),
    })
    .where(eq(quotes.id, quote.id));

  // Note: the public token's jti is revoked by the CALLER after the transaction
  // commits (atom-2) — revoking here would fire even if the txn later rolled back.

  // Phase 4: recurring (monthly/annual) lines -> draft Contracts, grouped by
  // cadence. Runs inside this same system-scope accept transaction, so a failure
  // rolls back the whole accept. accept's SELECT ... FOR UPDATE convert guard
  // already makes this at-most-once. Quotes carry currency/terms snapshotted at
  // send, so the contract inherits the accepted terms. (No document_locale:
  // contracts have no locale column — their documents resolve it at render.)
  const startDate = effectiveDate; // accept date, date-only UTC (shared with the snapshot)
  const contractSpecs = buildContractSpecsFromQuote(
    {
      orgId: quote.orgId,
      partnerId: quote.partnerId,
      quoteNumber: quote.quoteNumber ?? quote.id,
      currencyCode: quote.currencyCode,
      terms: quote.terms ?? null,
    },
    lines.map((l) => ({
      sourceQuoteLineId: l.id,
      recurrence: l.recurrence,
      customerVisible: l.customerVisible,
      name: l.name ?? null,
      description: l.description,
      unitPrice: l.unitPrice,
      quantity: l.quantity,
      taxable: l.taxable,
      catalogItemId: l.catalogItemId ?? null,
      termMonths: l.termMonths ?? null,
      // The SQL invariant admits only these four non-null values on quote
      // lines; the shared Postgres enum type is wider because contracts also
      // use its flat/manual members.
      contractLineType: l.contractLineType as QuoteLineForContract['contractLineType'],
      deviceRoles: l.deviceRoles as QuoteLineForContract['deviceRoles'],
      deviceGroupId: l.deviceGroupId,
      deviceGroupName: l.deviceGroupName,
      siteId: l.siteId,
      siteName: l.siteName,
      includedQuantity: l.includedQuantity,
      overageMode: l.overageMode,
      overageUnitPrice: l.overageUnitPrice,
    })),
    startDate,
    params.actorUserId ?? null,
  );

  const contractIds: string[] = [];
  const contractLineLinks: Array<{ quoteLineId: string; contractLineId: string }> = [];
  for (const spec of contractSpecs) {
    const created = await createContractWithLinesDetailed(spec);
    contractIds.push(created.contract.id);
    for (const line of created.lines) {
      if (line.sourceQuoteLineId) {
        contractLineLinks.push({
          quoteLineId: line.sourceQuoteLineId,
          contractLineId: line.id,
        });
      }
    }
  }

  // Task 15: freeze each contract block into an executed contract_documents row.
  // Placed AFTER the Phase-4 loop (so contractIds exists to link the document to
  // the first billing contract) and BEFORE the final re-select. Same transaction:
  // a render/insert failure here rolls back the entire accept — an acceptance is
  // never recorded without its legal snapshot. effectiveDate matches the value
  // folded into quoteSha256's contract parts above.
  const contractDocumentIds = await createExecutedDocuments(
    quote,
    acceptance!.id,
    contractIds,
    contractRenderData,
    blocks,
    effectiveDate,
    renderLocale,
  );

  // Phase 5: stage any Pax8-backed fulfillment in this exact transaction,
  // alongside the Phase 4 contracts it references. Nothing is sent to Pax8
  // here: customer acceptance records intent; a technician supplies the
  // provisioning details and explicitly submits it later.
  const pax8Staged = await stagePax8OrderFromQuote({
    quoteId: quote.id,
    orgId: quote.orgId,
    partnerId: quote.partnerId,
    contractIds,
    contractLineLinks,
    lines: lines.map((line) => ({
      id: line.id,
      catalogItemId: line.catalogItemId ?? null,
      quantity: line.quantity,
      recurrence: line.recurrence,
      customerVisible: line.customerVisible,
    })),
    actorUserId: params.actorUserId ?? null,
  });

  const [updated] = await db.select().from(quotes).where(eq(quotes.id, quote.id)).limit(1);
  // invoiceIssued mirrors the `oneTime.length > 0` branch above that flips the
  // invoice to status='sent' with a real number; a $0/no-one-time accept leaves
  // the invoice unissued. The caller emits lifecycle side effects post-commit.
  return {
    quote: updated!,
    acceptanceId: acceptance!.id,
    invoiceId: invoice!.id,
    invoiceIssued: oneTime.length > 0,
    contractIds,
    pax8OrderId: pax8Staged.orderId,
    contractDocumentIds,
  };
}

/**
 * Fire-and-forget lifecycle side effects for an accept that issued an invoice:
 * the `invoice.issued` event + the async PDF render. MUST be called AFTER the
 * accept transaction commits — both are Redis/BullMQ ops, and emitting inside the
 * transaction would fire even on a later rollback (the same reason the public
 * token's jti revoke is deferred to the caller). No-op when no invoice was issued.
 * Mirrors the post-commit tail of invoiceService.issueInvoice so quote-originated
 * invoices land on the events bus and get a cached PDF like any other.
 */
export async function emitAcceptInvoiceIssued(
  res: { invoiceId: string; invoiceIssued: boolean; quote: QuoteRow },
  actorUserId: string | null,
): Promise<void> {
  if (!res.invoiceIssued) return;
  await emitInvoiceEvent({
    type: 'invoice.issued',
    invoiceId: res.invoiceId,
    orgId: res.quote.orgId,
    partnerId: res.quote.partnerId,
    actorUserId,
  });
  try {
    await enqueueInvoicePdfRender(res.invoiceId);
  } catch (err) {
    console.error('[quoteAccept] enqueueInvoicePdfRender failed (accept already committed)', `invoiceId=${res.invoiceId}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Mint (or reproduce) the just-issued invoice's durable public view-and-pay
 * url — the accept response's replacement for the retired one-shot Stripe
 * `payUrl` (2026-08-21 spec §8: the browser lands on the durable page, which
 * offers payment; nothing lives only in one response). Post-commit,
 * best-effort: returns null rather than failing an accept the customer
 * already completed. Runs in its own system context.
 */
export async function resolveAcceptInvoiceUrl(
  res: { invoiceId: string; invoiceIssued: boolean },
): Promise<string | null> {
  if (!res.invoiceIssued) return null;
  try {
    return await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      const [inv] = await db.select({
        id: invoices.id, dueDate: invoices.dueDate,
        publicLinkTokenHash: invoices.publicLinkTokenHash,
        publicLinkTokenCt: invoices.publicLinkTokenCt,
        publicLinkExpiresAt: invoices.publicLinkExpiresAt,
      }).from(invoices).where(eq(invoices.id, res.invoiceId)).limit(1);
      if (!inv) return null;
      const link = await getOrMintInvoiceLink(inv);
      return buildPublicInvoiceUrl(link.token);
    }));
  } catch (err) {
    console.error('[quoteAccept] public invoice link mint failed after accept', `invoiceId=${res.invoiceId}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
    return null;
  }
}

/**
 * Auto-email the just-issued invoice (with its public pay link) after an
 * accept — DEFAULT ON, gated by partners.auto_email_invoice_on_quote_accept.
 * This is what makes closing the confirmation tab harmless: the durable link
 * lands in the customer's inbox without the MSP doing anything.
 *
 * Recipients: the quote's recorded send recipients ∪ the org billing contact
 * (deliverInvoiceEmail's own fallback when the quote has none on record) —
 * KNOWN addresses only, never the unverified signer-entered email.
 *
 * Post-commit and best-effort like every other accept side effect: a failure
 * is logged + captured, never surfaced to the accepting customer. Runs in its
 * own system context (the accept transaction is already committed and closed).
 */
export async function autoEmailAcceptedInvoice(
  res: { invoiceId: string; invoiceIssued: boolean; quote: QuoteRow },
): Promise<void> {
  if (!res.invoiceIssued) return;
  try {
    await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      const [partner] = await db.select({ auto: partners.autoEmailInvoiceOnQuoteAccept })
        .from(partners).where(eq(partners.id, res.quote.partnerId)).limit(1);
      // Same `!== false` shape as the settings read-back — default ON.
      if (partner?.auto === false) return;
      const recips = await db.select({ email: quoteRecipients.email })
        .from(quoteRecipients).where(eq(quoteRecipients.quoteId, res.quote.id));
      const to = Array.from(new Set(recips.map((r) => r.email.trim().toLowerCase()).filter(Boolean)));
      // Lazy import mirrors sendInvoiceEmail's own issueInvoice import — the
      // invoicePdf module pulls the whole email/PDF stack.
      const { sendInvoiceEmail } = await import('./invoicePdf');
      const result = await sendInvoiceEmail(
        res.invoiceId,
        { userId: null, partnerId: res.quote.partnerId, accessibleOrgIds: [res.quote.orgId] },
        to.length > 0 ? { to } : {},
      );
      if (!result.emailed) {
        console.warn('[quoteAccept] auto-email skipped', `invoiceId=${res.invoiceId}`, `reason=${result.reason}`);
      }
    }));
  } catch (err) {
    console.error('[quoteAccept] auto-email failed (accept already committed)', `invoiceId=${res.invoiceId}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}
