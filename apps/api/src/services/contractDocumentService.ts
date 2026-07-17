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
import { db } from '../db';
import { contractDocuments } from '../db/schema/contractDocuments';
import { QuoteServiceError } from './quoteTypes';
import type { HashableContractPart } from './quoteContentHash';
import {
  resolveAutoVariables,
  substituteVariables,
  type ContractBlockRenderData,
  type QuoteRow,
} from './contractTemplateRender';
import { renderRichTextIntoPdf } from './richTextPdf';
import { formatDate } from './quotePdf';

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
        html = substituteVariables(html, Object.fromEntries(first.missing.map((n) => [n, '']))).html;
      }
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
