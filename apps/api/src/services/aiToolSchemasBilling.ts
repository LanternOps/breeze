/**
 * Input schemas for the W14 PR A tools (full-control W14, #6784):
 * `manage_billing_profiles`, `manage_billing_settings`,
 * `manage_contract_templates`, `manage_contract_documents`,
 * `get_device_billing`.
 *
 * Plain strict `z.object`s with an `action` enum (no top-level unions or
 * refinements) so `toolActionEnum` can read `.shape.action.options` and the
 * chat SDK `tool()` declarations can take `.shape` directly. Per-action
 * required fields and the route's own body schemas (`@breeze/shared`) are
 * applied in the handlers. No `z.undefined()` anywhere: it empties the model's
 * tool list.
 *
 * Deliberately ABSENT (W14 plan, W14-D4): work-type archive, profile `save`
 * and AI price-list edits, org currency change, `billingProfileId` on org
 * settings, the agreement-reminder keys, template PDF upload / download and
 * signed-agreement PDF download.
 */
import { z } from 'zod';

export const BILLING_PROFILE_ACTIONS = [
  'list', 'get', 'list_work_types', 'get_org_profile',
  'create', 'update', 'archive', 'set_rows', 'clone',
  'create_work_type', 'update_work_type',
  'set_org_profile', 'clear_org_profile',
] as const;
export const BILLING_SETTINGS_ACTIONS = [
  'get_partner', 'get_org', 'currency_impact', 'reporting_totals', 'update_partner', 'update_org',
] as const;
export const CONTRACT_TEMPLATE_ACTIONS = [
  'list', 'get', 'get_version', 'usage', 'create', 'update', 'create_version', 'publish', 'archive',
] as const;
export const CONTRACT_DOCUMENT_ACTIONS = ['list', 'link'] as const;

const uuid = z.string().uuid();
const coverage = z.enum(['billable', 'included', 'non_billable']);
const rate = z.string().max(16).nullable();
const currency = z.string().regex(/^[A-Z]{3}$/);
const nullableText = (max: number) => z.string().max(max).nullable();

const profileRow = z.object({
  workTypeId: uuid,
  coverage,
  hourlyRate: rate,
  minimumMinutes: z.number().int().min(0).nullable(),
  notes: nullableText(4000).optional(),
}).strict();

/** The editable partner billing settings (no agreement-reminder keys, W14-D4). */
const partnerSettingsPatch = z.object({
  currencyCode: currency.optional(),
  defaultTaxRate: z.number().min(0).max(100).nullable().optional(),
  invoiceNumberPrefix: z.string().min(1).max(12).optional(),
  invoiceTermsDays: z.number().int().min(0).max(365).optional(),
  defaultMarkupPercent: z.number().min(0).max(9999.99).nullable().optional(),
  autoTaxHardware: z.boolean().optional(),
  invoiceDeviceAppendix: z.boolean().optional(),
  invoiceLineGrouping: z.string().max(32).optional(),
  invoiceLineShowDate: z.boolean().optional(),
  invoiceLineShowNote: z.boolean().optional(),
  invoiceLineShowWorkedTime: z.boolean().optional(),
  autoEmailInvoiceOnQuoteAccept: z.boolean().optional(),
  notifyCustomerOnBehalfAcceptance: z.boolean().optional(),
  invoiceFooter: nullableText(5000).optional(),
  documentTheme: z.enum(['classic', 'condensed']).optional(),
  documentPageSize: z.enum(['letter', 'a4']).optional(),
  billingCompanyName: nullableText(255).optional(),
  billingPhone: nullableText(40).optional(),
  billingWebsite: nullableText(255).optional(),
  billingAddressLine1: nullableText(255).optional(),
  billingAddressLine2: nullableText(255).optional(),
  billingAddressCity: nullableText(120).optional(),
  billingAddressRegion: nullableText(120).optional(),
  billingAddressPostalCode: nullableText(40).optional(),
  billingAddressCountry: nullableText(2).optional(),
  billingTermsAndConditions: nullableText(20_000).optional(),
}).strict();

/** The editable org billing settings (no currency change, no billingProfileId, W14-D4). */
const orgSettingsPatch = z.object({
  taxId: nullableText(100).optional(),
  taxExempt: z.boolean().optional(),
  taxRate: z.number().min(0).max(100).nullable().optional(),
  invoiceTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  billingContactEmail: nullableText(255).optional(),
  billingContactName: nullableText(255).optional(),
  billingAddressLine1: nullableText(255).optional(),
  billingAddressLine2: nullableText(255).optional(),
  billingAddressCity: nullableText(120).optional(),
  billingAddressRegion: nullableText(120).optional(),
  billingAddressPostalCode: nullableText(40).optional(),
  billingAddressCountry: nullableText(2).optional(),
}).strict();

export const billingToolSchemas = {
  manage_billing_profiles: z.object({
    action: z.enum(BILLING_PROFILE_ACTIONS),
    profileId: uuid.optional(),
    workTypeId: uuid.optional(),
    orgId: uuid.optional(),
    includeInactive: z.boolean().optional(),
    name: z.string().min(1).max(120).optional(),
    notes: nullableText(4000).optional(),
    currencyCode: currency.optional(),
    baseCoverage: coverage.optional(),
    baseHourlyRate: rate.optional(),
    baseMinimumMinutes: z.number().int().min(0).nullable().optional(),
    roundingIncrementMinutes: z.number().int().min(1).max(480).nullable().optional(),
    isDefault: z.boolean().optional(),
    isActive: z.boolean().optional(),
    aiCoverage: coverage.optional(),
    aiMarkupPercent: z.string().max(8).nullable().optional(),
    rows: z.array(profileRow).max(1000).optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
    isAfterHours: z.boolean().optional(),
  }).strict(),

  manage_billing_settings: z.object({
    action: z.enum(BILLING_SETTINGS_ACTIONS),
    orgId: uuid.optional(),
    currencyCode: currency.optional(),
    groups: z.string().min(1).max(1024).optional(),
    to: currency.optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    partnerPatch: partnerSettingsPatch.optional(),
    orgPatch: orgSettingsPatch.optional(),
  }).strict(),

  manage_contract_templates: z.object({
    action: z.enum(CONTRACT_TEMPLATE_ACTIONS),
    templateId: uuid.optional(),
    versionId: uuid.optional(),
    orgId: uuid.optional(),
    ownerScope: z.enum(['organization', 'partner']).optional(),
    includeArchived: z.boolean().optional(),
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(2000).optional(),
    bodyHtml: z.string().min(1).max(200_000).optional(),
  }).strict(),

  manage_contract_documents: z.object({
    action: z.enum(CONTRACT_DOCUMENT_ACTIONS),
    documentId: uuid.optional(),
    contractId: uuid.optional(),
    orgId: uuid.optional(),
    linked: z.enum(['all', 'linked', 'unlinked']).optional(),
  }).strict(),

  get_device_billing: z.object({
    deviceId: uuid,
  }).strict(),
};
