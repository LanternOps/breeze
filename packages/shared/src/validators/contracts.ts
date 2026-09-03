import { z } from 'zod';
import { BULK_ID_LIMIT } from '../constants';
import { currencyCodeSchema } from './currency';
import { BILLABLE_DEVICE_ROLES } from './deviceRoles';

// numeric(12,2): ten digits before the point, two after. Unbounded before
// (#3205 W03); an oversize value reached Postgres as a raw 22003 -> 500.
// String-length, not Number(), so no float rounding decides a boundary.
// Sibling validators already bound money (quotes.ts:8, catalog.ts:15).
const money = z.string()
  .regex(/^\d+(\.\d{1,2})?$/, 'must be a 2-decimal money string')
  .refine((v) => v.split('.')[0]!.length <= 10, 'must be at most 10 digits before the decimal point');

const INT32_MAX = 2_147_483_647;  // sort_order is int4
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

export const CONTRACT_LINE_TYPES = ['flat', 'per_device', 'per_device_role', 'per_device_group', 'per_seat', 'manual'] as const;
export type ContractLineType = typeof CONTRACT_LINE_TYPES[number];

// #3205 W04 (#4607): what happens to the units above included_quantity.
// 'bill' adds a second invoice line at overage_unit_price; 'flag' invoices
// nothing and reports the excess for a human. The DB twin is the
// contract_overage_mode enum.
export const OVERAGE_MODES = ['bill', 'flag'] as const;
export type OverageMode = typeof OVERAGE_MODES[number];

/** Line types that accept an allowance (#4607). The DB twin is the type list in
 *  contract_lines_allowance_chk. #4547's hour_block joins this set. */
export const ALLOWANCE_LINE_TYPES = ['per_device', 'per_device_role', 'per_device_group', 'per_seat'] as const;
const ALLOWANCE_LINE_TYPE_SET: ReadonlySet<string> = new Set(ALLOWANCE_LINE_TYPES);

/** Read layers use null for not-applicable, write layers omit the key (see the
 *  note on deviceRoles below). One predicate set has to serve both. */
const present = (v: unknown): boolean => v !== undefined && v !== null;

const SITE_SCOPABLE_LINE_TYPES = new Set<ContractLineType>(['per_device', 'per_device_role']);

export interface ContractLineShape {
  lineType: ContractLineType;
  manualQuantity?: string | null;
  siteId?: string | null;
  deviceRoles?: readonly string[] | null;
  deviceGroupId?: string | null;
  deviceGroupName?: string | null;
  // #3205 W04: all three are NULL together on a line with no allowance, and
  // always NULL on flat/manual.
  includedQuantity?: string | null;
  overageMode?: OverageMode | null;
  overageUnitPrice?: string | null;
}

export interface ContractLineInvariantIssue {
  path: keyof ContractLineShape;
  message: string;
}

/**
 * #3205 W03. The contract-line invariants, once, in two modes.
 *
 * 'create'    — a NEW line, from contractLineInputSchema. Reproduces the
 *               pre-W03 add-schema behaviour byte for byte.
 * 'persisted' — a line that already exists, or a merged (current ⊕ patch) row.
 *               Differs only where the persisted world legitimately allows
 *               something a new line may not (a group line orphaned by the FK),
 *               or requires something only a stored row has (the stamped
 *               device_group_name).
 *
 * NOT a transcription of the DB CHECKs. Three rules here have NO database
 * counterpart (duplicate roles — `<@` is containment, not set equality;
 * manualQuantity — there is no CHECK on the column at all; siteId on
 * flat/manual/per_seat — W02's CHECK covers per_device_group only), and two DB
 * rules are not expressible here (role-set membership, 1-D array shape). Both
 * sides are load-bearing; see the asymmetry matrix in the spec.
 */
