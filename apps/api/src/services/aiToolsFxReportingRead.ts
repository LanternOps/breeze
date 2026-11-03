/**
 * `manage_billing_settings:reporting_totals` (full-control W14, #6784): the AI
 * twin of the read-only GET /billing/reporting-totals endpoint
 * (routes/invoices/settings.ts). It calls the reporting-only FX service exactly
 * as that route does and writes nothing — an approximate figure for display,
 * never persisted onto any document (exchangeRateBoundary.test.ts allowlists
 * this file for that reason).
 *
 * Kept out of aiToolsBillingSettings.ts on purpose, so the module that writes
 * billing settings never references an FX module or symbol.
 */
import type { AuthContext } from '../middleware/auth';
import { ExchangeRateServiceError } from './exchangeRateService';
import { computeReportingTotal, parseGroupsParam, resolvePartnerReportingCurrency } from './reportingTotals';
import { bounded, jsonError } from './aiToolsSoftwareShared';

export async function fxReportingTotalRead(input: Record<string, unknown>, auth: AuthContext): Promise<string> {
  if (typeof input.groups !== 'string' || typeof input.date !== 'string') {
    return jsonError('groups and date are required', 'VALIDATION_ERROR');
  }
  try {
    const groups = parseGroupsParam(input.groups);
    const target = typeof input.to === 'string'
      ? input.to
      : (auth.partnerId ? await resolvePartnerReportingCurrency(auth.partnerId) : null);
    if (!target) return jsonError('No reporting currency is configured for this partner', 'NO_REPORTING_CURRENCY');
    return bounded({ total: await computeReportingTotal(groups, target, input.date) });
  } catch (err) {
    if (err instanceof ExchangeRateServiceError) {
      if (err.status >= 500) console.error('[manage_billing_settings]', err.code, err.message);
      return jsonError(err.message, err.code);
    }
    throw err;
  }
}
