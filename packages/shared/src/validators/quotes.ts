import { z } from 'zod';
import { BULK_ID_LIMIT } from '../constants';
import { currencyCodeSchema } from './currency';
import {
  contractLineInvariantIssues, ALLOWANCE_LINE_TYPES, OVERAGE_MODES,
  type ContractLineShape,
} from './contracts';
import { BILLABLE_DEVICE_ROLES } from './deviceRoles';

// Bounded to numeric(12,2) (max 9,999,999,999.99) so out-of-range inputs fail
// fast with a 400 rather than overflowing at insert (DB-layer 500). Mirrors the
// money/quantity ceiling in validators/catalog.ts.
const money = z.number().nonnegative().max(9_999_999_999.99).multipleOf(0.01);
const positiveQty = z.number().positive().max(9_999_999_999.99).multipleOf(0.01);
// Same bound/precision as positiveQty but permits 0 — used where the value is a
// running tally that can legitimately be corrected back to zero (received_qty),
// unlike an ordered/line quantity which must always be > 0.
const nonnegativeQty = z.number().nonnegative().max(9_999_999_999.99).multipleOf(0.01);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const taxRate = z.number().min(0).max(1);

export const quoteStatusSchema = z.enum(['draft', 'sent', 'viewed', 'accepted', 'declined', 'expired', 'converted', 'superseded']);
export const quoteLineRecurrenceSchema = z.enum(['one_time', 'monthly', 'annual']);

/** The four contract line types a quote line may name. Deliberately the CONTRACT
 *  enum's values, so acceptance maps 1:1 with no translation table. Equal to
 *  W04's ALLOWANCE_LINE_TYPES today; asserted equal by a test so a divergence is
 *  caught rather than silently accepted (#3205 W05). */
export const QUOTE_DEVICE_SET_TYPES =
  ['per_device', 'per_device_role', 'per_device_group', 'per_seat'] as const;
export type QuoteDeviceSetType = typeof QUOTE_DEVICE_SET_TYPES[number];
const QUOTE_DEVICE_SET_TYPE_SET: ReadonlySet<string> = new Set(QUOTE_DEVICE_SET_TYPES);
const SITE_SCOPABLE_QUOTE_TYPES: ReadonlySet<string> = new Set(['per_device', 'per_device_role']);

const present = (v: unknown): boolean => v !== undefined && v !== null;
/** Quote money/quantities are NUMBERS; contract ones are 2dp STRINGS. The same
 *  conversion addManualLine already does at the service boundary. */
const str = (n: number | null | undefined): string | null | undefined =>
  n == null ? n : n.toFixed(2);

/** The descriptor as it appears on a quote line, in the QUOTE's conventions.
 *  Deliberately carries NO `quantity`: "the client may not set it" is a rule
 *  about who may WRITE the field, not a property of a row, and a stored line's
 *  quantity is always valid (spec decision 5). */
export interface QuoteLineDeviceSetShape {
  contractLineType?: QuoteDeviceSetType | null;
  recurrence: 'one_time' | 'monthly' | 'annual';
  parentLineId?: string | null;
  deviceRoles?: readonly string[] | null;
  deviceGroupId?: string | null;
  deviceGroupName?: string | null;
  siteId?: string | null;
  siteName?: string | null;
  includedQuantity?: number | null;
  overageMode?: 'bill' | 'flag' | null;
  overageUnitPrice?: number | null;
}

/**
 * The quote-line descriptor rules (#3205 W05). Does NOT restate
 * contractLineInputSchema's refines — it PROJECTS onto W03's ContractLineShape
 * and calls contractLineInvariantIssues, so roles / group / site / allowance can
 * never diverge between a quote line and the contract line it becomes (and
 * #4547's future additions arrive here for free).
 *
 * 'create'    — a new line: deviceGroupId required on a group line.
 * 'persisted' — a stored or merged row: deviceGroupId may be null (the orphan
 *               state the FK produces), the stamps are required.
 */
