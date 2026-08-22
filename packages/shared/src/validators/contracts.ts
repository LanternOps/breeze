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

export const bulkContractIdsSchema = z.object({
  // capped at BULK_ID_LIMIT: each item runs sequentially in its own short transaction (conn-pool safety)
  ids: z.array(z.string().guid()).min(1).max(BULK_ID_LIMIT),
});

export type ContractLineInput = z.infer<typeof contractLineInputSchema>;
export type CreateContractInput = z.infer<typeof createContractSchema>;
export type UpdateContractInput = z.infer<typeof updateContractSchema>;
