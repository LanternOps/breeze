import { z } from 'zod';

const money = z.number().nonnegative().multipleOf(0.01);
const positiveQty = z.number().positive().multipleOf(0.01);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const taxRate = z.number().min(0).max(1); // fraction, e.g. 0.085

export const assembleFromOrgSchema = z.object({
  orgId: z.string().guid(),
  siteId: z.string().guid().optional(),
  from: isoDate,
  to: isoDate
});

export const manualLineSchema = z.object({
  description: z.string().min(1).max(2000),
  quantity: positiveQty,
  unitPrice: money,
  taxable: z.boolean(),
  costBasis: money.optional()
});

export const catalogLineSchema = z.object({
  catalogItemId: z.string().guid(),
  quantity: positiveQty
});

export const bundleLineSchema = z.object({
  bundleId: z.string().guid(),
  quantity: positiveQty
});

export const updateLineSchema = z.object({
  description: z.string().min(1).max(2000).optional(),
  quantity: positiveQty.optional(),
  unitPrice: money.optional(),
  taxable: z.boolean().optional(),
  customerVisible: z.boolean().optional()
});

export const createManualInvoiceSchema = z.object({
  orgId: z.string().guid(),
  siteId: z.string().guid().optional(),
  notes: z.string().max(5000).optional()
});

export const updateInvoiceSchema = z.object({
  notes: z.string().max(5000).optional(),
  siteId: z.string().guid().nullable().optional(),
  dueDate: isoDate.optional()
});

export const recordPaymentSchema = z.object({
  amount: z.number().positive().multipleOf(0.01),
  method: z.enum(['cash', 'check', 'bank_transfer', 'card', 'other']),
  reference: z.string().max(255).optional(),
  receivedAt: isoDate,
  note: z.string().max(2000).optional()
});

export const voidInvoiceSchema = z.object({
  reason: z.string().min(1).max(2000),
  reissue: z.boolean().optional()
});

export const listInvoicesQuerySchema = z.object({
  orgId: z.string().guid().optional(),
  status: z.enum(['draft', 'sent', 'partially_paid', 'overdue', 'paid', 'void']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().guid().optional()
});

export const partnerBillingSettingsSchema = z.object({
  currencyCode: z.string().length(3),
  defaultTaxRate: taxRate.nullable().optional(),
  invoiceNumberPrefix: z.string().min(1).max(12),
  invoiceTermsDays: z.number().int().min(0).max(365),
  invoiceFooter: z.string().max(5000).nullable().optional()
});

export const orgBillingSettingsSchema = z.object({
  taxId: z.string().max(100).nullable().optional(),
  taxExempt: z.boolean().optional(),
  taxRate: taxRate.nullable().optional(),
  billingAddressLine1: z.string().max(255).nullable().optional(),
  billingAddressLine2: z.string().max(255).nullable().optional(),
  billingAddressCity: z.string().max(120).nullable().optional(),
  billingAddressRegion: z.string().max(120).nullable().optional(),
  billingAddressPostalCode: z.string().max(40).nullable().optional(),
  billingAddressCountry: z.string().length(2).nullable().optional()
});

export type AssembleFromOrgInput = z.infer<typeof assembleFromOrgSchema>;
export type ManualLineInput = z.infer<typeof manualLineSchema>;
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;
export type PartnerBillingSettingsInput = z.infer<typeof partnerBillingSettingsSchema>;
export type OrgBillingSettingsInput = z.infer<typeof orgBillingSettingsSchema>;
