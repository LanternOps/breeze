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
    // Customer-portal "Pay quote" (#3777 review F2) — createQuotePayLink →
    // createInvoicePayLink → checkout.sessions.create, same shape as the
    // invoice pay route above. Until registered, the portal auth middleware
    // pinned the request tx AND a system tx across the Stripe round-trip.
    ['POST', '/api/v1/portal/quotes/def-456/pay'],
    ['POST', '/api/v1/portal/quotes/def-456/pay/'],
    ['post', '/api/v1/portal/quotes/def-456/pay'], // method is case-insensitive
    ['POST', '/api/v1/partner/stripe-connect/key'],
    ['POST', '/api/v1/partner/stripe-connect/key/'],
    ['GET', '/api/v1/partner/stripe-connect'],
    ['GET', '/api/v1/partner/stripe-connect/'],
    ['POST', '/api/v1/partner/stripe-connect/refresh'],
    ['POST', '/api/v1/partner/stripe-connect/refresh/'],
    // QuickBooks customer import — both page the QBO API inside the handler.
    ['GET', '/api/v1/accounting/quickbooks/customers'],
    ['GET', '/api/v1/accounting/quickbooks/customers/'],
    ['POST', '/api/v1/accounting/quickbooks/customers/import'],
    ['POST', '/api/v1/accounting/quickbooks/customers/import/'],
    // Task 5 entity-mapping routes — all four call QuickBooks HTTP inside the
    // handler (list proposals, list income accounts, verify-on-confirm, sync).
    ['GET', '/api/v1/accounting/quickbooks/mappings'],
    ['GET', '/api/v1/accounting/quickbooks/mappings/'],
    ['GET', '/api/v1/accounting/quickbooks/income-accounts'],
    ['GET', '/api/v1/accounting/quickbooks/income-accounts/'],
    ['PUT', '/api/v1/accounting/quickbooks/mappings'],
    ['PUT', '/api/v1/accounting/quickbooks/mappings/'],
    ['POST', '/api/v1/accounting/quickbooks/mappings/sync'],
    ['POST', '/api/v1/accounting/quickbooks/mappings/sync/'],
    ['put', '/api/v1/accounting/quickbooks/mappings'], // method is case-insensitive
    // Phase C Task 2 — settings refresh calls provider.fetchRealmSettings
    // (real QuickBooks HTTP) inside the handler.
    ['POST', '/api/v1/accounting/quickbooks/settings/refresh'],
    ['POST', '/api/v1/accounting/quickbooks/settings/refresh/'],
    ['post', '/api/v1/accounting/quickbooks/settings/refresh'], // method is case-insensitive
    // Phase C Task 5 — manual invoice push and remote-candidate search both
    // call QuickBooks HTTP inside the handler. push-bulk is deliberately
    // ABSENT from this list (see the NO_MATCH block below) — it only enqueues
    // to Redis and never calls QuickBooks itself.
    ['POST', '/api/v1/accounting/quickbooks/invoices/abc-123/push'],
    ['POST', '/api/v1/accounting/quickbooks/invoices/abc-123/push/'],
    ['post', '/api/v1/accounting/quickbooks/invoices/abc-123/push'], // method is case-insensitive
    ['GET', '/api/v1/accounting/quickbooks/remote-candidates'],
    ['GET', '/api/v1/accounting/quickbooks/remote-candidates/'],
    ['get', '/api/v1/accounting/quickbooks/remote-candidates'], // method is case-insensitive
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
    // PSA connection test — real outbound PSA API call between short contexts.
    ['POST', '/api/v1/psa/connections/conn-1/test'],
    ['POST', '/api/v1/psa/connections/conn-1/test/'],
    ['post', '/api/v1/psa/connections/conn-1/test'], // method is case-insensitive
    // PSA company import (#3246) — preview walks the PSA's pagination (many
    // 20s outbound calls); commit runs the org-import seam's own per-group
    // transactions. Neither may inherit the ambient request transaction.
    ['POST', '/api/v1/psa/connections/conn-1/import/preview'],
    ['POST', '/api/v1/psa/connections/conn-1/import/preview/'],
    ['post', '/api/v1/psa/connections/conn-1/import/preview'],
    ['POST', '/api/v1/psa/connections/conn-1/import'],
    ['POST', '/api/v1/psa/connections/conn-1/import/'],
    ['post', '/api/v1/psa/connections/conn-1/import'],

    // Live agent session listing — awaits a 10s agent round-trip (#1105), so it
    // must not hold a pooled connection idle-in-transaction.
    ['GET', '/api/v1/devices/dev-1/sessions/live'],
    ['GET', '/api/v1/devices/dev-1/sessions/live/'],
    ['get', '/api/v1/devices/dev-1/sessions/live'],

    // LLM provider catalog fidelity verification — runs a full tool-use
    // round-trip against the provider AND spawns an Agent SDK subprocess.
    ['POST', '/api/v1/admin/llm-provider-catalog/revisions/rev-1/verify'],
    ['POST', '/api/v1/admin/llm-provider-catalog/revisions/rev-1/verify/'],
    ['post', '/api/v1/admin/llm-provider-catalog/revisions/rev-1/verify'],
    // Revision authoring resolves the operator-supplied base URL through
    // assertSafeUrl (a real DNS lookup) BEFORE any DB work — holding the
    // request transaction across it pins a pooled connection on a resolver
    // the operator chose the timeout of.
    ['POST', '/api/v1/admin/llm-provider-catalog/entry-1/revisions'],
    ['POST', '/api/v1/admin/llm-provider-catalog/entry-1/revisions/'],
    ['post', '/api/v1/admin/llm-provider-catalog/entry-1/revisions'],
    // #3905 — quote send/re-send render the proposal PDF and run the outbound
    // mail round-trip in the handler, and sendQuote holds a FOR UPDATE lock on
    // the quote (and a revision's PARENT) that only the commit releases.
    ['POST', '/api/v1/quotes/abc-123/send'],
    ['POST', '/api/v1/quotes/abc-123/send/'],
    ['post', '/api/v1/quotes/abc-123/send'], // method is case-insensitive
    ['POST', '/api/v1/quotes/abc-123/resend'],
    ['POST', '/api/v1/quotes/abc-123/resend/'],
    ['post', '/api/v1/quotes/abc-123/resend'], // method is case-insensitive
  ];

  const NO_MATCH: ReadonlyArray<[string, string, string]> = [
    // #3905 — the /send pattern must not swallow its siblings. Losing the
    // ambient transaction on a route whose handler does NOT manage its own
    // contexts means every db call there lands on the bare pool with no RLS
    // GUC and silently affects 0 rows (#1375).
    ['POST', '/api/v1/quotes/bulk-send', 'bulk-send is one path segment, and runBulkIsolated already opens a tx per item'],
    ['POST', '/api/v1/quotes/abc-123/schedule-send', 'schedule-send only enqueues; it keeps the ambient tx'],
    ['DELETE', '/api/v1/quotes/abc-123/schedule-send', 'undo-send is DB-only'],
    ['GET', '/api/v1/quotes/abc-123/send', 'send is POST-only'],
    ['POST', '/api/v1/quotes//send', 'empty id segment must not match'],
    ['POST', '/api/v1/quotes/abc-123/send/extra', 'extra path segment must not match'],
    ['GET', '/api/v1/quotes/abc-123/share-link', 'share-link mails nothing and keeps the ambient tx'],
    ['GET', '/api/v1/invoices/abc-123/pay-link', 'wrong method (only POST opts out)'],
    ['GET', '/api/v1/portal/invoices/def-456/pay', 'wrong method'],
    ['POST', '/api/v1/invoices/abc-123', 'invoice route without /pay-link'],
    ['POST', '/api/v1/invoices/abc-123/pay', 'partner route has no plain /pay'],
    ['POST', '/api/v1/portal/invoices/def-456/pay-link', 'portal route has no /pay-link'],
    ['POST', '/api/v1/invoices/abc-123/pay-link/extra', 'extra path segment must not match'],
    ['POST', '/api/v1/invoices//pay-link', 'empty id segment must not match'],
    ['POST', '/api/v1/portal/invoices/def-456/pay/confirm', 'deeper portal path must not match'],
    ['GET', '/api/v1/portal/quotes/def-456/pay', 'portal quote pay is POST-only'],
    ['POST', '/api/v1/portal/quotes/def-456/accept', 'accept/decline are DB-only and keep the ambient org tx'],
    ['POST', '/api/v1/portal/quotes/def-456/decline', 'accept/decline are DB-only and keep the ambient org tx'],
    ['POST', '/api/v1/portal/quotes//pay', 'empty id segment must not match'],
    ['POST', '/api/v1/portal/quotes/def-456/pay/confirm', 'deeper portal quote path must not match'],
    ['POST', '/api/v1/invoices', 'collection route'],
    ['DELETE', '/api/v1/partner/stripe-connect', 'disconnect is DB-only and keeps the ambient transaction'],
    ['GET', '/api/v1/accounting/quickbooks', 'accounting status route does only DB work — keep ambient tx'],
    ['POST', '/api/v1/accounting/quickbooks/customers', 'POST to the list route (only GET + /customers/import opt out)'],
    ['GET', '/api/v1/accounting/quickbooks/customers/import', 'import is POST-only'],
    ['POST', '/api/v1/accounting/quickbooks/customers/import/extra', 'extra segment must not match'],
    // Task 5 — every OTHER accounting route (connect/callback/disconnect/status/
    // settings) does only DB work and MUST keep the ambient RLS transaction.
    ['POST', '/api/v1/accounting/quickbooks/mappings', 'POST to the mappings route (only GET/PUT opt out)'],
    ['DELETE', '/api/v1/accounting/quickbooks/mappings', 'DELETE to the mappings route is not a route at all'],
    ['GET', '/api/v1/accounting/quickbooks/mappings/extra', 'extra segment must not match'],
    ['GET', '/api/v1/accounting/quickbooks/income-accounts/extra', 'extra segment must not match'],
    ['POST', '/api/v1/accounting/quickbooks/income-accounts', 'income-accounts is GET-only'],
    ['GET', '/api/v1/accounting/quickbooks/mappings/sync', 'sync is POST-only'],
    ['PUT', '/api/v1/accounting/quickbooks/mappings/sync', 'sync is POST-only, not PUT'],
    ['POST', '/api/v1/accounting/quickbooks/mappings/sync/extra', 'extra segment must not match'],
    // Phase C Task 2 — refresh is POST-only, and the sibling PATCH .../settings
    // route (no /refresh) makes no outbound call — keep the ambient tx.
    ['GET', '/api/v1/accounting/quickbooks/settings/refresh', 'refresh is POST-only'],
    ['POST', '/api/v1/accounting/quickbooks/settings/refresh/extra', 'extra segment must not match'],
    ['PATCH', '/api/v1/accounting/quickbooks/settings', 'plain settings PATCH does only DB work'],
    // Phase C Task 5 — push-bulk only enqueues to Redis (never calls
    // QuickBooks), so it must NOT match despite sharing the /invoices/ prefix
    // with the single-invoice push route above.
    ['POST', '/api/v1/accounting/quickbooks/invoices/push-bulk', 'bulk enqueue is DB/Redis-only, no outbound QuickBooks call'],
    ['GET', '/api/v1/accounting/quickbooks/invoices/abc-123/push', 'invoice push is POST-only'],
    ['POST', '/api/v1/accounting/quickbooks/invoices/abc-123/push/extra', 'extra segment must not match'],
    ['POST', '/api/v1/accounting/quickbooks/invoices//push', 'empty invoiceId segment must not match'],
    ['POST', '/api/v1/accounting/quickbooks/remote-candidates', 'remote-candidates is GET-only'],
    ['GET', '/api/v1/accounting/quickbooks/remote-candidates/extra', 'extra segment must not match'],
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
    // PSA — every OTHER psa route does only DB work and MUST keep the ambient
    // RLS transaction (the sync route is a DB-free 501 stub).
    ['GET', '/api/v1/psa/connections', 'list is DB-only'],
    ['POST', '/api/v1/psa/connections', 'create is DB-only'],
    ['GET', '/api/v1/psa/connections/conn-1', 'detail read is DB-only'],
    ['PATCH', '/api/v1/psa/connections/conn-1', 'update is DB-only'],
    ['DELETE', '/api/v1/psa/connections/conn-1', 'delete is DB-only'],
    ['POST', '/api/v1/psa/connections/conn-1/sync', 'sync is a 501 stub — no outbound call'],
    ['POST', '/api/v1/psa/connections/conn-1/status', 'status flip is DB-only'],
    ['GET', '/api/v1/psa/connections/conn-1/test', 'test is POST-only'],
    ['POST', '/api/v1/psa/connections//test', 'empty connection id must not match'],
    ['POST', '/api/v1/psa/connections/conn-1/test/extra', 'extra segment must not match'],
    ['GET', '/api/v1/psa/connections/conn-1/import', 'import is POST-only'],
    ['GET', '/api/v1/psa/connections/conn-1/import/preview', 'preview is POST-only'],
    ['POST', '/api/v1/psa/connections//import', 'empty connection id must not match'],
    ['POST', '/api/v1/psa/connections//import/preview', 'empty connection id must not match'],
    ['POST', '/api/v1/psa/connections/conn-1/import/extra', 'extra segment must not match'],
    ['POST', '/api/v1/psa/connections/conn-1/import/preview/extra', 'extra segment must not match'],

    // The sibling session routes do only DB work and MUST keep the ambient tx.
    ['GET', '/api/v1/devices/dev-1/sessions/active', 'active listing is DB-only'],
    ['GET', '/api/v1/devices/dev-1/sessions/history', 'history is DB-only'],
    ['POST', '/api/v1/devices/dev-1/sessions/live', 'live is GET-only'],
    ['GET', '/api/v1/devices//sessions/live', 'empty device id must not match'],
    ['GET', '/api/v1/devices/dev-1/sessions/live/extra', 'extra segment must not match'],

    // The other catalog mutations are DB-only and MUST keep the ambient tx.
    ['GET', '/api/v1/admin/llm-provider-catalog', 'catalog listing is DB-only'],
    ['POST', '/api/v1/admin/llm-provider-catalog/entry-1/activate', 'activation is DB-only'],
    ['GET', '/api/v1/admin/llm-provider-catalog/entry-1/revisions', 'revision create is POST-only'],
    ['POST', '/api/v1/admin/llm-provider-catalog//revisions', 'empty entry id must not match'],
    ['POST', '/api/v1/admin/llm-provider-catalog/entry-1/revisions/extra', 'extra segment must not match'],
    ['GET', '/api/v1/admin/llm-provider-catalog/revisions/rev-1/verify', 'verify is POST-only'],
    ['POST', '/api/v1/admin/llm-provider-catalog/revisions//verify', 'empty revision id must not match'],
    ['POST', '/api/v1/admin/llm-provider-catalog/revisions/rev-1/verify/extra', 'extra segment must not match'],
  ];

  it.each(MATCH)('opts out: %s %s', (method, path) => {
    expect(isSelfManagedDbContextRoute(method, path)).toBe(true);
  });

  it.each(NO_MATCH)('keeps ambient tx: %s %s (%s)', (method, path) => {
    expect(isSelfManagedDbContextRoute(method, path)).toBe(false);
  });
});