export function contractLineInvariantIssues(
  l: ContractLineShape, opts: { mode: 'create' | 'persisted' },
): ContractLineInvariantIssue[] {
  const issues: ContractLineInvariantIssue[] = [];
  const isManual = l.lineType === 'manual';
  const isRoleLine = l.lineType === 'per_device_role';
  const isGroupLine = l.lineType === 'per_device_group';

  if (isManual && !present(l.manualQuantity)) {
    issues.push({ path: 'manualQuantity', message: 'manualQuantity is required for manual lines' });
  } else if (!isManual && opts.mode === 'persisted' && present(l.manualQuantity)) {
    // create TOLERATES this: the add writer nulls the column on every other
    // type (contractService.ts:904), so rejecting it would change add behaviour.
    issues.push({ path: 'manualQuantity', message: 'manualQuantity is only valid on manual lines' });
  }

  if (present(l.siteId) && !SITE_SCOPABLE_LINE_TYPES.has(l.lineType)) {
    issues.push({ path: 'siteId', message: 'siteId is only valid on per_device and per_device_role lines' });
  }

  if (isRoleLine !== present(l.deviceRoles)) {
    issues.push({ path: 'deviceRoles', message: 'deviceRoles is required on per_device_role lines and not allowed on other line types' });
  } else if (present(l.deviceRoles)) {
    const roles = l.deviceRoles!;
    // The create schema's z.array(...).min(1) owns this issue. Repeating it
    // here would change the pre-W03 issue array; persisted rows need the helper
    // to enforce non-empty roles because they do not pass through that schema.
    if (opts.mode === 'persisted' && roles.length === 0) {
      issues.push({ path: 'deviceRoles', message: 'deviceRoles must not be empty' });
    } else if (new Set(roles).size !== roles.length) {
      issues.push({ path: 'deviceRoles', message: 'deviceRoles must not contain duplicates' });
    }
  }

  if (opts.mode === 'create') {
    // W02's two-way refine: a NEW group line must name its group.
    if (isGroupLine !== present(l.deviceGroupId)) {
      issues.push({ path: 'deviceGroupId', message: 'deviceGroupId is required on per_device_group lines and not allowed on other line types' });
    }
  } else {
    // A stored group line may carry a NULL device_group_id: the composite FK is
    // ON DELETE SET NULL (device_group_id), so deleting the group orphans the
    // line rather than blocking. That state is legal and repairable in place.
    if (!isGroupLine && present(l.deviceGroupId)) {
      issues.push({ path: 'deviceGroupId', message: 'deviceGroupId is not allowed on this line type' });
    }
    if (isGroupLine !== present(l.deviceGroupName)) {
      issues.push({ path: 'deviceGroupName', message: 'deviceGroupName is required on per_device_group lines and not allowed on other line types' });
    }
  }

  // ---- #3205 W04 (#4607): included quantity + overage ----------------------
  // IDENTICAL IN BOTH MODES, deliberately: an allowance is equally legal on a
  // new line and on a merged patch row, so a patch can never create a row that
  // add_line would have rejected. Every rule below has a NULL-safe twin in
  // contract_lines_allowance_chk.
  const hasAllowanceColumn =
    present(l.includedQuantity) || present(l.overageMode) || present(l.overageUnitPrice);
  if (hasAllowanceColumn && !ALLOWANCE_LINE_TYPE_SET.has(l.lineType)) {
    issues.push({ path: 'includedQuantity', message: 'an allowance is only valid on per_device, per_device_role, per_device_group and per_seat lines' });
  }
  // Two-way, like deviceRoles: an allowance with no disposition for the extras
  // is the silent under-bill this wave removes.
  if (present(l.includedQuantity) !== present(l.overageMode)) {
    issues.push({ path: 'overageMode', message: "includedQuantity and overageMode must be set together — choose overageMode 'flag' to cap without billing; clear all three to remove an allowance" });
  }
  // 0 included with 'bill' is arithmetically a plain per-unit line at the
  // overage rate; one spelling only.
  if (present(l.includedQuantity) && !(Number(l.includedQuantity) > 0)) {
    issues.push({ path: 'includedQuantity', message: 'includedQuantity must be greater than 0' });
  }
  // You cannot include 25.5 devices or 25.5 seats. (#4547 scopes this rule when
  // hour_block joins ALLOWANCE_LINE_TYPES — hours are fractional.)
  if (present(l.includedQuantity) && !Number.isInteger(Number(l.includedQuantity))) {
    issues.push({ path: 'includedQuantity', message: 'includedQuantity must be a whole number of devices or seats' });
  }
  // A price is present iff it is actually charged. A rate parked on a 'flag'
  // line reads as a charge on the detail page and in the tenant export.
  if (present(l.overageUnitPrice) !== (l.overageMode === 'bill')) {
    issues.push({ path: 'overageUnitPrice', message: "overageUnitPrice is required for overageMode 'bill' and not allowed for 'flag'" });
  }

  return issues;
}

