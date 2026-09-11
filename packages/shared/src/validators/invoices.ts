import { z } from 'zod';
// Spread the readonly SSOT tuples into z.enum (keep it a direct spread of the
// const — a `string[]` intermediate would widen the schema to z.enum(string)).
import { INVOICE_STATUSES, PAYMENT_METHODS } from '../types/billing-enums';
import { BULK_ID_LIMIT } from '../constants';
import { nullableHttpUrlField } from './httpUrl';
import { currencyCodeSchema } from './currency';

const money = z.number().nonnegative().multipleOf(0.01);
const positiveQty = z.number().positive().multipleOf(0.01);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const taxRate = z.number().min(0).max(1); // fraction, e.g. 0.085

export const assembleFromOrgSchema = z.object({
  orgId: z.string().guid(),
  siteId: z.string().guid().optional(),
  from: isoDate,
  to: isoDate,
  // Multi-currency wave 4 (#3776): explicit header-currency override. Default is
  // the org's current currency; pass the org's OLD currency to assemble a draft
  // from billables snapshotted before a currency change (spec §7). Never a
  // conversion — rows in any other currency come back as `blockedByCurrency`.
  currencyCode: currencyCodeSchema.optional()
});

/** Query for POST /tickets/:ticketId/invoice — the endpoint is body-less, so the
 *  same override travels as `?currencyCode=` (an optional JSON validator would
 *  reject an empty body). */
export const assembleFromTicketQuerySchema = z.object({
  currencyCode: currencyCodeSchema.optional()
});

export const manualLineSchema = z.object({
  // Title (mirrors catalog name); `description` is the optional blurb beneath it.
  name: z.string().max(255).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  quantity: positiveQty,
  unitPrice: money,
  taxable: z.boolean(),
  costBasis: money.optional()
}).refine((d) => Boolean(d.name?.trim() || d.description?.trim()), {
  message: 'A line needs a name or a description', path: ['name'],
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
  name: z.string().max(255).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  quantity: positiveQty.optional(),
  unitPrice: money.optional(),
  taxable: z.boolean().optional(),
  customerVisible: z.boolean().optional()
});

export const createManualInvoiceSchema = z.object({
  orgId: z.string().guid(),
  siteId: z.string().guid().optional(),
  notes: z.string().max(5000).optional(),
  termsAndConditions: z.string().max(20_000).optional()
});

export const updateInvoiceSchema = z.object({
  notes: z.string().max(5000).optional(),
  siteId: z.string().guid().nullable().optional(),
  dueDate: isoDate.optional(),
  termsAndConditions: z.string().max(20_000).nullable().optional()
});

export const recordPaymentSchema = z.object({
  amount: z.number().positive().multipleOf(0.01),
  method: z.enum([...PAYMENT_METHODS]),
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
  status: z.enum([...INVOICE_STATUSES]).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().guid().optional()
});

export const partnerBillingSettingsSchema = z.object({
  currencyCode: currencyCodeSchema,
  defaultTaxRate: taxRate.nullable().optional(),
  invoiceNumberPrefix: z.string().min(1).max(12),
  invoiceTermsDays: z.number().int().min(0).max(365),
  // Default markup over distributor cost (percent) used to pre-fill the sell price
  // when importing catalog items. It feeds the catalog `markupPercent` field, so it
  // shares that field's bounds (numeric(6,2), 0..9999.99). The import view shows
  // the resulting gross margin alongside.
  defaultMarkupPercent: z.number().min(0).max(9999.99).multipleOf(0.01).nullable().optional(),
  // When true, hardware catalog items default to taxable when added/imported.
  autoTaxHardware: z.boolean().optional(),
  // #3205 W07: include the "Billed devices" appendix on invoice PDFs. Default
  // OFF (partners.invoice_device_appendix NOT NULL DEFAULT false). Resolved once
  // at issue onto invoices.device_appendix and frozen there.
  invoiceDeviceAppendix: z.boolean().optional(),
  // Auto-email the issued invoice (with its public pay link) when a quote is
  // accepted. Default ON — see partners.auto_email_invoice_on_quote_accept.
  autoEmailInvoiceOnQuoteAccept: z.boolean().optional(),
  // AI copy style for enrich/polish output; null reverts to the built-in house format.
  catalogAiStyle: z.string().max(2000).nullable().optional(),
  invoiceFooter: z.string().max(5000).nullable().optional(),
  // Document presentation (Spec A): curated theme preset + page size applied
  // to quote PDFs/HTML. Partner-owned — see documentTheme/documentPageSize on
  // the `partners` schema for the full justification.
  documentTheme: z.enum(['classic', 'condensed']).optional(),
  documentPageSize: z.enum(['letter', 'a4']).optional(),
  // Seller "From" contact profile (snapshotted onto each document at issue).
  billingCompanyName: z.string().max(255).nullable().optional(),
  billingPhone: z.string().max(40).nullable().optional(),
  // Snapshotted onto every issued invoice/quote and rendered in the branded
  // PDF, the portal document shell and the web document views, so it must be a
  // real web address rather than an arbitrary scheme (#3430).
  billingWebsite: nullableHttpUrlField('Billing website', 255),
  billingAddressLine1: z.string().max(255).nullable().optional(),
  billingAddressLine2: z.string().max(255).nullable().optional(),
  billingAddressCity: z.string().max(120).nullable().optional(),
  billingAddressRegion: z.string().max(120).nullable().optional(),
  billingAddressPostalCode: z.string().max(40).nullable().optional(),
  billingAddressCountry: z.string().length(2).nullable().optional(),
  billingTermsAndConditions: z.string().max(20_000).nullable().optional(),
});

