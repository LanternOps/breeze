import { z } from 'zod';

const money = z.string().regex(/^\d+(\.\d{1,2})?$/, 'must be a 2-decimal money string');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

export const contractLineInputSchema = z.object({
  lineType: z.enum(['flat', 'per_device', 'per_seat', 'manual']),
  description: z.string().min(1).max(2000),
  unitPrice: money,
  taxable: z.boolean(),
  catalogItemId: z.string().guid().optional(),
  manualQuantity: money.optional(),
  siteId: z.string().guid().optional(),
  sortOrder: z.number().int().min(0).optional()
}).refine(
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
  currencyCode: z.string().length(3).optional(),
  notes: z.string().max(5000).nullable().optional(),
  terms: z.string().max(5000).nullable().optional()
}).refine(
  (c) => c.endDate == null || c.endDate > c.startDate,
  { message: 'endDate must be after startDate', path: ['endDate'] }
);

export const updateContractSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  billingTiming: z.enum(['advance', 'arrears']).optional(),
  intervalMonths: z.number().int().min(1).max(60).optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.nullable().optional(),
  autoIssue: z.boolean().optional(),
  notes: z.string().max(5000).nullable().optional(),
  terms: z.string().max(5000).nullable().optional()
});

export const listContractsQuerySchema = z.object({
  orgId: z.string().guid().optional(),
  status: z.enum(['draft', 'active', 'paused', 'cancelled', 'expired']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().guid().optional()
});

export type ContractLineInput = z.infer<typeof contractLineInputSchema>;
export type CreateContractInput = z.infer<typeof createContractSchema>;
export type UpdateContractInput = z.infer<typeof updateContractSchema>;
