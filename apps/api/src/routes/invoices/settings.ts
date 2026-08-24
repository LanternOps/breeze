import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { authMiddleware, requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { partnerBillingSettingsSchema, orgBillingSettingsSchema, orgCurrencyImpactQuerySchema, reportingTotalsQuerySchema } from '@breeze/shared';
import { updatePartnerBillingSettings, updateOrgBillingSettings } from '../../services/invoiceService';
import { getOrgCurrencyImpact } from '../../services/orgCurrencyService';
import { computeReportingTotal, parseGroupsParam, resolvePartnerReportingCurrency } from '../../services/reportingTotals';
import { ExchangeRateServiceError } from '../../services/exchangeRateService';
import { invoiceActorFrom, handleServiceError } from './invoices';

// Mounted at the api root (not under the /invoices hub) so the paths read
// /api/v1/partner/billing-settings and /api/v1/orgs/:orgId/billing-settings.
// Auth is applied PER-ROUTE (not via `use('*')`): mounted at '/', a wildcard
// middleware would leak onto sibling/public routes registered later and 401 them
// (the #1383 regression). authMiddleware leads each route's middleware chain.
export const invoiceSettingsRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const writePerm = requirePermission(PERMISSIONS.INVOICES_WRITE.resource, PERMISSIONS.INVOICES_WRITE.action);

invoiceSettingsRoutes.patch('/partner/billing-settings', authMiddleware, scopes, writePerm,
  zValidator('json', partnerBillingSettingsSchema),
  async (c) => {
    try { return c.json({ data: await updatePartnerBillingSettings(c.req.valid('json'), invoiceActorFrom(c)) }); }
    catch (err) { return handleServiceError(c, err); }
  });

invoiceSettingsRoutes.patch('/orgs/:orgId/billing-settings', authMiddleware, scopes, writePerm,
  zValidator('param', z.object({ orgId: z.string().guid() })),
  zValidator('json', orgBillingSettingsSchema),
  async (c) => {
    try { return c.json({ data: await updateOrgBillingSettings(c.req.valid('param').orgId, c.req.valid('json'), invoiceActorFrom(c)) }); }
    catch (err) { return handleServiceError(c, err); }
  });

// Multi-currency wave 6 (#3778): ADVISORY, read-only preview of what a currency
// change would strand. Counts are never blockers and never a promise — rows can
// be created between this preview and the change (the org SHARE barrier, not
// this count, is what makes the cutover exact). Same per-route middleware chain
// as the PATCH above (never `use('*')` — the #1383 regression).
invoiceSettingsRoutes.get('/orgs/:orgId/billing-settings/currency-impact', authMiddleware, scopes, writePerm,
  zValidator('param', z.object({ orgId: z.string().guid() })),
  zValidator('query', orgCurrencyImpactQuerySchema),
  async (c) => {
    try {
      return c.json({ data: await getOrgCurrencyImpact(
        c.req.valid('param').orgId, c.req.valid('query').currencyCode, invoiceActorFrom(c)) });
    } catch (err) { return handleServiceError(c, err); }
  });

// Multi-currency wave 7 (#3779): reporting-only FX totals for the optional
// "≈ approximate" line beneath per-currency dashboard totals. READ-ONLY and
// deliberately permission-free — rates are public reference facts (the table's
// RLS policy is `FOR SELECT USING (true)`), and a timesheet viewer must not
// need invoice permissions to see an approximate total. Conversion happens
// HERE, never in the browser, so there is exactly one implementation of
// reporting money math (spec §8). `to` defaults to the actor's PARTNER
// currency, resolved server-side, so organization-scoped viewers work without
// /orgs/partners/me (which is partner-scope only). An unavailable result is
// DATA, never an HTTP failure: the client then renders segmented totals only.
// Per-route middleware, never `use('*')` (#1383).
const readScopes = requireScope('organization', 'partner', 'system');

/** ExchangeRateServiceError carries its own `.status` + `.code`, which the
 *  invoice-flavoured handleServiceError does not know about — mapping it here
 *  keeps that shared helper free of FX concerns. */
function handleReportingError(c: Parameters<typeof handleServiceError>[0], err: unknown): Response {
  if (err instanceof ExchangeRateServiceError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status);
  }
  return handleServiceError(c, err);
}

invoiceSettingsRoutes.get('/billing/reporting-totals', authMiddleware, readScopes,
  zValidator('query', reportingTotalsQuerySchema),
  async (c) => {
    const { groups, to, date } = c.req.valid('query');
    const auth = c.get('auth');
    try {
      const parsed = parseGroupsParam(groups);
      const target = to ?? (auth.partnerId ? await resolvePartnerReportingCurrency(auth.partnerId) : null);
      if (!target) {
        return c.json({ error: { code: 'NO_REPORTING_CURRENCY', message: 'No reporting currency is configured for this partner' } }, 409);
      }
      return c.json({ data: await computeReportingTotal(parsed, target, date) });
    } catch (err) { return handleReportingError(c, err); }
  });