export const orgBillingSettingsSchema = z.object({
  taxId: z.string().max(100).nullable().optional(),
  taxExempt: z.boolean().optional(),
  taxRate: taxRate.nullable().optional(),
  // Billing contact — the recipient quotes/invoices are actually emailed to
  // (org.billingContact jsonb). Kept here, alongside the address, so the whole
  // "who + where we bill" lives on one form. Clearing the field must send null,
  // not '': `.email()` rejects an empty string (a 400), while `.nullable()`
  // accepts null. Null flows through to resolveBillingEmail as "no recipient".
  billingContactEmail: z.string().email().max(255).nullable().optional(),
  billingContactName: z.string().max(255).nullable().optional(),
  billingAddressLine1: z.string().max(255).nullable().optional(),
  billingAddressLine2: z.string().max(255).nullable().optional(),
  billingAddressCity: z.string().max(120).nullable().optional(),
  billingAddressRegion: z.string().max(120).nullable().optional(),
  billingAddressPostalCode: z.string().max(40).nullable().optional(),
  billingAddressCountry: z.string().length(2).nullable().optional(),
  // Multi-currency wave 6 (#3778): the ONLY write path for organizations.currency_code.
  // Affects FUTURE documents/time entries/parts only — nothing historical is
  // restamped and no amount is ever converted (spec §5). The optimistic
  // precondition + explicit confirmation make an accidental change impossible.
  currencyCode: currencyCodeSchema.optional(),
  expectedCurrentCurrencyCode: currencyCodeSchema.optional(),
  confirmSnapshotRetention: z.boolean().optional(),
}).strict().superRefine((v, ctx) => {
  if (v.currencyCode === undefined) {
    if (v.expectedCurrentCurrencyCode !== undefined || v.confirmSnapshotRetention !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['currencyCode'], message: 'currency preconditions require currencyCode' });
    }
    return;
  }
  // Precondition stays mandatory at the schema (it costs nothing and makes a
  // blind write impossible). Confirmation does NOT: whether this request is a
  // real change is only knowable from the LOCKED row, so the validator merely
  // permits `confirmSnapshotRetention` and the service requires it after the
  // lock proves currencyCode !== locked.currencyCode. This resolves the
  // Task 10 / Task 11 contradiction the codex review flagged (minor 13):
  // a same-currency PATCH is an idempotent no-op that needs no confirmation.
  if (v.expectedCurrentCurrencyCode === undefined) {
    ctx.addIssue({ code: 'custom', path: ['expectedCurrentCurrencyCode'], message: 'expectedCurrentCurrencyCode is required when currencyCode is supplied' });
  }
});

export const orgCurrencyImpactQuerySchema = z.object({ currencyCode: currencyCodeSchema }).strict();

export const bulkInvoiceIdsSchema = z.object({
  // capped at BULK_ID_LIMIT: each item runs sequentially in its own short transaction (conn-pool safety)
  ids: z.array(z.string().guid()).min(1).max(BULK_ID_LIMIT),
});
export const bulkVoidInvoicesSchema = bulkInvoiceIdsSchema.extend({
  reason: z.string().trim().min(1).max(500),
});

export type AssembleFromOrgInput = z.infer<typeof assembleFromOrgSchema>;
export type ManualLineInput = z.infer<typeof manualLineSchema>;
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;
export type PartnerBillingSettingsInput = z.infer<typeof partnerBillingSettingsSchema>;
export type OrgBillingSettingsInput = z.infer<typeof orgBillingSettingsSchema>;
export type OrgCurrencyImpactQuery = z.infer<typeof orgCurrencyImpactQuerySchema>;
