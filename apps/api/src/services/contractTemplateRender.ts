// Contract block render data + `{{variable}}` substitution (Task 10 of the
// contract documents + enhanced proposals plan, docs/superpowers/plans/
// 2026-07-16-contract-documents-and-enhanced-proposals.md).
//
// Three independent concerns live here:
//  1. loadContractBlockRenderData — resolve a quote's `contract` blocks'
//     pinned template versions. MUST run under withSystemDbAccessContext:
//     contract_templates/contract_template_versions are dual-axis
//     (org_id XOR partner_id) tables, and a partner-wide template row is
//     INVISIBLE to an org-scoped RLS context (portal/public render paths) —
//     same trap as the heartbeat probe-config precedent (#1105). Published
//     version content is immutable, so reading it ahead of (outside) any
//     org-scoped transaction is safe — it can never see a value that later
//     changes underneath the caller.
//  2. resolveAutoVariables — derive the AUTO_CONTRACT_VARIABLES values from a
//     quote row (money via quotePdf's formatMoney so a contract's totals
//     render byte-identical to the quote PDF's own summary).
//  3. substituteVariables / findUnresolvedVariables — pure text substitution
//     and unresolved-variable reporting, no DB involved.

import { inArray } from 'drizzle-orm';
import type { ContractVariable } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { contractTemplates, contractTemplateVersions, quotes } from '../db/schema';
import { sanitizeRichTextHtml } from './richTextSanitize';
import { formatMoney, formatDate } from './quotePdf';
import type { SellerSnapshot, BillToAddress } from './sellerSnapshot';
import { ContractTemplateServiceError } from './contractTemplateService';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContractBlockRenderData = {
  blockId: string;
  templateId: string;
  templateVersionId: string;
  sourceType: 'authored' | 'uploaded';
  bodyHtml: string | null; // authored only (sanitized at write; re-sanitized here)
  fileData: Buffer | null; // uploaded only
  versionSha256: string; // from the version row
  declaredVariables: ContractVariable[];
  templateName: string;
  versionNumber: number;
};

// Decoupled from the full Drizzle row only insofar as it IS the full row —
// resolveAutoVariables is always called with an already-fetched quote (the
// caller already has the whole thing in hand for the render), so there is no
// benefit to a narrower hand-rolled shape here the way quotePdf.ts's
// QuoteHeader decouples from a partial select.
export type QuoteRow = typeof quotes.$inferSelect;

// A quote block's `content` for blockType==='contract' (packages/shared's
// quoteBlockInputSchema `contractContent`, not re-exported from there — kept
// as a loose local shape since this loader only reads three fields out of it
// and shouldn't need to import the zod schema just to type-narrow `unknown`).
interface ContractBlockContent {
  templateId: string;
  templateVersionId: string;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

function parseContractBlockContent(content: unknown): ContractBlockContent | null {
  if (!content || typeof content !== 'object') return null;
  const c = content as Record<string, unknown>;
  if (typeof c.templateId !== 'string' || typeof c.templateVersionId !== 'string') return null;
  return { templateId: c.templateId, templateVersionId: c.templateVersionId };
}

/** Resolve every contract block's pinned version content. MUST be called OUTSIDE
 * any org-scoped transaction: runs under withSystemDbAccessContext because
 * partner-owned template rows are invisible to org-scoped RLS contexts (portal!).
 * Version content is immutable, so read-before-transaction is safe. */
export async function loadContractBlockRenderData(
  blocks: Array<{ id: string; blockType: string; content: unknown }>
): Promise<ContractBlockRenderData[]> {
  const contractBlocks = blocks
    .filter((b) => b.blockType === 'contract')
    .map((block) => ({ block, parsed: parseContractBlockContent(block.content) }))
    .filter((x): x is { block: (typeof blocks)[number]; parsed: ContractBlockContent } => x.parsed !== null);
  if (contractBlocks.length === 0) return [];

  const versionIds = [...new Set(contractBlocks.map((x) => x.parsed.templateVersionId))];

  // runOutsideDbContext + withSystemDbAccessContext, mirroring
  // vulnerabilityFleetQueries.ts / commandQueue.ts: even though the caller's
  // contract says "call me outside any org-scoped transaction", wrapping
  // defensively here means an accidental nested call reuses the ambient
  // context rather than a silently-wrong one going undetected (withDbAccessContext
  // no-ops onto an already-open store — see db/index.ts).
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const versions = await db
        .select()
        .from(contractTemplateVersions)
        .where(inArray(contractTemplateVersions.id, versionIds));
      const versionById = new Map(versions.map((v) => [v.id, v]));

      const templateIds = [...new Set(versions.map((v) => v.templateId))];
      const templates =
        templateIds.length > 0
          ? await db.select().from(contractTemplates).where(inArray(contractTemplates.id, templateIds))
          : [];
      const templateById = new Map(templates.map((t) => [t.id, t]));

      const result: ContractBlockRenderData[] = [];
      for (const { block, parsed } of contractBlocks) {
        const version = versionById.get(parsed.templateVersionId);
        if (!version || version.templateId !== parsed.templateId) {
          throw new ContractTemplateServiceError(
            `Contract block ${block.id} references a missing or mismatched template version`,
            404,
            'VERSION_NOT_FOUND'
          );
        }
        const template = templateById.get(version.templateId);
        result.push({
          blockId: block.id,
          templateId: version.templateId,
          templateVersionId: version.id,
          sourceType: version.sourceType,
          bodyHtml: version.sourceType === 'authored' ? sanitizeRichTextHtml(version.bodyHtml ?? '') : null,
          fileData: version.sourceType === 'uploaded' ? (version.fileData ?? null) : null,
          versionSha256: version.sha256 ?? '',
          declaredVariables: (version.declaredVariables as ContractVariable[] | null) ?? [],
          templateName: template?.name ?? '',
          versionNumber: version.versionNumber,
        });
      }
      return result;
    })
  );
}

