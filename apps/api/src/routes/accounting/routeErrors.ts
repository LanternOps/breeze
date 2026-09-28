/**
 * Error → response mapping shared by the accounting route files (index.ts and
 * connectionSetupRoutes.ts). ONE copy (Xero W02 ruling F7), so every throttle
 * answers the same 429 + Retry-After wherever it surfaces.
 */
import type { Context } from 'hono';
import { AccountingImportError } from '../../services/accounting/accountingCustomerImport';
import { AccountingMappingError } from '../../services/accounting/accountingMappingService';
import {
  isAccountingProviderError, providerPermissionMessage, providerRateLimitedTryAgainMessage, rateLimitRetryAfterMs,
  rateLimitSourceOf, refusalCodeOf,
} from '../../services/accounting/accountingProviderError';
import { accountingProviderDisplayName } from '../../services/accounting/providerRegistry';

/** A throttle answers 429 with Retry-After in whole seconds, rounded up (Xero W01). */
export function setRetryAfter(c: Context, err: unknown): number | null {
  const retryAfterMs = rateLimitRetryAfterMs(err);
  if (retryAfterMs !== null) c.header('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  return retryAfterMs;
}

export function handleImportError(c: Context, err: unknown): Response {
  // AccountingImportError.status is a narrowed literal union (400|404|409|429|502), so no cast.
  if (err instanceof AccountingImportError) {
    // `rate_limited` carries retryAfterMs directly; `setRetryAfter` reads it via
    // `rateLimitRetryAfterMs`, which recognises any `code: 'rate_limited'` error
    // (not just AccountingProviderError) — daily_budget_low has no retryAfterMs
    // and correctly gets no header.
    setRetryAfter(c, err);
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  throw err;
}

export function handleMappingError(c: Context, err: unknown): Response {
  // AccountingMappingError.status is a narrowed literal union (404|409|429|502),
  // so no cast, and every current/future code (including item_price_required)
  // flows through generically — the route never re-enumerates codes.
  if (err instanceof AccountingMappingError) {
    setRetryAfter(c, err);
    return c.json({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) }, err.status);
  }
  // A raw scope refusal (remote-candidates calls the provider directly, so it
  // never passes through callProviderOrThrow): the user's to fix, not a 500.
  if (refusalCodeOf(err) === 'insufficient_scope' && isAccountingProviderError(err)) {
    return c.json({ error: providerPermissionMessage(accountingProviderDisplayName(err.provider)), code: 'provider_permission' }, 409);
  }
  // A raw provider throttle (remote-candidates calls the provider directly).
  if (isAccountingProviderError(err) && setRetryAfter(c, err) !== null) {
    const label = accountingProviderDisplayName(err.provider);
    return c.json({ error: providerRateLimitedTryAgainMessage(label, rateLimitSourceOf(err) ?? undefined), code: 'rate_limited' }, 429);
  }
  throw err;
}
