import { z } from 'zod';
import { BULK_ID_LIMIT } from '../constants';
import { currencyCodeSchema } from './currency';

const money = z.string().regex(/^\d+(\.\d{1,2})?$/, 'must be a 2-decimal money string');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

export const contractLineInputSchema = z.object({
  lineType: z.enum(['flat', 'per_device', 'per_seat', 'manual']),
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
  sortOrder: z.number().int().min(0).optional()
}).refine(
  (l) => l.unitPrice !== undefined || l.catalogItemId !== undefined,
  { message: 'unitPrice is required unless catalogItemId is set', path: ['unitPrice'] }
).refine(
  (l) => l.taxable !== undefined || l.catalogItemId !== undefined,
  { message: 'taxable is required unless catalogItemId is set', path: ['taxable'] }
).refine(
  (l) => l.lineType !== 'manual' || l.manualQuantity !== undefined,
  { message: 'manualQuantity is required for manual lines', path: ['manualQuantity'] }
).refine(
  (l) => l.lineType === 'per_device' || l.siteId === undefined,
  { message: 'siteId is only valid on per_device lines', path: ['siteId'] }
);

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
