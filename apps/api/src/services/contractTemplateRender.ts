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

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { ContractVariable } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { contractTemplates, contractTemplateVersions, quotes } from '../db/schema';
import { sanitizeRichTextHtml } from './richTextSanitize';
import { formatMoney, formatDate, contractUploadedMarker, type ContractPdfBlockData } from './quotePdf';
import type { SellerSnapshot, BillToAddress } from './sellerSnapshot';
import { ContractTemplateServiceError } from './contractTemplateService';
import { QuoteServiceError } from './quoteTypes';

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
 * Version content is immutable, so read-before-transaction is safe.
 *
 * `includeFileData` (default false): an uploaded version's `file_data` bytea can
 * be up to 10MB, and the common paths (quote view/send-gate/preview) never touch
 * it — only the merge/stream/snapshot paths do. Leave it out of the SELECT by
 * default so a plain quote view doesn't round-trip a multi-MB blob per contract
 * block; pass true on the PDF-merge, contract-file-stream, and accept-snapshot
 * paths that actually read the bytes. */
export async function loadContractBlockRenderData(
  blocks: Array<{ id: string; blockType: string; content: unknown }>,
  opts?: { includeFileData?: boolean }
): Promise<ContractBlockRenderData[]> {
  const includeFileData = opts?.includeFileData ?? false;
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
      // Explicit column set (never the up-to-10MB file_data unless asked) — a
      // quote view resolves N contract versions and must not drag their blobs.
      const versionColumns = {
        id: contractTemplateVersions.id,
        templateId: contractTemplateVersions.templateId,
        sourceType: contractTemplateVersions.sourceType,
        bodyHtml: contractTemplateVersions.bodyHtml,
        sha256: contractTemplateVersions.sha256,
        declaredVariables: contractTemplateVersions.declaredVariables,
        versionNumber: contractTemplateVersions.versionNumber,
        ...(includeFileData ? { fileData: contractTemplateVersions.fileData } : {}),
      };
      const versions = await db
        .select(versionColumns)
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
        // fileData is only present on the row when includeFileData selected it.
        const fileData =
          includeFileData && version.sourceType === 'uploaded'
            ? ((version as { fileData?: Buffer | null }).fileData ?? null)
            : null;
        result.push({
          blockId: block.id,
          templateId: version.templateId,
          templateVersionId: version.id,
          sourceType: version.sourceType,
          bodyHtml: version.sourceType === 'authored' ? sanitizeRichTextHtml(version.bodyHtml ?? '') : null,
          fileData,
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
// Admin-only authoring fields
// ---------------------------------------------------------------------------

/** The raw authoring fields of a `contract` block, resolved for the ADMIN quote
 *  editor ONLY. The client render shape (ContractClientBlockContent) deliberately
 *  strips these — portal/public tenant-facing payloads must NEVER carry them —
 *  but the editor needs them to render the manual-variable form, know auto vs
 *  manual without a second fetch, and offer an explicit version-update nudge.
 *  `latestPublishedVersion*` are the newest PUBLISHED version of the SAME
 *  template (null when the pinned version already is the latest / none exists),
 *  so the editor can show "Update to vN" and re-pin without guessing. */
export interface ContractBlockAuthoring {
  templateId: string;
  templateVersionId: string;
  variableValues: Record<string, string>;
  declaredVariables: ContractVariable[];
  latestPublishedVersionId: string | null;
  latestPublishedVersionNumber: number | null;
}

function parseVariableValues(content: unknown): Record<string, string> {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return {};
  const vv = (content as Record<string, unknown>).variableValues;
  if (!vv || typeof vv !== 'object' || Array.isArray(vv)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vv as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** Resolve the ADMIN-only authoring fields for a quote's `contract` blocks. Same
 *  system-context contract as loadContractBlockRenderData (dual-axis template
 *  rows are invisible to org-scoped RLS; version content is immutable so a
 *  read-before-transaction is safe). Returns a blockId→authoring map; blocks
 *  whose pinned version is missing are simply omitted (the render path is the
 *  authority that raises VERSION_NOT_FOUND — this loader must not double-throw). */
export async function loadContractBlockAuthoring(
  blocks: Array<{ id: string; blockType: string; content: unknown }>
): Promise<Map<string, ContractBlockAuthoring>> {
  const contractBlocks = blocks
    .filter((b) => b.blockType === 'contract')
    .map((block) => ({ block, parsed: parseContractBlockContent(block.content) }))
    .filter((x): x is { block: (typeof blocks)[number]; parsed: ContractBlockContent } => x.parsed !== null);
  if (contractBlocks.length === 0) return new Map();

  const versionIds = [...new Set(contractBlocks.map((x) => x.parsed.templateVersionId))];

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const versions = await db
        .select()
        .from(contractTemplateVersions)
        .where(inArray(contractTemplateVersions.id, versionIds));
      const versionById = new Map(versions.map((v) => [v.id, v]));

      const templateIds = [...new Set(versions.map((v) => v.templateId))];
      // Latest PUBLISHED version per template (desc versionNumber → first seen is
      // the latest) so the editor can nudge to a newer published version.
      const published =
        templateIds.length > 0
          ? await db
              .select({
                id: contractTemplateVersions.id,
                templateId: contractTemplateVersions.templateId,
                versionNumber: contractTemplateVersions.versionNumber,
              })
              .from(contractTemplateVersions)
              .where(and(inArray(contractTemplateVersions.templateId, templateIds), eq(contractTemplateVersions.status, 'published')))
              .orderBy(desc(contractTemplateVersions.versionNumber))
          : [];
      const latestPublishedByTemplate = new Map<string, { id: string; versionNumber: number }>();
      for (const v of published) {
        if (!latestPublishedByTemplate.has(v.templateId)) latestPublishedByTemplate.set(v.templateId, { id: v.id, versionNumber: v.versionNumber });
      }

      const map = new Map<string, ContractBlockAuthoring>();
      for (const { block, parsed } of contractBlocks) {
        const version = versionById.get(parsed.templateVersionId);
        if (!version || version.templateId !== parsed.templateId) continue;
        const latestPublished = latestPublishedByTemplate.get(version.templateId) ?? null;
        map.set(block.id, {
          templateId: version.templateId,
          templateVersionId: version.id,
          variableValues: parseVariableValues(block.content),
          declaredVariables: (version.declaredVariables as ContractVariable[] | null) ?? [],
          latestPublishedVersionId: latestPublished?.id ?? null,
          latestPublishedVersionNumber: latestPublished?.versionNumber ?? null,
        });
      }
      return map;
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
export function resolveAutoVariables(quote: QuoteRow, opts?: { effectiveDate?: string | Date }): Record<string, string> {
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

/** The {{dates.effective}} value a DISPLAY render should use for a quote: for an
 *  accepted/converted quote the effective date is pinned to the accept date (so
 *  a post-acceptance view matches the executed snapshot instead of drifting to
 *  the viewing date); an un-accepted quote defaults to "today". */
function displayEffectiveDate(quote: QuoteRow): Date | undefined {
  if ((quote.status === 'accepted' || quote.status === 'converted') && quote.acceptedAt) {
    return quote.acceptedAt;
  }
  return undefined;
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
 *  a TENANT-FACING client (portal, public link) — never the raw
 *  templateId/templateVersionId/variableValues authoring shape. The `authoring`
 *  key is deliberately absent from this interface (not just unset) so a stray
 *  `content.authoring = ...` assignment against a `ContractClientBlockContent`-
 *  typed value is a compile error, not just an unused write. */
export interface ContractClientBlockContent {
  label?: string;
  templateName: string;
  versionNumber: number;
  sourceType: 'authored' | 'uploaded';
  renderedHtml: string | null;
  fileUrl: string | null;
}

/** The ADMIN-only variant of `ContractClientBlockContent`: everything a
 *  tenant-facing client gets, PLUS the raw authoring fields the in-app quote
 *  editor needs (manual-variable form, auto-vs-manual split, version-update
 *  nudge). This is the ONLY block-content shape allowed to carry `authoring` —
 *  attachContractAuthoring below is the ONLY place that constructs one, and it
 *  is called exclusively from the authenticated admin quote route
 *  (routes/quotes/quotes.ts). Portal/public routes never import
 *  loadContractBlockAuthoring or this type. */
export type ContractAdminBlockContent = ContractClientBlockContent & {
  authoring?: ContractBlockAuthoring;
};

/** Build the client-facing `content` for a single resolved `contract` block —
 *  the one place that turns pinned-version render data + a block's raw
 *  (authoring) content into the public/portal/admin-safe shape. Extracted to
 *  its own function (rather than inlined in the `.map()` below) so the
 *  `: ContractClientBlockContent` return annotation's excess-property check
 *  guards this construction specifically: adding an `authoring` (or any other
 *  undeclared) key to the returned literal is a compile error here, not just
 *  a runtime possibility caught only by a route-level test. */
function buildContractClientContent(
  block: { id: string; content: unknown },
  data: ContractBlockRenderData,
  autoValues: Record<string, string>,
  quote: QuoteRow,
  fileUrlFor: (blockId: string) => string
): ContractClientBlockContent {
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
    let html = first.html;
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
      html = substituteVariables(html, blanks).html;
    }
    // Re-sanitize the FINAL substituted HTML before serving: a value
    // substituted into an href (`<a href="{{link}}">`) is HTML-escaped but not
    // scheme-checked, so a `javascript:` value would otherwise survive as a
    // live hostile link on the public/portal/admin dangerouslySetInnerHTML
    // paths. The write-time sanitize ran BEFORE the variable was in the attribute.
    renderedHtml = sanitizeRichTextHtml(html);
  }

  return {
    ...(label ? { label } : {}),
    templateName: data.templateName,
    versionNumber: data.versionNumber,
    sourceType: data.sourceType,
    renderedHtml,
    fileUrl: data.sourceType === 'uploaded' ? fileUrlFor(block.id) : null,
  };
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
 *  mirror the existing quote-image asset route under different mounts).
 *
 *  Every caller (public, portal, and the admin route before it separately
 *  layers `authoring` back on via attachContractAuthoring) gets this exact
 *  same tenant-safe shape — there is no second code path that builds
 *  `content` for a contract block. */
export async function renderContractBlocksForClient<T extends { id: string; blockType: string; content: unknown }>(
  blocks: T[],
  quote: QuoteRow,
  fileUrlFor: (blockId: string) => string
): Promise<T[]> {
  const renderData = await loadContractBlockRenderData(blocks);
  if (renderData.length === 0) return blocks;
  const byBlockId = new Map(renderData.map((d) => [d.blockId, d]));
  const autoValues = resolveAutoVariables(quote, { effectiveDate: displayEffectiveDate(quote) });

  return blocks.map((block) => {
    const data = byBlockId.get(block.id);
    if (!data) return block;
    const content = buildContractClientContent(block, data, autoValues, quote, fileUrlFor);
    return { ...block, content };
  });
}

/** ADMIN-ONLY: layer the raw authoring fields (templateId/templateVersionId/
 *  variableValues + the pinned version's declaredVariables + latest-published
 *  nudge target) back onto an already-rendered block's content, for the
 *  in-app quote editor's manual-variable form and version-update affordance.
 *  Call this AFTER renderContractBlocksForClient, on its output — never
 *  before. `authoring` is keyed by blockId (loadContractBlockAuthoring's
 *  return shape); a block with no entry (non-contract, or its pinned version
 *  failed to resolve) passes through unchanged.
 *
 *  This is the ONLY function in the codebase that constructs a
 *  ContractAdminBlockContent — the admin quote route (routes/quotes/quotes.ts)
 *  is its only caller. Portal/public routes must never call this. */
export function attachContractAuthoring<T extends { id: string; blockType: string; content: unknown }>(
  blocks: T[],
  authoring: Map<string, ContractBlockAuthoring>
): T[] {
  if (authoring.size === 0) return blocks;
  return blocks.map((block) => {
    const a = authoring.get(block.id);
    if (!a || block.blockType !== 'contract') return block;
    const content: ContractAdminBlockContent = { ...(block.content as ContractClientBlockContent), authoring: a };
    return { ...block, content };
  });
}

// ---------------------------------------------------------------------------
// PDF-only inputs (Task 14: quotePdf.ts's cover page + contract block render,
// and pdfMerge.ts's uploaded-PDF append step)
// ---------------------------------------------------------------------------

/** Build the two PDF-only inputs a `contract` block needs at PDF-render time:
 *  the `contractRenderData` Map renderQuotePdf consumes to draw an authored
 *  block's substituted HTML (or an uploaded block's one-line marker), and the
 *  upload list the route hands to pdfMerge.ts's mergeUploadedContractPdfs.
 *
 *  Deliberately a SEPARATE function from renderContractBlocksForClient rather
 *  than a shared helper the two call into — they return different shapes for
 *  different consumers (a client JSON block-content array vs. a renderer Map +
 *  upload list) and would gain nothing from forcing a common return type. The
 *  substitution logic itself (auto+manual variable merge, defensive blank-fill
 *  on an unreachable-but-still-defended unresolved variable) is intentionally
 *  duplicated in lockstep with that function — see its own comment for why the
 *  blank-fill exists.
 *
 *  Calls loadContractBlockRenderData internally (same system-context read, same
 *  "call me outside any org-scoped transaction" contract as every other
 *  function in this file that touches it). */
export async function loadContractPdfInputs(
  blocks: Array<{ id: string; blockType: string; content: unknown }>,
  quote: QuoteRow
): Promise<{ contractRenderData: Map<string, ContractPdfBlockData>; uploads: Array<{ afterMarker: string; data: Buffer }> }> {
  const contractRenderData = new Map<string, ContractPdfBlockData>();
  const uploads: Array<{ afterMarker: string; data: Buffer }> = [];

  // includeFileData: this path appends uploaded contract PDFs into the merged
  // document, so it needs the actual bytes (unlike the client view path).
  const renderData = await loadContractBlockRenderData(blocks, { includeFileData: true });
  if (renderData.length === 0) return { contractRenderData, uploads };

  const byBlockId = new Map(renderData.map((d) => [d.blockId, d]));
  const autoValues = resolveAutoVariables(quote, { effectiveDate: displayEffectiveDate(quote) });

  for (const block of blocks) {
    const data = byBlockId.get(block.id);
    if (!data) continue;

    if (data.sourceType === 'authored') {
      const raw =
        block.content && typeof block.content === 'object' && !Array.isArray(block.content)
          ? (block.content as Record<string, unknown>)
          : {};
      const manualValues =
        raw.variableValues && typeof raw.variableValues === 'object' && !Array.isArray(raw.variableValues)
          ? (raw.variableValues as Record<string, string>)
          : {};
      const values = { ...autoValues, ...manualValues };
      const first = substituteVariables(data.bodyHtml ?? '', values);
      let html = first.html;
      if (first.missing.length > 0) {
        // Same defensive blank-fill as renderContractBlocksForClient above — the
        // send gate (findUnresolvedVariables) should make this unreachable, but
        // a raw {{token}} must never reach a rendered PDF either.
        console.error('[contractTemplateRender] unresolved variable(s) at PDF render time', {
          blockId: block.id,
          quoteId: quote.id,
          missing: first.missing,
        });
        const blanks = Object.fromEntries(first.missing.map((name) => [name, '']));
        html = substituteVariables(html, blanks).html;
      }
      // Re-sanitize the FINAL substituted HTML: same href-injection guard as the
      // client render path — a `javascript:`/protocol-relative variable value
      // substituted into an `<a href>` would otherwise reach the PDF renderer as
      // a live link annotation. Write-time sanitize predates the substitution.
      contractRenderData.set(block.id, { html: sanitizeRichTextHtml(html), templateName: data.templateName });
    } else {
      if (!data.fileData) {
        // A published uploaded version with no stored bytes can't be appended —
        // without this the PDF would still render the "attached below" marker
        // (contractRenderData below) for an attachment that never shows up, a
        // legal-integrity bug. Fail loudly instead, same code as the accept-time
        // guard for the identical condition (contractDocumentService.ts).
        throw new QuoteServiceError(
          `Uploaded contract block ${block.id} has no stored file to render`,
          500,
          'CONTRACT_RENDER_DATA_MISSING',
        );
      }
      contractRenderData.set(block.id, { html: null, templateName: data.templateName });
      uploads.push({ afterMarker: contractUploadedMarker(data.templateName), data: data.fileData });
    }
  }

  return { contractRenderData, uploads };
}