export function quoteLineDeviceSetIssues(
  l: QuoteLineDeviceSetShape, opts: { mode: 'create' | 'persisted' },
): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  const anyDescriptorColumn =
    present(l.deviceRoles) || present(l.deviceGroupId) || present(l.deviceGroupName)
    || present(l.siteId) || present(l.siteName)
    || present(l.includedQuantity) || present(l.overageMode) || present(l.overageUnitPrice);

  if (!present(l.contractLineType)) {
    if (anyDescriptorColumn) {
      issues.push({ path: 'contractLineType', message: 'a device set needs a contractLineType' });
    }
    return issues;   // an ordinary quote line: nothing else applies.
  }
  if (!QUOTE_DEVICE_SET_TYPE_SET.has(l.contractLineType!)) {
    issues.push({ path: 'contractLineType', message: 'contractLineType must be one of per_device, per_device_role, per_device_group, per_seat' });
    return issues;   // the projection below would be meaningless.
  }
  if (l.recurrence === 'one_time') {
    issues.push({ path: 'recurrence', message: 'a device set is only valid on a monthly or annual line — a one-time charge has no billing period to count in' });
  }
  if (present(l.parentLineId)) {
    issues.push({ path: 'parentLineId', message: 'a bundle component cannot carry its own device set' });
  }
  // #4693's site-stamp rules come from the delegated contract helper below and are
  // persisted-only there: siteName is never a create input (the writer stamps it).

  // Delegate the rest. `path` is re-mapped lineType → contractLineType so the
  // caller's error points at the field the quote API actually exposes.
  const projected: ContractLineShape = {
    lineType: l.contractLineType as ContractLineShape['lineType'],
    manualQuantity: undefined,
    siteId: l.siteId,
    siteName: l.siteName,
    deviceRoles: l.deviceRoles,
    deviceGroupId: l.deviceGroupId,
    deviceGroupName: l.deviceGroupName,
    includedQuantity: str(l.includedQuantity),
    overageMode: l.overageMode,
    overageUnitPrice: str(l.overageUnitPrice),
  };
  // The contract create schema owns `.min(1)`, so its invariant helper reports
  // an empty role set only in persisted mode. This helper is also a public row
  // checker, so inherit that same contract-side issue here without restating it.
  if (opts.mode === 'create' && l.deviceRoles?.length === 0) {
    const emptyRolesIssue = contractLineInvariantIssues(projected, { mode: 'persisted' })
      .find((issue) => issue.path === 'deviceRoles');
    if (emptyRolesIssue) issues.push(emptyRolesIssue);
  }
  for (const issue of contractLineInvariantIssues(projected, opts)) {
    issues.push({ path: issue.path === 'lineType' ? 'contractLineType' : issue.path, message: issue.message });
  }
  return issues;
}

export const quoteLineSourceTypeSchema = z.enum(['catalog', 'bundle', 'manual']);
export const quoteBlockTypeSchema = z.enum(['heading', 'rich_text', 'image', 'line_items', 'contract', 'table', 'callout']);
export const quoteDepositTypeSchema = z.enum(['none', 'percent', 'selected_lines']);

// Whole-percent, 2dp, exclusive bounds per spec (100% = "no deposit" — rejected).
const depositPercent = z.number().gt(0).lt(100).multipleOf(0.01);

// Block content shapes, discriminated by blockType.
const headingContent = z.object({ text: z.string().min(1).max(300), level: z.number().int().min(1).max(3).default(2) });
const richTextContent = z.object({ html: z.string().max(50_000) });
const imageContent = z.object({ imageId: z.string().guid(), caption: z.string().max(500).optional(), width: z.number().int().min(50).max(2000).optional() });
// `showSubtotal` opts this pricing table into a per-table subtotal row (summed
// from its own lines, split by recurrence). Off by default so existing tables
// render unchanged.
const lineItemsContent = z.object({ label: z.string().max(200).optional(), showSubtotal: z.boolean().optional() });
// A rendered contract embedded in the quote: references a specific (immutable)
// published template version, plus manual-variable fill-ins keyed by
// contractVariableSchema's `name` (validated at render time, not here — a
// quote block shouldn't need to know a template's declared variable set to
// parse). `variableValues` defaults to {} so a fresh block round-trips without
// the caller pre-seeding an empty object.
const contractContent = z.object({
  templateId: z.string().guid(),
  templateVersionId: z.string().guid(),
  variableValues: z.record(z.string(), z.string().max(2000)).default({}),
  label: z.string().max(200).optional(),
});

