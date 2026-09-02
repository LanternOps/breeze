/**
 * Platform-admin manual exchange-rate API (multi-currency spec §8, wave 7 #3779).
 *
 *   GET    /api/v1/admin/exchange-rates
 *   PUT    /api/v1/admin/exchange-rates/:rateDate/:baseCode/:quoteCode   (+ MFA)
 *   DELETE /api/v1/admin/exchange-rates/:rateDate/:baseCode/:quoteCode   (+ MFA)
 *
 * WHY PLATFORM-ADMIN ONLY: `exchange_rates` is a GLOBAL table with no tenant
 * axis and a permissive `USING (true)` SELECT policy, so a partner-scoped write
 * would be a cross-tenant mutation by construction — partner A's override would
 * move partner B's dashboard. Same posture as `third_party_package_catalog`.
 * This API is the self-host / air-gapped management path; there is no admin UI
 * in this wave.
 *
 * PROVENANCE IS NOT A CALLER INPUT: the PUT handler builds its `setManualRate`
 * argument from the validated param + `rate` exclusively and never spreads the
 * raw body, so `source` cannot be smuggled in. `manualExchangeRateBodySchema`
 * is `.strict()`, so it is a 400 before the handler is even reached — an
 * operator who thinks they are pinning an ECB rate is told they cannot rather
 * than having the field silently dropped.
 *
 * FX is reporting-only: nothing here is ever persisted onto a billing document.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  exchangeRateKeyParamSchema,
  exchangeRateListQuerySchema,
  manualExchangeRateBodySchema,
} from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { requireMfa } from '../../middleware/auth';
import {
  ExchangeRateServiceError,
  deleteManualRate,
  listExchangeRates,
  setManualRate,
} from '../../services/exchangeRateService';

export const exchangeRateAdminRoutes = new Hono();

type IssueLike = { path?: ReadonlyArray<PropertyKey>; message?: string };

/** Validation failures carry the SAME `{ error: { code, message } }` shape as
 *  mapped ExchangeRateServiceErrors, so a caller has one error contract for the
 *  whole route rather than two. The code is derived from the failing field. */
function codedValidationHook(fallback: string) {
  return (result: { success: boolean; error?: { issues?: ReadonlyArray<IssueLike> } }, c: Context) => {
    if (result.success) return;
    const issues = result.error?.issues ?? [];
    const paths = issues.flatMap((i) => (i.path ?? []).map((p) => String(p)));
    const code = paths.includes('rateDate')
      ? 'INVALID_DATE'
      : paths.includes('baseCode') || paths.includes('quoteCode')
        ? 'INVALID_CURRENCY'
        : paths.includes('rate')
          ? 'INVALID_RATE'
          : fallback;
    const message = issues.map((i) => {
      const p = (i.path ?? []).map((s) => String(s)).join('.');
      return p ? `${p}: ${i.message}` : i.message;
    }).join('; ') || 'Invalid request';
    return c.json({ error: { code, message } }, 400);
  };
}

function mapServiceError(err: unknown, c: Context) {
  if (err instanceof ExchangeRateServiceError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
  }
  throw err;
}

exchangeRateAdminRoutes.get(
  '/',
  zValidator('query', exchangeRateListQuerySchema, codedValidationHook('INVALID_QUERY')),
  async (c) => {
    const q = c.req.valid('query');
    try {
      return c.json({ data: await listExchangeRates(q) });
    } catch (err) {
      return mapServiceError(err, c);
    }
  },
);

exchangeRateAdminRoutes.put(
  '/:rateDate/:baseCode/:quoteCode',
  requireMfa(),
  zValidator('param', exchangeRateKeyParamSchema, codedValidationHook('INVALID_DATE')),
  zValidator('json', manualExchangeRateBodySchema, codedValidationHook('INVALID_RATE')),
  async (c) => {
    const { rateDate, baseCode, quoteCode } = c.req.valid('param');
    const { rate } = c.req.valid('json');
    try {
      // Explicit field list — never a spread of the raw body.
      return c.json({ data: await setManualRate({ rateDate, baseCode, quoteCode, rate }) });
    } catch (err) {
      return mapServiceError(err, c);
    }
  },
);

exchangeRateAdminRoutes.delete(
  '/:rateDate/:baseCode/:quoteCode',
  requireMfa(),
  zValidator('param', exchangeRateKeyParamSchema, codedValidationHook('INVALID_DATE')),
  async (c) => {
    const { rateDate, baseCode, quoteCode } = c.req.valid('param');
    try {
      const removed = await deleteManualRate({ rateDate, baseCode, quoteCode });
      if (!removed) {
        // Deleting only ever removes a MANUAL cell; an ECB row or an absent
        // cell is "nothing to revoke here".
        return c.json(
          { error: { code: 'NOT_FOUND', message: 'No manual rate for that date and pair' } },
          404,
        );
      }
      return c.body(null, 204);
    } catch (err) {
      return mapServiceError(err, c);
    }
  },
);
