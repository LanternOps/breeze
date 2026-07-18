// Executed contract-document snapshots (Task 15 of the contract documents +
// enhanced proposals plan, docs/superpowers/plans/
// 2026-07-16-contract-documents-and-enhanced-proposals.md).
//
// When a quote that embeds `contract` blocks is ACCEPTED, each block's pinned
// (immutable) template version is frozen into a standalone PDF and persisted to
// `contract_documents` — the legal record of exactly what the customer signed.
// This runs INSIDE the accept transaction (see quoteAcceptService.acceptQuote),
// so a failure here rolls the whole accept back: an acceptance is never recorded
// without its executed-document snapshot.
//
// Three concerns:
//  1. assertContractRenderDataComplete — the accept-time guard. A quote with
//     contract blocks whose pre-fetched render data is missing/incomplete
//     hard-fails (500) rather than silently skipping the snapshot.
//  2. buildContractHashParts — derive the HashableContractPart[] folded into the
//     acceptance content hash (version sha + fully-resolved variable set).
//  3. createExecutedDocuments — render + persist one contract_documents row per
//     contract block (authored → small pdfkit doc; uploaded → stored file bytes).

import { createHash } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { and, desc, eq, isNull, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { contractDocuments, contractTemplates, contractTemplateVersions } from '../db/schema/contractDocuments';
import { contracts } from '../db/schema/contracts';
import { quotes, quoteAcceptances } from '../db/schema/quotes';
import { QuoteServiceError } from './quoteTypes';
import type { HashableContractPart } from './quoteContentHash';
import {
  resolveAutoVariables,
  substituteVariables,
  type ContractBlockRenderData,
  type QuoteRow,
} from './contractTemplateRender';
import { renderRichTextIntoPdf } from './richTextPdf';
import { sanitizeRichTextHtml } from './richTextSanitize';
import { formatDate } from './quotePdf';
import type { AuthContext } from '../middleware/auth';
import { captureException } from './sentry';

// Only the three fields this service reads off a quote_blocks row — the caller
// passes the full Drizzle rows, which satisfy this structurally.
type ContractBlockLike = { id: string; blockType: string; content: unknown };

// ---------------------------------------------------------------------------
// Variable resolution (auto + manual merge), duplicated in lockstep with
// contractTemplateRender.ts's render paths — same values must fill the executed
// document as filled the client-facing render and the acceptance hash.
// ---------------------------------------------------------------------------

function manualValuesOf(content: unknown): Record<string, string> {
  const raw = content && typeof content === 'object' && !Array.isArray(content)
    ? (content as Record<string, unknown>)
    : {};
  const mv = raw.variableValues;
  return mv && typeof mv === 'object' && !Array.isArray(mv) ? (mv as Record<string, string>) : {};
}

/** The fully-resolved variable set for a contract block: every AUTO variable
 *  derived from the quote (with `dates.effective` pinned to the accept date)
 *  overlaid with the block's MANUAL variableValues. Deterministic given the
 *  quote row + effectiveDate, so the accept path and any re-verification
 *  reconstruct the same map. */
function resolvedValuesForBlock(content: unknown, quote: QuoteRow, effectiveDate: string): Record<string, string> {
  return { ...resolveAutoVariables(quote, { effectiveDate }), ...manualValuesOf(content) };
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

/** Accept-time gate: every `contract` block on the quote MUST have a matching
 *  entry in the pre-fetched render data. A missing/incomplete set means the
 *  route failed to resolve the pinned versions (or a block was added after the
 *  fetch) — refuse the accept rather than record an acceptance with no legal
 *  snapshot. 500 because it's an internal invariant, not user input. */
export function assertContractRenderDataComplete(
  blocks: ContractBlockLike[],
  renderData: ContractBlockRenderData[] | undefined,
): void {
  const contractBlockIds = blocks.filter((b) => b.blockType === 'contract').map((b) => b.id);
  if (contractBlockIds.length === 0) return;
  const byBlockId = new Set((renderData ?? []).map((d) => d.blockId));
  for (const id of contractBlockIds) {
    if (!byBlockId.has(id)) {
      throw new QuoteServiceError(
        `Contract render data missing for block ${id}; refusing to record acceptance without its legal snapshot`,
        500,
        'CONTRACT_RENDER_DATA_MISSING',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Acceptance-hash parts
// ---------------------------------------------------------------------------

/** Build the HashableContractPart[] folded into computeQuoteSha256 at accept
 *  time. renderData carries only `contract` blocks (loadContractBlockRenderData
 *  filters), so iterating it yields exactly one part per contract block. */
export function buildContractHashParts(
  blocks: ContractBlockLike[],
  renderData: ContractBlockRenderData[],
  quote: QuoteRow,
  effectiveDate: string,
): HashableContractPart[] {
  const contentByBlockId = new Map(blocks.map((b) => [b.id, b.content]));
  return renderData.map((data) => ({
    blockId: data.blockId,
    templateVersionSha256: data.versionSha256,
    resolvedVariables: resolvedValuesForBlock(contentByBlockId.get(data.blockId), quote, effectiveDate),
  }));
}

// ---------------------------------------------------------------------------
// PDF snapshot for an AUTHORED contract block
// ---------------------------------------------------------------------------

function ensureSpace(doc: PDFKit.PDFDocument, y: number, needed = 40): number {
  if (y > doc.page.height - doc.page.margins.bottom - needed) {
    doc.addPage();
    return doc.page.margins.top;
  }
  return y;
}

/** Render a small standalone PDF for one authored contract block: a branding
 *  header (template name + parties + effective date) over the already-substituted
 *  rich-text body, paginated via renderRichTextIntoPdf's caller-supplied
 *  ensureRoom (mirrors quotePdf.ts's contract-block branch). */
async function renderAuthoredContractPdf(
  templateName: string,
  substitutedHtml: string,
  quote: QuoteRow,
  effectiveDate: string,
): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (d: Buffer) => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = right - left;
  const seller = (quote.sellerSnapshot as { name?: string } | null) ?? null;

  // ---- Branding header ----
  doc.fillColor('#111827').fontSize(18).font('Helvetica-Bold').text(templateName || 'Contract', left, 50, { width: contentWidth });
  const metaBits = [seller?.name, quote.billToName, `Effective ${formatDate(effectiveDate)}`]
    .filter((s): s is string => !!s && String(s).trim().length > 0)
    .join('   •   ');
  if (metaBits) doc.fillColor('#6b7280').fontSize(9.5).font('Helvetica').text(metaBits, left, doc.y + 4, { width: contentWidth });
  const ruleY = doc.y + 6;
  doc.moveTo(left, ruleY).lineTo(right, ruleY).lineWidth(1).strokeColor('#e5e7eb').stroke();

  // ---- Body ----
  // Set doc.y explicitly so renderRichTextIntoPdf's page-break detection
  // (beforeDocY vs doc.y) starts from the body origin, not the header cursor.
  doc.y = ruleY + 14;
  const ensureRoom = (needed: number): number => ensureSpace(doc, doc.y, needed);
  renderRichTextIntoPdf(doc, substitutedHtml, { x: left, width: contentWidth, startY: doc.y, ensureRoom });

  doc.end();
  return done;
}

// ---------------------------------------------------------------------------
// Persist executed documents
// ---------------------------------------------------------------------------

/** Freeze every contract block into a `contract_documents` row. Runs inside the
 *  accept transaction (quoteAcceptService), AFTER the billing-contract loop so
 *  `contractIds` exists and BEFORE the final quote re-select. Returns the
 *  inserted document ids. A thrown error (e.g. an uploaded block with no bytes)
 *  rolls the whole accept back — the atomicity requirement. */
export async function createExecutedDocuments(
  quote: QuoteRow,
  acceptanceId: string,
  contractIds: string[],
  renderData: ContractBlockRenderData[],
  blocks: ContractBlockLike[],
  effectiveDate: string,
): Promise<string[]> {
  if (renderData.length === 0) return [];

  const contentByBlockId = new Map(blocks.map((b) => [b.id, b.content]));
  // Link every executed document to the FIRST created billing contract:
  // buildContractSpecsFromQuote emits monthly-then-annual in a stable order, so
  // contractIds[0] is deterministic. The snapshot is a quote-level legal artifact
  // (not per-contract), so any single stable link is correct; null when the quote
  // produced no billing contract (e.g. a one-time-only quote with a contract block).
  const contractId = contractIds[0] ?? null;

  const insertedIds: string[] = [];
  for (const data of renderData) {
    let pdf: Buffer;
    let renderedHtml: string | null;

    if (data.sourceType === 'uploaded') {
      if (!data.fileData) {
        // A published uploaded version with no stored bytes can't be snapshotted —
        // fail the accept rather than persist an empty legal record.
        throw new QuoteServiceError(
          `Uploaded contract block ${data.blockId} has no stored file to snapshot`,
          500,
          'CONTRACT_RENDER_DATA_MISSING',
        );
      }
      pdf = data.fileData; // the stored file, verbatim
      renderedHtml = null;
    } else {
      const values = resolvedValuesForBlock(contentByBlockId.get(data.blockId), quote, effectiveDate);
      const first = substituteVariables(data.bodyHtml ?? '', values);
      let html = first.html;
      if (first.missing.length > 0) {
        // The send gate (findUnresolvedVariables, Task 12) should make this
        // unreachable, but a raw {{token}} must never reach an executed legal PDF.
        console.error('[contractDocumentService] unresolved variable(s) at accept-time snapshot', {
          blockId: data.blockId,
          quoteId: quote.id,
          missing: first.missing,
        });
        captureException(new Error(
          `[contractDocumentService] unresolved variable(s) at accept-time snapshot: blockId=${data.blockId} quoteId=${quote.id} missing=${first.missing.join(',')}`
        ));
        html = substituteVariables(html, Object.fromEntries(first.missing.map((n) => [n, '']))).html;
      }
      // Re-sanitize the FINAL substituted HTML before it becomes the executed legal
      // record: a variable value substituted into an href (`<a href="{{link}}">`)
      // is HTML-escaped but not scheme-checked, so a `javascript:`/protocol-relative
      // value would otherwise land in the stored rendered_html AND the generated PDF
      // as a live /URI annotation. Write-time sanitize predates the substitution
      // (same defense as the serving-point render paths).
      html = sanitizeRichTextHtml(html);
      renderedHtml = html;
      pdf = await renderAuthoredContractPdf(data.templateName, html, quote, effectiveDate);
    }

    const sha256 = createHash('sha256').update(pdf).digest('hex');
    const [row] = await db
      .insert(contractDocuments)
      .values({
        orgId: quote.orgId,
        quoteId: quote.id,
        quoteAcceptanceId: acceptanceId,
        contractId,
        templateId: data.templateId,
        templateVersionId: data.templateVersionId,
        renderedHtml,
        pdfData: pdf,
        byteSize: pdf.length,
        sha256,
      })
      .returning({ id: contractDocuments.id });
    insertedIds.push(row!.id);
  }
  return insertedIds;
}

// ---------------------------------------------------------------------------
// Task 18: API surfaces for executed documents — list (per-contract or
// unattached), stream the raw PDF, and link a previously-unattached document
// to a contract after the fact.
// ---------------------------------------------------------------------------

// Every code this service actually raises — literal union so a typo'd/renamed
// code is a compile error, not a silently-mismatched string. Same idiom as
// ContractTemplateServiceErrorCode.
export type ContractDocumentServiceErrorCode =
  | 'DOCUMENT_NOT_FOUND'
  | 'ORG_DENIED'
  | 'ALREADY_LINKED'
  | 'CONTRACT_NOT_FOUND'
  | 'DOCUMENT_LINK_FAILED';

export class ContractDocumentServiceError extends Error {
  constructor(
    message: string,
    // Literal union (not number) so Hono's c.json(status) overloads accept it
    // directly — same idiom as ContractTemplateServiceError.
    public status: 400 | 403 | 404 | 409 | 500,
    public code: ContractDocumentServiceErrorCode,
  ) {
    super(message);
    this.name = 'ContractDocumentServiceError';
  }
}

export type ContractDocumentRow = typeof contractDocuments.$inferSelect;

/** A `GET /contract-documents` list row: the raw document plus the joined
 *  display fields the web layer needs (template name/version, signer, quote
 *  number) so it never has to round-trip pdf_data or make N follow-up calls. */
export interface ContractDocumentListRow {
  id: string;
  orgId: string;
  contractId: string | null;
  quoteId: string | null;
  templateId: string;
  templateVersionId: string;
  templateName: string;
  templateVersionNumber: number;
  signerName: string | null;
  signedAt: Date | null;
  quoteNumber: string | null;
  byteSize: number;
  sha256: string;
  createdAt: Date;
}

/** List documents visible to `auth`, optionally narrowed to one contract or
 *  to unattached-only (contract_id IS NULL). `contractId` takes priority over
 *  `unattached` if both are somehow passed — the caller's org-access
 *  condition (Shape-1 direct org_id) is ANDed in regardless, so a contractId
 *  belonging to an org outside the caller's access simply yields an empty
 *  list rather than leaking rows via app-layer filtering alone (RLS agrees). */
export async function listContractDocuments(
  auth: AuthContext,
  opts: { contractId?: string; unattached?: boolean } = {},
): Promise<ContractDocumentListRow[]> {
  const conditions: SQL[] = [];
  const accessCond = auth.orgCondition(contractDocuments.orgId);
  if (accessCond) conditions.push(accessCond);
  if (opts.contractId) {
    conditions.push(eq(contractDocuments.contractId, opts.contractId));
  } else if (opts.unattached) {
    conditions.push(isNull(contractDocuments.contractId));
  }

  return db
    .select({
      id: contractDocuments.id,
      orgId: contractDocuments.orgId,
      contractId: contractDocuments.contractId,
      quoteId: contractDocuments.quoteId,
      templateId: contractDocuments.templateId,
      templateVersionId: contractDocuments.templateVersionId,
      templateName: contractTemplates.name,
      templateVersionNumber: contractTemplateVersions.versionNumber,
      signerName: quoteAcceptances.signerName,
      signedAt: quoteAcceptances.signedAt,
      quoteNumber: quotes.quoteNumber,
      byteSize: contractDocuments.byteSize,
      sha256: contractDocuments.sha256,
      createdAt: contractDocuments.createdAt,
    })
    .from(contractDocuments)
    .innerJoin(contractTemplates, eq(contractDocuments.templateId, contractTemplates.id))
    .innerJoin(contractTemplateVersions, eq(contractDocuments.templateVersionId, contractTemplateVersions.id))
    .leftJoin(quoteAcceptances, eq(contractDocuments.quoteAcceptanceId, quoteAcceptances.id))
    .leftJoin(quotes, eq(contractDocuments.quoteId, quotes.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(contractDocuments.createdAt));
}

/** Fetch-by-id + org-access gate, shared by the pdf-stream and link paths. */
async function getDocumentOr404(auth: AuthContext, id: string): Promise<ContractDocumentRow> {
  const [row] = await db.select().from(contractDocuments).where(eq(contractDocuments.id, id)).limit(1);
  if (!row) throw new ContractDocumentServiceError('Contract document not found', 404, 'DOCUMENT_NOT_FOUND');
  if (!auth.canAccessOrg(row.orgId)) {
    throw new ContractDocumentServiceError('Organization access denied', 403, 'ORG_DENIED');
  }
  return row;
}

/** The raw bytes + metadata for `GET /contract-documents/:id/pdf`. */
export async function getContractDocumentPdf(
  auth: AuthContext,
  id: string,
): Promise<{ pdfData: Buffer; mime: string; byteSize: number; sha256: string }> {
  const doc = await getDocumentOr404(auth, id);
  return { pdfData: doc.pdfData, mime: doc.mime, byteSize: doc.byteSize, sha256: doc.sha256 };
}

/**
 * Link-later: attach a previously-unattached document (contract_id NULL — the
 * common case for a quote accepted before its billing contract existed, or a
 * contract created after the fact) to a contract. The target contract MUST
 * belong to the SAME org as the document — a document is an org-owned legal
 * record and never crosses org boundaries, even when the caller's token can
 * access both orgs. Mismatch and not-found collapse to the same 404
 * message/code (sibling idiom: groups.ts / alerts/rules.ts "not found or
 * belongs to a different organization") so the response never signals
 * whether a same-ID contract exists in another tenant.
 */
export async function linkContractDocument(
  auth: AuthContext,
  id: string,
  contractId: string,
): Promise<ContractDocumentRow> {
  const doc = await getDocumentOr404(auth, id);

  // Link-later is for UNATTACHED documents only. A document already filed under a
  // contract must not be silently re-filed under a different billing contract —
  // that would rewrite an executed legal record's linkage. Reject with 409.
  if (doc.contractId !== null) {
    throw new ContractDocumentServiceError(
      'Contract document is already linked to a contract',
      409,
      'ALREADY_LINKED',
    );
  }

  const [contract] = await db
    .select({ id: contracts.id, orgId: contracts.orgId })
    .from(contracts)
    .where(eq(contracts.id, contractId))
    .limit(1);
  if (!contract || contract.orgId !== doc.orgId) {
    throw new ContractDocumentServiceError(
      'Contract not found or belongs to a different organization',
      404,
      'CONTRACT_NOT_FOUND',
    );
  }

  const [updated] = await db
    .update(contractDocuments)
    .set({ contractId })
    .where(eq(contractDocuments.id, id))
    .returning();
  if (!updated) throw new ContractDocumentServiceError('Failed to link contract document', 500, 'DOCUMENT_LINK_FAILED');
  return updated;
}