// Table: structured JSON, never HTML-parsed. Inline-HTML strings (cells/labels)
// are sanitized server-side with the inline-only profile (richTextSanitize).
// Hard caps: 8 cols x 100 rows x 2000 chars — unbounded content is a
// memory/PDF-layout DoS surface (spec §4).
const tableColumn = z.object({
  label: z.string().max(200),
  align: z.enum(['left', 'center', 'right']).optional(),
  weight: z.number().int().min(1).max(10).optional(),
});
// Exported (not just inferred as a type) so the read-path defense-in-depth
// sanitizer (quoteService.sanitizeQuoteBlocksForRead) can safeParse stored
// JSONB against the same shape write validated, without duplicating it.
export const quoteTableContentSchema = z.object({
  columns: z.array(tableColumn).min(1).max(8),
  rows: z.array(z.object({ cells: z.array(z.string().max(2000)) })).min(1).max(100),
  caption: z.string().max(300).optional(),
  zebra: z.boolean().optional(),
  headerStyle: z.enum(['accent', 'plain']).optional(),
}).superRefine((val, ctx) => {
  // Exact shape — no render-time padding/truncation, which would let displayed
  // content diverge from persisted/hashed content.
  val.rows.forEach((row, i) => {
    if (row.cells.length !== val.columns.length) {
      ctx.addIssue({ code: 'custom', path: ['rows', i, 'cells'], message: `row has ${row.cells.length} cells, expected ${val.columns.length}` });
    }
  });
});
const tableContent = quoteTableContentSchema;
export const quoteCalloutContentSchema = z.object({
  variant: z.enum(['info', 'accent', 'warn']),
  title: z.string().max(200).optional(),
  html: z.string().max(50_000), // same cap as rich_text
});
const calloutContent = quoteCalloutContentSchema;

export const quoteBlockInputSchema = z.discriminatedUnion('blockType', [
  z.object({ blockType: z.literal('heading'), content: headingContent }),
  z.object({ blockType: z.literal('rich_text'), content: richTextContent }),
  z.object({ blockType: z.literal('image'), content: imageContent }),
  z.object({ blockType: z.literal('line_items'), content: lineItemsContent }),
  z.object({ blockType: z.literal('contract'), content: contractContent }),
  z.object({ blockType: z.literal('table'), content: tableContent }),
  z.object({ blockType: z.literal('callout'), content: calloutContent }),
]);

export const quoteLineInputSchema = z.object({
  sourceType: quoteLineSourceTypeSchema,
  catalogItemId: z.string().guid().optional(),
  blockId: z.string().guid().optional(),
  // Title (mirrors catalog name). `description` is the optional blurb beneath it.
  // At least one must be non-empty (refined below) so a line is never blank.
  name: z.string().max(255).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  // Client may not set the quantity of a device-set line: the server derives it
  // from the same snapshot helpers that will bill it (decision 5). Required on
  // every other line exactly as today — enforced in the superRefine below,
  // which is the only place that can see whether a descriptor was submitted.
  quantity: positiveQty.optional(),
  unitPrice: money,
  taxable: z.boolean(),
  customerVisible: z.boolean().default(true),
  recurrence: quoteLineRecurrenceSchema.default('one_time'),
  termMonths: z.number().int().min(1).max(120).nullable().optional(),
  billingFrequency: z.enum(['monthly', 'annual']).nullable().optional(),
  unitCost: money.nullable().optional(),
  sku: z.string().max(100).nullable().optional(),
  partNumber: z.string().max(100).nullable().optional(),
  procurementSource: z.string().max(40).nullable().optional(),
  vendorSku: z.string().max(100).nullable().optional(),
  manufacturer: z.string().max(255).nullable().optional(),
  depositEligible: z.boolean().default(false),
  // #3205 W05: the device-set descriptor. deviceGroupName / siteName are NOT
  // input fields — the server resolves and stamps them.
  contractLineType: z.enum(QUOTE_DEVICE_SET_TYPES).optional(),
  deviceRoles: z.array(z.enum(BILLABLE_DEVICE_ROLES)).min(1).optional(),
  deviceGroupId: z.string().guid().optional(),
  siteId: z.string().guid().optional(),
  includedQuantity: z.number().int().positive().max(9_999_999_999).optional(),
  overageMode: z.enum(OVERAGE_MODES).optional(),
  overageUnitPrice: money.optional(),
}).refine((d) => Boolean(d.name?.trim() || d.description?.trim()), {
  message: 'A line needs a name or a description', path: ['name'],
}).superRefine((l, ctx) => {
  for (const issue of quoteLineDeviceSetIssues(l as never, { mode: 'create' })) {
    ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
  }
  if (l.contractLineType === undefined && l.quantity === undefined) {
    ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'quantity is required' });
  }
  if (l.contractLineType !== undefined && l.quantity !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'quantity is derived from the live device count on a device-set line — omit it' });
  }
});

