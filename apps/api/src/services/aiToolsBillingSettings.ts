/**
 * `manage_billing_settings` (full-control W14, #6784): the AI twin of the
 * billing-settings routes (routes/invoices/settings.ts) through the same
 * services (invoiceService.updatePartnerBillingSettings /
 * updateOrgBillingSettings, orgCurrencyService.getOrgCurrencyImpact,
 * reportingTotals). The reads replace `GET /orgs/partners/me` and the org row
 * (fact 5) with explicit billing projections.
 *
 * Classes (W14 plan): `get_partner` / `get_org` / `currency_impact` /
 * `reporting_totals` t1; `update_partner` supervised (partner-wide invoice
 * defaults, customer-facing text and auto-email switches); `update_org`
 * supervised (escalated from t2: tax, payment terms and the billing contact
 * every quote and invoice is emailed to).
 *
 * Gates: partner or system scope (REST); MFA on writes; `update_partner` needs
 * `canManagePartnerWidePolicies`; org-wide config refuses device-bound sessions
 * (W14-D8). Re-made at release, because the handler runs then.
 *
 * Not built (W14-D4): the agreement-reminder keys (`agreements:send`, edited on
 * Billing → Agreements), the org currency cut-over and `billingProfileId`
 * (assignment is `manage_billing_profiles:set_org_profile`).
 */
import { eq } from 'drizzle-orm';
import { AGREEMENT_DEFAULTS_SETTINGS_KEYS, orgBillingSettingsSchema, partnerBillingSettingsSchema } from '@breeze/shared';
import { db } from '../db';
import { organizations, partners } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { mfaGatedToolError } from './aiToolMfaGate';
import { updateOrgBillingSettings, updatePartnerBillingSettings } from './invoiceService';
import { InvoiceServiceError, type InvoiceActor } from './invoiceTypes';
import { getOrgCurrencyImpact } from './orgCurrencyService';
import { OrgCurrencyServiceError } from './orgCurrencyCore';
import { computeReportingTotal, parseGroupsParam, resolvePartnerReportingCurrency } from './reportingTotals';
import { ExchangeRateServiceError } from './exchangeRateService';
import { BillingProfileServiceError } from './billingProfileService';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE, canManagePartnerWidePolicies } from './partnerWideAccess';
import { BILLING_SETTINGS_ACTIONS } from './aiToolSchemasBilling';
import { auditToolWrite, bounded, deviceBoundDenied, jsonError, notFound, thrown } from './aiToolsSoftwareShared';

type Action = (typeof BILLING_SETTINGS_ACTIONS)[number];
const TOOL = 'manage_billing_settings';

function actorFrom(auth: AuthContext): InvoiceActor {
  return { userId: auth.user.id, partnerId: auth.partnerId ?? null, accessibleOrgIds: auth.accessibleOrgIds, allowedSiteIds: auth.allowedSiteIds };
}

/** REST: requireScope('partner', 'system'); a partner context needs its partnerId. */
function scopeRefusal(auth: AuthContext): string | null {
  if (auth.scope === 'system' || (auth.scope === 'partner' && auth.partnerId)) return null;
  return jsonError('Billing settings need a partner-scoped session; organization-scoped callers cannot reach the matching HTTP routes either', 'PARTNER_SCOPE_REQUIRED');
}

const partnerProjection = () => ({
  currencyCode: partners.currencyCode, defaultTaxRate: partners.defaultTaxRate,
  invoiceNumberPrefix: partners.invoiceNumberPrefix, invoiceTermsDays: partners.invoiceTermsDays,
  defaultMarkupPercent: partners.defaultMarkupPercent, autoTaxHardware: partners.autoTaxHardware,
  invoiceDeviceAppendix: partners.invoiceDeviceAppendix, invoiceLineGrouping: partners.invoiceLineGrouping,
  invoiceLineShowDate: partners.invoiceLineShowDate, invoiceLineShowNote: partners.invoiceLineShowNote,
  invoiceLineShowWorkedTime: partners.invoiceLineShowWorkedTime,
  autoEmailInvoiceOnQuoteAccept: partners.autoEmailInvoiceOnQuoteAccept,
  notifyCustomerOnBehalfAcceptance: partners.notifyCustomerOnBehalfAcceptance,
  invoiceFooter: partners.invoiceFooter, documentTheme: partners.documentTheme, documentPageSize: partners.documentPageSize,
  billingCompanyName: partners.billingCompanyName, billingPhone: partners.billingPhone, billingWebsite: partners.billingWebsite,
  billingAddressLine1: partners.billingAddressLine1, billingAddressLine2: partners.billingAddressLine2,
  billingAddressCity: partners.billingAddressCity, billingAddressRegion: partners.billingAddressRegion,
  billingAddressPostalCode: partners.billingAddressPostalCode, billingAddressCountry: partners.billingAddressCountry,
  billingTermsAndConditions: partners.billingTermsAndConditions,
});