export const contractLineInputSchema = z.object({
  lineType: z.enum(CONTRACT_LINE_TYPES),
  description: z.string().min(1).max(2000),
  // Multi-currency wave 3 (#3775): a catalog-sourced line is priced by the
  // server-side resolver in the CONTRACT's currency, so unitPrice is optional
  // when catalogItemId is set (and any client value is ignored there — the
  // resolver is authoritative, as is taxable). Non-catalog lines require it.
  unitPrice: money.optional(),
  taxable: z.boolean().optional(),
  catalogItemId: z.string().guid().optional(),
  manualQuantity: money.optional(),
  siteId: z.string().guid().optional(),
  // #3205: the SET of roles a per_device_role line bills. 'unknown' is not a
  // rate; the DB CHECK (contract_lines_device_roles_chk) enforces the same list.
  // Write side: omit the key when not a role line; `null` is rejected here (Zod `.optional()`), while every read layer (DB row, API JSON, web) uses `null` for not-applicable.
  deviceRoles: z.array(z.enum(BILLABLE_DEVICE_ROLES)).min(1).optional(),
  // #3205 W04: the allowance. money's ^\d+(\.\d{1,2})?$ already excludes
  // negatives; the > 0 / integral / pairing rules are in the invariant table.
  includedQuantity: money.optional(),
  overageMode: z.enum(OVERAGE_MODES).optional(),
  overageUnitPrice: money.optional(),
  // #3205 W02: the device group a per_device_group line bills. Dynamic groups
  // are evaluated live at estimate/invoice time. No siteId on this type — the
  // group's own site narrows it (contract_lines_device_group_chk).
  deviceGroupId: z.string().guid().optional(),
  sortOrder: z.number().int().min(0).max(INT32_MAX).optional()
}).refine(
  (l) => l.unitPrice !== undefined || l.catalogItemId !== undefined,
  { message: 'unitPrice is required unless catalogItemId is set', path: ['unitPrice'] }
).refine(
  (l) => l.taxable !== undefined || l.catalogItemId !== undefined,
  { message: 'taxable is required unless catalogItemId is set', path: ['taxable'] }
).superRefine((l, ctx) => {
  // #3205 W03: the shape invariants live in contractLineInvariantIssues so the
  // update path can run the SAME rules over a merged row. Pricing refinements
  // remain before these shape checks to preserve the pre-W03 issue ordering.
  for (const issue of contractLineInvariantIssues(l, { mode: 'create' })) {
    ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
  }
});

/**
 * PATCH /contracts/:id/lines/:lineId (#3205 W03). Hand-written rather than
 * contractLineInputSchema.partial(): partial() cannot express the tri-state
 * catalogItemId, and on this schema it is not even callable — Zod 4.4.3 throws
 * ".partial() cannot be used on object schemas containing refinements"
 * (verified), and contractLineInputSchema carries refinements.
 *
 * STRICT on purpose. lineType is not editable — changing it crosses
 * contract_lines_device_roles_chk, contract_lines_device_group_chk and the site
 * rule at once — and a non-strict schema would ACCEPT {lineType:'flat'} and
 * silently drop it. Strict also turns a misspelled key into a 400 rather than a
 * silent no-op patch. Message: Unrecognized key: "lineType".
 *
 * catalogItemId is TRI-STATE by key presence (Zod 4 preserves absence, verified
 * by execution); see the transition table in the spec. refreshCatalogPrice is
 * the ONLY way to reprice an unchanged link, so a price never moves as a side
 * effect of another edit.
 */
export const updateContractLineSchema = z.object({
  description: z.string().min(1).max(2000).optional(),
  unitPrice: money.optional(),
  taxable: z.boolean().optional(),
  catalogItemId: z.string().guid().nullable().optional(),
  refreshCatalogPrice: z.boolean().optional(),      // default false
  manualQuantity: money.optional(),
  // null clears the site narrowing on a per_device / per_device_role line.
  siteId: z.string().guid().nullable().optional(),
  deviceRoles: z.array(z.enum(BILLABLE_DEVICE_ROLES)).min(1).optional(),
  // No null: a group line is never deliberately orphaned (decision 7).
  deviceGroupId: z.string().guid().optional(),
  // #3205 W04: nullable because REMOVING an allowance is a legitimate edit and
  // leaves a valid row (unlike clearing deviceRoles/deviceGroupId). The two-way
  // rule runs on the MERGED row, so `{ includedQuantity: null }` alone is a 400
  // INVALID_LINE_PATCH naming the fix; the edit form's "remove allowance"
  // control sends all three nulls in one patch.
  includedQuantity: money.nullable().optional(),
  overageMode: z.enum(OVERAGE_MODES).nullable().optional(),
  overageUnitPrice: money.nullable().optional(),
  sortOrder: z.number().int().min(0).max(INT32_MAX).optional(),
}).strict().refine(
  (p) => Object.keys(p).length > 0,
  { message: 'patch must change at least one field' },
).refine(
  (p) => p.deviceRoles === undefined || new Set(p.deviceRoles).size === p.deviceRoles.length,
  { message: 'deviceRoles must not contain duplicates', path: ['deviceRoles'] },
);

