import { describe, it, expect } from 'vitest';
import { isSelfManagedDbContextRoute } from './selfManagedDbContextRoutes';

// #1448 — these two routes opt OUT of the auth middleware's auto
// request-transaction so the Stripe Checkout HTTP call isn't made inside a held
// DB transaction. The predicate is a security-relevant contract: a route that
// wrongly matches loses its ambient RLS transaction; a pay route that wrongly
// fails to match re-pins a pooled connection across the network call.
describe('isSelfManagedDbContextRoute', () => {
  const MATCH: ReadonlyArray<[string, string]> = [
    ['POST', '/api/v1/invoices/abc-123/pay-link'],
    ['POST', '/api/v1/invoices/abc-123/pay-link/'], // optional trailing slash
    ['post', '/api/v1/invoices/abc-123/pay-link'], // method is case-insensitive
    ['POST', '/api/v1/portal/invoices/def-456/pay'],
    ['POST', '/api/v1/portal/invoices/def-456/pay/'],
    // QuickBooks customer import — both page the QBO API inside the handler.
    ['GET', '/api/v1/accounting/quickbooks/customers'],
    ['GET', '/api/v1/accounting/quickbooks/customers/'],
    ['POST', '/api/v1/accounting/quickbooks/customers/import'],
    ['POST', '/api/v1/accounting/quickbooks/customers/import/'],
    // #2190 — distributor catalog imports run a best-effort AI enrichment call
    // inside the handler.
    ['POST', '/api/v1/catalog/distributors/td-synnex/import'],
    ['POST', '/api/v1/catalog/distributors/td-synnex/import/'],
    ['POST', '/api/v1/catalog/distributors/td-synnex-ec/import'],
    ['POST', '/api/v1/catalog/distributors/td-synnex-ec/import/'],
    ['POST', '/api/v1/catalog/distributors/pax8/import'],
    ['POST', '/api/v1/catalog/distributors/pax8/import/'],
    ['post', '/api/v1/catalog/distributors/pax8/import'], // method is case-insensitive
    // PR3 — the three SSO provider routes that run OIDC discovery against a
    // tenant-controlled issuer (10s timeout) inside the handler.
    ['POST', '/api/v1/sso/providers'],
    ['POST', '/api/v1/sso/providers/'],
    ['PATCH', '/api/v1/sso/providers/abc-123'],
    ['PATCH', '/api/v1/sso/providers/abc-123/'],
    ['patch', '/api/v1/sso/providers/abc-123'], // method is case-insensitive
    ['POST', '/api/v1/sso/providers/abc-123/test'],
    ['POST', '/api/v1/sso/providers/abc-123/test/'],
    // Pax8 line authoring may fetch commitment dependencies from Pax8.
    ['POST', '/api/v1/pax8/orders/ord-1/lines'],
    ['POST', '/api/v1/pax8/orders/ord-1/lines/'],
    ['post', '/api/v1/pax8/orders/ord-1/lines'], // method is case-insensitive
    // Pax8 submit/reconcile phases make outbound calls between short DB txns.
    ['POST', '/api/v1/pax8/orders/ord-1/preflight'],
    ['POST', '/api/v1/pax8/orders/ord-1/preflight/'],
    ['POST', '/api/v1/pax8/orders/ord-1/submit'],
    ['POST', '/api/v1/pax8/orders/ord-1/submit/'],
    ['POST', '/api/v1/pax8/orders/ord-1/reconcile'],
    ['POST', '/api/v1/pax8/orders/ord-1/reconcile/'],
    // Product form metadata proxies Pax8 HTTP after a short credential read.
    ['GET', '/api/v1/pax8/products/prod-1/provision-details'],
    ['GET', '/api/v1/pax8/products/prod-1/provision-details/'],
    ['GET', '/api/v1/pax8/products/prod-1/dependencies'],
    ['GET', '/api/v1/pax8/products/prod-1/dependencies/'],
    ['GET', '/api/v1/m365/consent/callback'],
    ['GET', '/api/v1/m365/consent/callback/'],
    ['POST', '/api/v1/m365/connections/44444444-4444-4444-8444-444444444444/retest'],
    ['POST', '/api/v1/m365/connections/44444444-4444-4444-8444-444444444444/retest/'],
  ];

  const NO_MATCH: ReadonlyArray<[string, string, string]> = [
    ['GET', '/api/v1/invoices/abc-123/pay-link', 'wrong method (only POST opts out)'],
    ['GET', '/api/v1/portal/invoices/def-456/pay', 'wrong method'],
    ['POST', '/api/v1/invoices/abc-123', 'invoice route without /pay-link'],
    ['POST', '/api/v1/invoices/abc-123/pay', 'partner route has no plain /pay'],
    ['POST', '/api/v1/portal/invoices/def-456/pay-link', 'portal route has no /pay-link'],
    ['POST', '/api/v1/invoices/abc-123/pay-link/extra', 'extra path segment must not match'],
    ['POST', '/api/v1/invoices//pay-link', 'empty id segment must not match'],
    ['POST', '/api/v1/portal/invoices/def-456/pay/confirm', 'deeper portal path must not match'],
    ['POST', '/api/v1/invoices', 'collection route'],
    ['GET', '/api/v1/accounting/quickbooks', 'accounting status route does only DB work — keep ambient tx'],
    ['POST', '/api/v1/accounting/quickbooks/customers', 'POST to the list route (only GET + /customers/import opt out)'],
    ['GET', '/api/v1/accounting/quickbooks/customers/import', 'import is POST-only'],
    ['POST', '/api/v1/accounting/quickbooks/customers/import/extra', 'extra segment must not match'],
    // #2190 — the other distributor routes (status/config/test/search/lookup/pricing)
    // do only DB work — keep the ambient tx.
    ['GET', '/api/v1/catalog/distributors/td-synnex/status', 'status route is DB-only'],
    ['POST', '/api/v1/catalog/distributors/td-synnex/test', 'connection test is DB-only'],
    ['GET', '/api/v1/catalog/distributors/td-synnex/search', 'search is DB-only'],
    ['POST', '/api/v1/catalog/distributors/td-synnex/import/extra', 'extra segment must not match'],
    ['GET', '/api/v1/catalog/distributors/td-synnex/import', 'import is POST-only'],
    ['GET', '/api/v1/catalog/distributors/td-synnex-ec/status', 'status route is DB-only'],
    ['GET', '/api/v1/catalog/distributors/td-synnex-ec/lookup', 'lookup is DB-only'],
    ['POST', '/api/v1/catalog/distributors/td-synnex-ec/import/extra', 'extra segment must not match'],
    ['GET', '/api/v1/catalog/distributors/pax8/status', 'status route is DB-only'],
    ['GET', '/api/v1/catalog/distributors/pax8/search', 'search is DB-only'],
    ['GET', '/api/v1/catalog/distributors/pax8/pricing', 'pricing is DB-only'],
    ['POST', '/api/v1/catalog/distributors/pax8/import/extra', 'extra segment must not match'],
    ['GET', '/api/v1/catalog/distributors/pax8/import', 'import is POST-only'],
    // PR3 — every OTHER sso route does only DB work and MUST keep the ambient
    // RLS transaction. A wrong match here silently drops tenant scoping.
    ['GET', '/api/v1/sso/providers', 'list is DB-only'],
    ['GET', '/api/v1/sso/providers/abc-123', 'detail read is DB-only'],
    ['DELETE', '/api/v1/sso/providers/abc-123', 'delete is DB-only (system-context cascade)'],
    ['POST', '/api/v1/sso/providers/abc-123/status', 'status flip is DB-only'],
    ['PATCH', '/api/v1/sso/providers/abc-123/test', 'no such route; PATCH only opts out on the bare provider path'],
    ['GET', '/api/v1/sso/providers/abc-123/test', 'test is POST-only'],
    ['POST', '/api/v1/sso/providers/abc-123/test/extra', 'extra segment must not match'],
    ['POST', '/api/v1/sso/domains', 'domain routes are DB-only'],
    ['POST', '/api/v1/sso/link/start/abc-123', 'link start is DB-only'],
    ['GET', '/api/v1/pax8/orders/ord-1/lines', 'Pax8 line authoring is POST-only'],
    ['POST', '/api/v1/pax8/orders//lines', 'Pax8 order id must not be empty'],
    ['POST', '/api/v1/pax8/orders/ord-1/lines/extra', 'extra segment must not match'],
    ['GET', '/api/v1/pax8/orders/ord-1/preflight', 'Pax8 preflight is POST-only'],
    ['GET', '/api/v1/pax8/orders/ord-1/submit', 'Pax8 submit is POST-only'],
    ['GET', '/api/v1/pax8/orders/ord-1/reconcile', 'Pax8 reconcile is POST-only'],
    ['POST', '/api/v1/pax8/orders//submit', 'Pax8 order id must not be empty'],
    ['POST', '/api/v1/pax8/orders/ord-1/submit/extra', 'extra segment must not match'],
    ['POST', '/api/v1/pax8/products/prod-1/dependencies', 'Pax8 product metadata routes are GET-only'],
    ['GET', '/api/v1/pax8/products//dependencies', 'Pax8 product id must not be empty'],
    ['GET', '/api/v1/pax8/products/prod-1/dependencies/extra', 'extra segment must not match'],
    ['POST', '/api/v1/m365/consent/callback', 'callback is GET-only'],
    ['GET', '/api/v1/m365/connections/44444444-4444-4444-8444-444444444444/retest', 'retest is POST-only'],
    ['POST', '/api/v1/m365/connections//retest', 'empty connection id must not match'],
    ['POST', '/api/v1/m365/connections/44444444-4444-4444-8444-444444444444/retest/extra', 'extra segment must not match'],
  ];

  it.each(MATCH)('opts out: %s %s', (method, path) => {
    expect(isSelfManagedDbContextRoute(method, path)).toBe(true);
  });

  it.each(NO_MATCH)('keeps ambient tx: %s %s (%s)', (method, path) => {
    expect(isSelfManagedDbContextRoute(method, path)).toBe(false);
  });
});