const orgProjection = () => ({
  id: organizations.id, name: organizations.name, currencyCode: organizations.currencyCode,
  taxId: organizations.taxId, taxExempt: organizations.taxExempt, taxRate: organizations.taxRate,
  invoiceTermsDays: organizations.invoiceTermsDays, billingContact: organizations.billingContact,
  billingAddressLine1: organizations.billingAddressLine1, billingAddressLine2: organizations.billingAddressLine2,
  billingAddressCity: organizations.billingAddressCity, billingAddressRegion: organizations.billingAddressRegion,
  billingAddressPostalCode: organizations.billingAddressPostalCode, billingAddressCountry: organizations.billingAddressCountry,
});

function serviceError(err: unknown): string | null {
  if (!(err instanceof InvoiceServiceError || err instanceof BillingProfileServiceError
    || err instanceof OrgCurrencyServiceError || err instanceof ExchangeRateServiceError)) return null;
  // A coded 5xx is still a server failure: log it, then answer with its code.
  if (err.status >= 500) console.error(`[${TOOL}]`, err.code, err.message);
  const details = (err as { details?: unknown }).details;
  // #3205 W03: structured recovery data rides along, as on the REST door.
  return JSON.stringify({ error: err.message, code: err.code, ...(details ? { details } : {}) });
}

function invalid(issues: { message: string; path: PropertyKey[] }[] | undefined): string {
  const first = issues?.[0];
  const where = first?.path.length ? `${first.path.map(String).join('.')}: ` : '';
  return jsonError(`${where}${first?.message ?? 'Invalid input'}`, 'VALIDATION_ERROR');
}

function patchObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The org when the caller may read or edit its billing settings, else null. */
function reachableOrgId(auth: AuthContext, orgId: unknown): string | null {
  return typeof orgId === 'string' && auth.canAccessOrg(orgId) ? orgId : null;
}

async function updatePartner(input: Record<string, unknown>, auth: AuthContext): Promise<string> {
  if (!auth.partnerId) return jsonError('Partner settings need a partner context', 'PARTNER_SCOPE_REQUIRED');
  if (!canManagePartnerWidePolicies(auth)) return jsonError(PARTNER_WIDE_WRITE_DENIED_MESSAGE, 'ACCESS_DENIED');
  const patch = patchObject(input.partnerPatch);
  if (!patch || Object.keys(patch).length === 0) return jsonError('partnerPatch with at least one field is required', 'VALIDATION_ERROR');
  // W14-D4: agreement-reminder defaults need agreements:send at REST and are edited on Billing → Agreements.
  if (AGREEMENT_DEFAULTS_SETTINGS_KEYS.some((key) => patch[key] !== undefined)) {
    return jsonError('Agreement reminder defaults are changed on Billing → Agreements in the web app', 'VALIDATION_ERROR');
  }
  const [current] = await db.select(partnerProjection()).from(partners).where(eq(partners.id, auth.partnerId)).limit(1);
  if (!current) return notFound('Partner');
  // The service always writes these three; carry the current values for any the patch omits.
  const required = {
    currencyCode: current.currencyCode, invoiceNumberPrefix: current.invoiceNumberPrefix, invoiceTermsDays: current.invoiceTermsDays,
  };
  const parsed = partnerBillingSettingsSchema.safeParse({ ...required, ...patch });
  if (!parsed.success) return invalid(parsed.error.issues);
  // Only what the validated patch carries counts as changed (never the three carried-forward keys it omits).
  const changedFields = Object.keys(patch).filter((key) => key in parsed.data);
  // Quorum QW3: the previous values ride in the result and the audit row, so an approved change can be put back.
  const before = pickFields(current as Record<string, unknown>, changedFields);
  const settings = await updatePartnerBillingSettings(parsed.data, actorFrom(auth));
  auditToolWrite(auth, {
    orgId: null, partnerId: auth.partnerId, action: 'partner.billing_settings.update', resourceType: 'partner',
    resourceId: auth.partnerId, details: { changedFields, before, tool_name: TOOL },
  });
  return bounded({ settings, before });
}

function pickFields(row: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in row) out[key] = row[key];
  return out;
}

/** Billing-contact keys: their previous values go back to the model, never into an audit row (personal data). */
const CONTACT_KEYS: ReadonlySet<string> = new Set(['billingContactEmail', 'billingContactName']);