export type UpdateContractLineInput = z.infer<typeof updateContractLineSchema>;

/** Key-presence test for a tri-state patch field. Explicit undefined is the
 *  same as omission; null alone means clear/unlink. */
export function patchHasKey(patch: UpdateContractLineInput, key: keyof UpdateContractLineInput): boolean {
  return key in patch && patch[key] !== undefined;
}

/** A contract_lines row in read-layer shape (null = not applicable). */
export interface PersistedContractLine extends ContractLineShape {
  description: string;
  unitPrice: string;
  taxable: boolean;
  catalogItemId: string | null;
  manualQuantity: string | null;
  siteId: string | null;
  deviceRoles: readonly string[] | null;
  deviceGroupId: string | null;
  deviceGroupName: string | null;
  sortOrder: number;
  includedQuantity: string | null;
  overageMode: OverageMode | null;
  overageUnitPrice: string | null;
}

export type MergedContractLine = PersistedContractLine;

/**
 * Current persisted line ⊕ patch (#3205 W03). PURE — the service resolves the
 * catalog price/taxable BEFORE calling this and passes the result in `resolved`,
 * so the whole rule set can also run in the web editor to disable Save before a
 * round-trip, with no second copy of the rules.
 *
 * Price precedence implements the transition table: a `resolved` wins outright
 * (rows 3/5 and a refresh); otherwise a merged row that stays LINKED keeps its
 * stamped price and ignores any client value (rows 2/4), and an UNLINKED merged
 * row takes the patch's value (rows 1/6/7).
 *
 * lineType and deviceGroupName are never merged: the type is not patchable, and
 * the group name is re-stamped by the service from the resolved group AFTER the
 * invariants run.
 */
export function mergeContractLinePatch(
  current: PersistedContractLine,
  patch: UpdateContractLineInput,
  resolved?: { unitPrice: string; taxable: boolean; catalogItemId: string | null },
): MergedContractLine {
  const catalogItemId = resolved
    ? resolved.catalogItemId
    : (patchHasKey(patch, 'catalogItemId') ? (patch.catalogItemId ?? null) : current.catalogItemId);
  const stillLinked = catalogItemId !== null;
  return {
    lineType: current.lineType,
    description: patch.description ?? current.description,
    unitPrice: resolved ? resolved.unitPrice : (stillLinked ? current.unitPrice : (patch.unitPrice ?? current.unitPrice)),
    taxable: resolved ? resolved.taxable : (stillLinked ? current.taxable : (patch.taxable ?? current.taxable)),
    catalogItemId,
    manualQuantity: patch.manualQuantity ?? current.manualQuantity,
    siteId: patchHasKey(patch, 'siteId') ? (patch.siteId ?? null) : current.siteId,
    deviceRoles: patch.deviceRoles ?? current.deviceRoles,
    deviceGroupId: patch.deviceGroupId ?? current.deviceGroupId,
    deviceGroupName: current.deviceGroupName,
    sortOrder: patch.sortOrder ?? current.sortOrder,
    // #3205 W04: tri-state like siteId — key present (even as null) is a change,
    // key absent leaves the current value. `patch.x ?? current.x` would be wrong:
    // it cannot tell "remove the allowance" from "leave it alone".
    includedQuantity: patchHasKey(patch, 'includedQuantity') ? (patch.includedQuantity ?? null) : current.includedQuantity,
    overageMode: patchHasKey(patch, 'overageMode') ? (patch.overageMode ?? null) : current.overageMode,
    overageUnitPrice: patchHasKey(patch, 'overageUnitPrice') ? (patch.overageUnitPrice ?? null) : current.overageUnitPrice,
  };
}