// ---------------------------------------------------------------------------
// Auto variable resolution
// ---------------------------------------------------------------------------

/** Same 3-line address join used by quotePdf.ts/invoicePdf.ts's local
 *  `addressLines()` (multi-line PDF layout), collapsed to one comma-joined
 *  string here since a contract variable substitutes inline into flowing text. */
function formatAddressLine(addr: BillToAddress | null | undefined): string {
  if (!addr) return '';
  const cityLine = [addr.city, addr.region, addr.postalCode].filter(Boolean).join(', ');
  return [addr.line1, addr.line2, cityLine, addr.country]
    .filter((s): s is string => !!s && s.trim().length > 0)
    .join(', ');
}

/** Resolve every AUTO_CONTRACT_VARIABLES entry from a quote row. Money is
 *  formatted via quotePdf's formatMoney (same helper the quote PDF's own
 *  summary uses) so a contract's totals never drift from the proposal's. */
export function resolveAutoVariables(quote: QuoteRow, opts?: { effectiveDate?: string }): Record<string, string> {
  const currency = quote.currencyCode ?? 'USD';
  const address = (quote.billToAddress as BillToAddress | null) ?? null;
  const seller = (quote.sellerSnapshot as SellerSnapshot | null) ?? null;

  return {
    'client.name': quote.billToName ?? '',
    'client.address': formatAddressLine(address),
    'seller.name': seller?.name ?? '',
    'quote.number': quote.quoteNumber ?? '',
    'quote.title': quote.title ?? '',
    'totals.one_time': formatMoney(quote.oneTimeTotal, currency),
    'totals.monthly': formatMoney(quote.monthlyRecurringTotal, currency),
    'totals.annual': formatMoney(quote.annualRecurringTotal, currency),
    'totals.total': formatMoney(quote.total, currency),
    'dates.effective': formatDate(opts?.effectiveDate ?? new Date()),
    'dates.expiry': formatDate(quote.expiryDate),
  };
}

// ---------------------------------------------------------------------------
// Substitution
// ---------------------------------------------------------------------------

// Matches a `{{ name }}` placeholder for substitution purposes. Deliberately
// unbounded (unlike contractTemplateService.ts's VARIABLE_TOKEN_RE, which
// caps at 64 chars to mirror contractVariableSchema's declared-variable name
// validation) — an over-long or otherwise-invalid token here just means it
// resolves to nothing and gets reported in `missing`, never validated.
const SUBSTITUTION_TOKEN_RE = /\{\{\s*([a-z][a-z0-9_.]*)\s*\}\}/g;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Substitute every `{{name}}` token with its HTML-escaped value. Unknown
 *  tokens (no entry in `values`) are left in place in the output AND
 *  collected into `missing` — callers use `missing` to block send/render
 *  rather than let a raw placeholder reach a legal document. */