export const catalogQuoteLineSchema = z.object({ catalogItemId: z.string().guid(), quantity: positiveQty, blockId: z.string().guid().optional(), partNumber: z.string().max(100).nullable().optional() });
export const bundleQuoteLineSchema = z.object({ bundleId: z.string().guid(), quantity: positiveQty, blockId: z.string().guid().optional() });

export const updateQuoteLineSchema = z.object({
  name: z.string().max(255).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  quantity: positiveQty.optional(),
  unitPrice: money.optional(),
  taxable: z.boolean().optional(),
  customerVisible: z.boolean().optional(),
  recurrence: quoteLineRecurrenceSchema.optional(),
  termMonths: z.number().int().min(1).max(120).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  unitCost: money.nullable().optional(),
  sku: z.string().max(100).nullable().optional(),
  partNumber: z.string().max(100).nullable().optional(),
  procurementSource: z.string().max(40).nullable().optional(),
  vendorSku: z.string().max(100).nullable().optional(),
  manufacturer: z.string().max(255).nullable().optional(),
  // Attach/replace (guid) or clear (null) the line's product image. Must be a
  // quote_images row on the same quote — the service enforces ownership.
  imageId: z.string().guid().nullable().optional(),
  depositEligible: z.boolean().optional(),
  // #3205 W05. deviceRoles / deviceGroupId are .optional() only: clearing either
  // leaves a row quote_lines_device_set_chk rejects. The other four are
  // .nullable().optional() because clearing each leaves a valid shape — W03's
  // own rule, applied unchanged.
  deviceRoles: z.array(z.enum(BILLABLE_DEVICE_ROLES)).min(1).optional(),
  deviceGroupId: z.string().guid().optional(),
  siteId: z.string().guid().nullable().optional(),
  includedQuantity: z.number().int().positive().max(9_999_999_999).nullable().optional(),
  overageMode: z.enum(OVERAGE_MODES).nullable().optional(),
  overageUnitPrice: money.nullable().optional(),
  // NO contractLineType: adding or removing a descriptor changes what the line
  // IS (W03's reasoning for lineType). Remove the line and add it again.
}).strict();

/** A quote_lines row in read-layer shape (null = not applicable). */
export interface PersistedQuoteLine extends QuoteLineDeviceSetShape {
  contractLineType: QuoteDeviceSetType | null;
  parentLineId: string | null;
  deviceRoles: readonly string[] | null;
  deviceGroupId: string | null;
  deviceGroupName: string | null;
  siteId: string | null;
  siteName: string | null;
  includedQuantity: number | null;
  overageMode: 'bill' | 'flag' | null;
  overageUnitPrice: number | null;
}
export type UpdateQuoteLineInput = z.infer<typeof updateQuoteLineSchema>;

/** Key-presence test for a tri-state patch field: `=== undefined` cannot tell
 *  "leave it alone" from "clear it"; key presence can. */
export function quoteLinePatchHasKey(patch: UpdateQuoteLineInput, key: keyof UpdateQuoteLineInput): boolean {
  return Object.prototype.hasOwnProperty.call(patch, key);
}

/**
 * Current persisted line ⊕ patch (#3205 W05). PURE, mirroring W03's
 * mergeContractLinePatch, so the service validates the MERGED row with
 * mode: 'persisted' and the editor can run the identical check before saving.
 *
 * contractLineType is never merged (not patchable). The two stamps are never
 * read from the patch: the service re-stamps them from the resolved group/site
 * AFTER the invariants run, and clearing siteId clears siteName with it.
 */
