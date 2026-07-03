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
  ];

  it.each(MATCH)('opts out: %s %s', (method, path) => {
    expect(isSelfManagedDbContextRoute(method, path)).toBe(true);
  });

  it.each(NO_MATCH)('keeps ambient tx: %s %s (%s)', (method, path) => {
    expect(isSelfManagedDbContextRoute(method, path)).toBe(false);
  });
});
