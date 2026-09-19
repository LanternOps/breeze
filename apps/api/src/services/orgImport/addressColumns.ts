/**
 * Billing-address column mapping, split out of `./index.ts` so callers that
 * only need pure address formatting (no DB access, no tenant lifecycle) don't
 * pull in the rest of the org-import pipeline's import graph.
 *
 * `services/orgImport/index.ts` re-exports `billingAddressColumns` from here
 * for its own callers; `services/accounting/accountingMappingService.ts`
 * imports directly from this file instead of the `../orgImport` barrel —
 * the barrel transitively imports `services/tenantLifecycle.ts`, which
 * dynamically `import()`s `routes/agentWs.ts` (deliberately — see
 * tenantLifecycle.ts's header comment), and several `accountingMappingService`
 * callers (quoteSendWorker, stripeReconcileSweep, invoiceWorker,
 * contractWorker, accountingSyncWorker, accountingReconcileWorker) are
 * `global`-placement workers in `workerRegistry.ts`: their import closure
 * must never reach socket-local dispatch (see
 * `workerEntrypointClosure.contract.test.ts`).
 */

import type { ImportRowBillingAddress } from './types';

// Column-width clamp, same rationale as the QuickBooks importer: an over-long
// value throws and rolls back the whole insert, dropping an otherwise-valid row.
// Exported: `./index.ts` also clamps org/site names to the same width.
export function clamp(value: string | undefined | null, max: number): string | null {
  if (value == null) return null;
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Map a source billing address onto the `organizations.billing_address_*`
 * columns. Widths mirror routes/orgs.ts; an over-long value would throw and
 * roll back the whole group insert, dropping an otherwise-valid org.
 *
 * `billing_address_country` is char(2) and sources are free-form ("United
 * States", "USA", …), so only a genuine 2-letter code is persisted — the
 * untruncated address still survives in the site `address` JSONB, which has no
 * length cap.
 */
export function billingAddressColumns(addr: ImportRowBillingAddress | undefined): Record<string, string | null> {
  if (!addr) return {};
  return {
    billingAddressLine1: clamp(addr.line1, 255),
    billingAddressLine2: clamp(addr.line2, 255),
    billingAddressCity: clamp(addr.city, 120),
    billingAddressRegion: clamp(addr.region, 120),
    billingAddressPostalCode: clamp(addr.postalCode, 40),
    billingAddressCountry: addr.country?.length === 2 ? addr.country.toUpperCase() : null,
  };
}