async function updateOrg(input: Record<string, unknown>, auth: AuthContext): Promise<string> {
  const orgId = reachableOrgId(auth, input.orgId);
  if (!orgId) return notFound('Organization');
  const bound = deviceBoundDenied(auth, 'Organization billing settings');
  if (bound) return bound;
  const patch = patchObject(input.orgPatch);
  if (!patch || Object.keys(patch).length === 0) return jsonError('orgPatch with at least one field is required', 'VALIDATION_ERROR');
  const parsed = orgBillingSettingsSchema.safeParse(patch);
  if (!parsed.success) return invalid(parsed.error.issues);
  if (parsed.data.currencyCode !== undefined || parsed.data.billingProfileId !== undefined) {
    return jsonError('Currency changes and rate-card assignment are not made through this action', 'VALIDATION_ERROR');
  }
  const [current] = await db.select(orgProjection()).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!current) return notFound('Organization');
  const changedFields = Object.keys(parsed.data);
  const contact = (current.billingContact ?? {}) as { email?: string | null; name?: string | null };
  const before = {
    ...pickFields(current as Record<string, unknown>, changedFields),
    ...(changedFields.includes('billingContactEmail') ? { billingContactEmail: contact.email ?? null } : {}),
    ...(changedFields.includes('billingContactName') ? { billingContactName: contact.name ?? null } : {}),
  };
  const settings = await updateOrgBillingSettings(orgId, parsed.data, actorFrom(auth));
  auditToolWrite(auth, {
    orgId, action: 'organization.billing_settings.update', resourceType: 'organization', resourceId: orgId,
    details: {
      changedFields,
      before: Object.fromEntries(Object.entries(before).filter(([key]) => !CONTACT_KEYS.has(key))),
      tool_name: TOOL,
    },
  });
  return bounded({ settings, before });
}

export function registerBillingSettingsTools(aiTools: Map<string, AiTool>): void {
  aiTools.set(TOOL, {
    tier: 1,
    deviceArgs: [],
    domain: 'billing',
    searchHint: 'invoice defaults: currency, tax, payment terms, invoice prefix, footer, org billing contact and address',
    definition: {
      name: TOOL,
      description: 'Partner invoice defaults and one org\'s tax, payment terms, billing contact and address. Actions: get_partner, get_org, currency_impact (preview an org currency change), reporting_totals, update_partner, update_org (writes need approval).',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...BILLING_SETTINGS_ACTIONS], description: 'The action to perform' },
          orgId: { type: 'string', description: 'get_org / update_org / currency_impact: org UUID' },
          currencyCode: { type: 'string', description: 'currency_impact: the currency the org would change to' },
          groups: { type: 'string', description: 'reporting_totals: comma-separated CODE:amount pairs, e.g. EUR:100.00,GBP:50' },
          to: { type: 'string', description: 'reporting_totals: target currency (default: the partner currency)' },
          date: { type: 'string', description: 'reporting_totals: rate date YYYY-MM-DD' },
          partnerPatch: { type: 'object', description: 'update_partner: only the fields to change (currency, tax, invoice prefix and terms, footer, T&Cs, auto-email switches, seller contact)' },
          orgPatch: { type: 'object', description: 'update_org: only the fields to change (taxId, taxExempt, taxRate, invoiceTermsDays, billing contact and address)' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!BILLING_SETTINGS_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      const refusal = scopeRefusal(auth);
      if (refusal) return refusal;
      try {
        const mfa = mfaGatedToolError(TOOL, action, auth);
        if (mfa) return mfa;
        switch (action) {
          case 'get_partner': {
            if (!auth.partnerId) return jsonError('Partner settings need a partner context', 'PARTNER_SCOPE_REQUIRED');
            const [row] = await db.select(partnerProjection()).from(partners).where(eq(partners.id, auth.partnerId)).limit(1);
            return row ? bounded({ settings: row }) : notFound('Partner');
          }
          case 'get_org': {
            const orgId = reachableOrgId(auth, input.orgId);
            if (!orgId) return notFound('Organization');
            const bound = deviceBoundDenied(auth, 'Organization billing settings');
            if (bound) return bound;
            const [row] = await db.select(orgProjection()).from(organizations).where(eq(organizations.id, orgId)).limit(1);
            return row ? bounded({ settings: row }) : notFound('Organization');
          }
          case 'currency_impact': {
            const orgId = reachableOrgId(auth, input.orgId);
            if (!orgId) return notFound('Organization');
            const bound = deviceBoundDenied(auth, 'Organization billing settings');
            if (bound) return bound;
            if (typeof input.currencyCode !== 'string') return jsonError('currencyCode is required', 'VALIDATION_ERROR');
            return bounded({ impact: await getOrgCurrencyImpact(orgId, input.currencyCode, actorFrom(auth)) });
          }
          case 'reporting_totals': {
            if (typeof input.groups !== 'string' || typeof input.date !== 'string') {
              return jsonError('groups and date are required', 'VALIDATION_ERROR');
            }
            const groups = parseGroupsParam(input.groups);
            const target = typeof input.to === 'string'
              ? input.to
              : (auth.partnerId ? await resolvePartnerReportingCurrency(auth.partnerId) : null);
            if (!target) return jsonError('No reporting currency is configured for this partner', 'NO_REPORTING_CURRENCY');
            return bounded({ total: await computeReportingTotal(groups, target, input.date) });
          }
          case 'update_partner':
            return await updatePartner(input, auth);
          case 'update_org':
            return await updateOrg(input, auth);
          default:
            return jsonError(`Unknown action: ${String(action)}`);
        }
      } catch (error) {
        return serviceError(error) ?? thrown(TOOL, error);
      }
    },
  });
}
