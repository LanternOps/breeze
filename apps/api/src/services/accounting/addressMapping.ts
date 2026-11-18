/**
 * QuickBooks address → Breeze site-address mapping, split out of
 * `accountingCustomerImport.ts` so callers that only need this pure
 * formatting helper don't pull in the rest of the QBO customer-import
 * pipeline's import graph.
 *
 * `accountingCustomerImport.ts` re-exports `siteAddressFrom` from here for
 * its own callers; `accountingMappingService.ts` imports directly from this
 * file instead — `accountingCustomerImport.ts` transitively imports
 * `services/orgImport/index.ts` (for `commitOrgImport`/`previewOrgImport`)
 * and with it the tenant-lifecycle service graph. That graph reached
 * `routes/agentWs.ts` until #4142 moved the tenant socket sever onto the
 * relay facade; it is still a large graph these callers have no use for.
 * Several `accountingMappingService` callers (quoteSendWorker,
 * stripeReconcileSweep, invoiceWorker, contractWorker, accountingSyncWorker,
 * accountingReconcileWorker) are `global`-placement workers in
 * `workerRegistry.ts`: their import closure must never reach socket-local
 * dispatch (see `workerEntrypointClosure.contract.test.ts`).
 */

import type { RemoteAddress } from './types';

export function siteAddressFrom(addr: RemoteAddress | undefined): Record<string, string> | undefined {
  if (!addr) return undefined;
  // Match the web SiteForm convention so imported sites render correctly.
  const out: Record<string, string> = {};
  if (addr.line1) out.addressLine1 = addr.line1;
  if (addr.line2) out.addressLine2 = addr.line2;
  if (addr.city) out.city = addr.city;
  if (addr.region) out.state = addr.region;
  if (addr.postalCode) out.postalCode = addr.postalCode;
  if (addr.country) out.country = addr.country;
  return Object.keys(out).length ? out : undefined;
}