export function mergeQuoteLinePatch(current: PersistedQuoteLine, patch: UpdateQuoteLineInput): PersistedQuoteLine {
  const p = patch as Record<string, unknown>;
  return {
    ...current,
    recurrence: (p.recurrence as PersistedQuoteLine['recurrence']) ?? current.recurrence,
    deviceRoles: (p.deviceRoles as readonly string[] | undefined) ?? current.deviceRoles,
    deviceGroupId: (p.deviceGroupId as string | undefined) ?? current.deviceGroupId,
    deviceGroupName: current.deviceGroupName,
    siteId: quoteLinePatchHasKey(patch, 'siteId') ? ((p.siteId as string | null) ?? null) : current.siteId,
    siteName: quoteLinePatchHasKey(patch, 'siteId') ? (p.siteId ? current.siteName : null) : current.siteName,
    includedQuantity: quoteLinePatchHasKey(patch, 'includedQuantity') ? ((p.includedQuantity as number | null) ?? null) : current.includedQuantity,
    overageMode: quoteLinePatchHasKey(patch, 'overageMode') ? ((p.overageMode as 'bill' | 'flag' | null) ?? null) : current.overageMode,
    overageUnitPrice: quoteLinePatchHasKey(patch, 'overageUnitPrice') ? ((p.overageUnitPrice as number | null) ?? null) : current.overageUnitPrice,
  };
}

export const createQuoteSchema = z.object({
  orgId: z.string().guid(),
  siteId: z.string().guid().optional(),
  title: z.string().max(200).optional(),
  // Omit to inherit the partner's configured currency (resolved server-side in
  // createQuote); the DB column still defaults to 'USD' as a backstop (#3200).
  currencyCode: currencyCodeSchema.optional(),
  expiryDate: isoDate.optional(),
  introNotes: z.string().max(5000).optional(),
  terms: z.string().max(20_000).optional(),
  termsAndConditions: z.string().max(20_000).optional(),
});

// Optional retarget/rename for POST /quotes/:id/clone. Omitted fields fall back
// to the source quote. `.strict()` so a mis-keyed field is a 400, not silently
// ignored (mirrors sendBodySchema).
export const cloneQuoteSchema = z.object({
  orgId: z.string().guid().optional(),
  title: z.string().max(200).optional(),
}).strict();

// Enhanced-proposals cover page (docs/superpowers/specs/billing/2026-07-16-contract-documents-and-enhanced-proposals-design.md).
// Stored as quotes.cover_page jsonb; `enabled: false` is a valid, minimal
// payload (the customer-visible cover page toggled off) — every other field
// is optional/nullable so a partial edit doesn't force re-sending the whole
// object. `showPreparedBy` defaults true so existing quotes (no stored
// cover_page yet) that opt in for the first time show the preparer by default.
export const coverPageSchema = z.object({
  enabled: z.boolean(),
  title: z.string().max(200).optional(),
  coverImageId: z.string().guid().nullable().optional(),
  preparedForName: z.string().max(255).nullable().optional(),
  showPreparedBy: z.boolean().default(true),
});

export type CoverPage = z.infer<typeof coverPageSchema>;

export const updateQuoteSchema = z.object({
  // Reassign the draft to another organization of the same partner. The service
  // clears the site, and clears the billToName override / re-resolves the tax
  // rate for the new org unless the same patch provides them (drafts only, like
  // every other header field here — see updateQuote in quoteService).
  orgId: z.string().guid().optional(),
  siteId: z.string().guid().nullable().optional(),
  title: z.string().max(200).nullable().optional(),
  expiryDate: isoDate.nullable().optional(),
  introNotes: z.string().max(5000).nullable().optional(),
  terms: z.string().max(20_000).nullable().optional(),
  termsAndConditions: z.string().max(20_000).nullable().optional(),
  taxRate: taxRate.nullable().optional(),
  billToName: z.string().max(255).nullable().optional(),
  depositType: quoteDepositTypeSchema.optional(),
  depositPercent: depositPercent.nullable().optional(),
  // Null clears a previously-set cover page back to "none stored"; omitted
  // leaves it untouched (same convention as every other nullable field here).
  coverPage: coverPageSchema.nullable().optional(),
}).refine(
  // A percent value is only meaningful for a 'percent' deposit. Reject a patch
  // that pairs a non-percent type with a percent in the same request, so the
  // contradiction is caught at the boundary instead of being silently nulled by
  // the service. (A bare { depositPercent } patch is still allowed — the service
  // derives the type from the stored quote.)
  (d) => !(d.depositType && d.depositType !== 'percent' && d.depositPercent != null),
  { message: 'depositPercent is only valid when depositType is "percent"', path: ['depositPercent'] },
);