export const createContractSchema = z.object({
  orgId: z.string().guid(),
  name: z.string().min(1).max(255),
  billingTiming: z.enum(['advance', 'arrears']),
  intervalMonths: z.number().int().min(1).max(60),
  startDate: isoDate,
  // endDate/notes accept null (not just undefined): the web create form sends
  // `endDate || null` and `notes.trim() || null`, matching updateContractSchema.
  endDate: isoDate.nullable().optional(),
  autoIssue: z.boolean().optional(),
  currencyCode: currencyCodeSchema.optional(),
  notes: z.string().max(5000).nullable().optional(),
  terms: z.string().max(5000).nullable().optional(),
  autoRenew: z.boolean().optional(),
  renewalTermMonths: z.number().int().min(1).max(120).nullable().optional(),
  renewalNoticeDays: z.number().int().min(0).max(365).nullable().optional(),
}).refine(
  (c) => c.endDate == null || c.endDate > c.startDate,
  { message: 'endDate must be after startDate', path: ['endDate'] }
).refine(
  (c) => !c.autoRenew || (c.endDate != null && c.renewalTermMonths != null),
  { message: 'auto-renew requires both endDate and renewalTermMonths', path: ['autoRenew'] }
);

export const updateContractSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  billingTiming: z.enum(['advance', 'arrears']).optional(),
  intervalMonths: z.number().int().min(1).max(60).optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.nullable().optional(),
  autoIssue: z.boolean().optional(),
  notes: z.string().max(5000).nullable().optional(),
  terms: z.string().max(5000).nullable().optional(),
  autoRenew: z.boolean().optional(),
  renewalTermMonths: z.number().int().min(1).max(120).nullable().optional(),
  renewalNoticeDays: z.number().int().min(0).max(365).nullable().optional(),
});

export const listContractsQuerySchema = z.object({
  orgId: z.string().guid().optional(),
  status: z.enum(['draft', 'active', 'paused', 'cancelled', 'expired']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().guid().optional()
});

/**
 * Query for GET /contracts/currency-mismatches (multi-currency wave 6, #3778,
 * Task 15) — the read-only anomaly inventory of contracts whose stamped
 * currency no longer matches their organization's. `status` is a FILTER, not a
 * scope: the report covers EVERY status by default, because a cancelled
 * mis-stamped contract is still an anomaly worth seeing. Strict, so a mis-keyed
 * filter is a 400 rather than a silently unfiltered full report.
 */
export const contractCurrencyMismatchQuerySchema = z.object({
  orgId: z.string().guid().optional(),
  status: z.enum(['draft', 'active', 'paused', 'cancelled', 'expired']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().guid().optional(),
}).strict();

export type ContractCurrencyMismatchQuery = z.infer<typeof contractCurrencyMismatchQuerySchema>;

export const bulkContractIdsSchema = z.object({
  // capped at BULK_ID_LIMIT: each item runs sequentially in its own short transaction (conn-pool safety)
  ids: z.array(z.string().guid()).min(1).max(BULK_ID_LIMIT),
});

export type ContractLineInput = z.infer<typeof contractLineInputSchema>;
export type CreateContractInput = z.infer<typeof createContractSchema>;
export type UpdateContractInput = z.infer<typeof updateContractSchema>;

/**
 * Body for POST /contracts/:id/currency (multi-currency wave 6, #3778).
 *
 * Contract-specific superset of the shared `changeCurrencySchema`: a DRAFT
 * contract behaves exactly as it did in wave 2, but an ACTIVE contract may be
 * restamped through the owner-approved escape hatch for pre-wave-2 contracts
 * stamped in the wrong currency. `confirmActiveChange` is the explicit opt-in;
 * eligibility ("no unbilled monetary rows") is re-checked by the service under
 * the contract's row lock, never here. Strict, so a mis-keyed field is a 400.
 */
export const changeContractCurrencySchema = z.object({
  currencyCode: currencyCodeSchema,
  clearLines: z.boolean().default(false),
  reprice: z.boolean().default(false),
  confirmActiveChange: z.boolean().default(false),
}).strict().refine((v) => !(v.clearLines && v.reprice), {
  message: 'clearLines and reprice are mutually exclusive',
  path: ['reprice'],
});

export type ChangeContractCurrencyInput = z.infer<typeof changeContractCurrencySchema>;