export function substituteVariables(bodyHtml: string, values: Record<string, string>): { html: string; missing: string[] } {
  const missing = new Set<string>();
  const html = bodyHtml.replace(SUBSTITUTION_TOKEN_RE, (match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(values, name)) {
      return escapeHtml(values[name]!);
    }
    missing.add(name);
    return match;
  });
  return { html, missing: [...missing] };
}

/** Which of a block's declared variables have no resolved value yet — auto
 *  variables are looked up in `autoValues`, manual ones in `variableValues`.
 *  Used to gate send (spec: "Send is blocked while any declared variable is
 *  unresolved") ahead of ever calling substituteVariables. */
export function findUnresolvedVariables(
  data: ContractBlockRenderData,
  variableValues: Record<string, string>,
  autoValues: Record<string, string>
): string[] {
  const unresolved: string[] = [];
  for (const variable of data.declaredVariables) {
    const source = variable.kind === 'auto' ? autoValues : variableValues;
    if (!Object.prototype.hasOwnProperty.call(source, variable.name)) {
      unresolved.push(variable.name);
    }
  }
  return unresolved;
}

// ---------------------------------------------------------------------------
// Client-facing serialization (Task 13: portal/public/admin read paths)
// ---------------------------------------------------------------------------

/** Exact shape a `contract` quote block's `content` takes once serialized for
 *  ANY client (portal, public link, admin editor) — never the raw
 *  templateId/templateVersionId/variableValues authoring shape. */
export interface ContractClientBlockContent {
  label?: string;
  templateName: string;
  versionNumber: number;
  sourceType: 'authored' | 'uploaded';
  renderedHtml: string | null;
  fileUrl: string | null;
}

/** Replace every `contract` block's raw authoring content
 *  ({templateId, templateVersionId, variableValues, label}) with the
 *  client-facing render contract. Non-contract blocks pass through unchanged
 *  (compose with sanitizeQuoteBlocksForRead, which only touches rich_text).
 *
 *  Calls loadContractBlockRenderData FIRST — before building any of the
 *  client-facing content below — so the (self-escaping) system-context read
 *  of the dual-axis template/version rows always happens ahead of this
 *  function's own per-block work, exactly like the loader's own doc comment
 *  requires of its callers.
 *
 *  `fileUrlFor` builds the caller's own asset route (portal/public/admin all
 *  mirror the existing quote-image asset route under different mounts). */
export async function renderContractBlocksForClient<T extends { id: string; blockType: string; content: unknown }>(
  blocks: T[],
  quote: QuoteRow,
  fileUrlFor: (blockId: string) => string
): Promise<T[]> {
  const renderData = await loadContractBlockRenderData(blocks);
  if (renderData.length === 0) return blocks;
  const byBlockId = new Map(renderData.map((d) => [d.blockId, d]));
  const autoValues = resolveAutoVariables(quote);

  return blocks.map((block) => {
    const data = byBlockId.get(block.id);
    if (!data) return block;

    const raw =
      block.content && typeof block.content === 'object' && !Array.isArray(block.content)
        ? (block.content as Record<string, unknown>)
        : {};
    const manualValues =
      raw.variableValues && typeof raw.variableValues === 'object' && !Array.isArray(raw.variableValues)
        ? (raw.variableValues as Record<string, string>)
        : {};
    const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label : undefined;

    let renderedHtml: string | null = null;
    if (data.sourceType === 'authored') {
      const values = { ...autoValues, ...manualValues };
      const first = substituteVariables(data.bodyHtml ?? '', values);
      renderedHtml = first.html;
      if (first.missing.length > 0) {
        // The send gate (findUnresolvedVariables, Task 12) is supposed to block
        // send while any declared variable is unresolved — this should be
        // unreachable post-send. Substitute defensively anyway (never let a raw
        // {{token}} reach a rendered client payload) and log so a gate gap is
        // observable rather than silently shipping placeholder text.
        console.error('[contractTemplateRender] unresolved variable(s) at render time', {
          blockId: block.id,
          quoteId: quote.id,
          missing: first.missing,
        });
        const blanks = Object.fromEntries(first.missing.map((name) => [name, '']));
        renderedHtml = substituteVariables(renderedHtml, blanks).html;
      }
    }

    const content: ContractClientBlockContent = {
      ...(label ? { label } : {}),
      templateName: data.templateName,
      versionNumber: data.versionNumber,
      sourceType: data.sourceType,
      renderedHtml,
      fileUrl: data.sourceType === 'uploaded' ? fileUrlFor(block.id) : null,
    };
    return { ...block, content };
  });
}