// A reorder payload must be a clean permutation of the existing ids, so the id
// list has to be unique — without this, a duplicated id (e.g. [A, A] for blocks
// [A, B]) passes a length+membership check, renumbers A twice, never touches B,
// and corrupts sort_order. Uniqueness is enforced here so both routes are
// covered; the service re-checks as defense in depth.
const uniqueReorderIds = z
  .array(z.string().guid())
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'ids must be unique' });
export const reorderBlocksSchema = z.object({ blockIds: uniqueReorderIds });
export const reorderLinesSchema = z.object({ lineIds: uniqueReorderIds });
export type ReorderLinesInput = z.infer<typeof reorderLinesSchema>;
export type ReorderBlocksInput = z.infer<typeof reorderBlocksSchema>;

// Move a line to a different pricing-table (line_items) block on the same
// quote. The service appends it to the end of the target block's sort order;
// bundle children follow their parent.
export const moveQuoteLineSchema = z.object({ blockId: z.string().guid() });
export type MoveQuoteLineInput = z.infer<typeof moveQuoteLineSchema>;

export const acceptQuoteSchema = z.object({
  signerName: z.string().min(1).max(255),
  signerEmail: z.string().email().max(255).optional(),
});

export const declineQuoteSchema = z.object({
  reason: z.string().max(5000).optional(),
});

export const listQuotesQuerySchema = z.object({
  orgId: z.string().guid().optional(),
  status: quoteStatusSchema.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().guid().optional(),
});

export const bulkQuoteIdsSchema = z.object({
  // capped at BULK_ID_LIMIT: each item runs sequentially in its own short transaction (conn-pool safety)
  ids: z.array(z.string().guid()).min(1).max(BULK_ID_LIMIT),
});

export const createQuoteOrderSchema = z.object({
  clientRequestId: z.string().guid(),
  procurementSource: z.string().max(40).nullable().optional(),
  vendorName: z.string().max(255).nullable().optional(),
  orderRef: z.string().max(120).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  trackingNumber: z.string().max(120).nullable().optional(),
  eta: isoDate.optional(),
  lines: z.array(z.object({
    quoteLineId: z.string().guid(),
    orderedQty: positiveQty,
  })).min(1).max(200),
});

export const updateQuoteOrderSchema = z.object({
  vendorName: z.string().max(255).nullable().optional(),
  orderRef: z.string().max(120).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const updateQuoteOrderLineSchema = z.object({
  // CONTROLLER RULING (deviation from positiveQty): a receipt correction back to
  // zero is legitimate (e.g. an erroneous mark-received undone) and the DB CHECK
  // allows it — positiveQty would reject a valid { receivedQty: 0 } patch.
  receivedQty: nonnegativeQty.optional(),
  trackingNumber: z.string().max(120).nullable().optional(),
  eta: isoDate.nullable().optional(),
  cancelled: z.boolean().optional(),
});

export type QuoteLineInput = z.infer<typeof quoteLineInputSchema>;
export type QuoteBlockInput = z.infer<typeof quoteBlockInputSchema>;
export type QuoteTableColumn = z.infer<typeof tableColumn>;
export type QuoteTableContent = z.infer<typeof tableContent>;
export type QuoteCalloutContent = z.infer<typeof calloutContent>;
export type CreateQuoteInput = z.infer<typeof createQuoteSchema>;
export type CloneQuoteInput = z.infer<typeof cloneQuoteSchema>;
export type UpdateQuoteInput = z.infer<typeof updateQuoteSchema>;
export type ListQuotesQuery = z.infer<typeof listQuotesQuerySchema>;
export type AcceptQuoteInput = z.infer<typeof acceptQuoteSchema>;
export type DeclineQuoteInput = z.infer<typeof declineQuoteSchema>;
export type CreateQuoteOrderInput = z.infer<typeof createQuoteOrderSchema>;
export type UpdateQuoteOrderInput = z.infer<typeof updateQuoteOrderSchema>;
export type UpdateQuoteOrderLineInput = z.infer<typeof updateQuoteOrderLineSchema>;
