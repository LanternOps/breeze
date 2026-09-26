import { describe, it, expect } from 'vitest';
import { isSelfManagedDbContextRoute } from './selfManagedDbContextRoutes';

// #1448 — these two routes opt OUT of the auth middleware's auto
// request-transaction so the Stripe Checkout HTTP call isn't made inside a held
// DB transaction. The predicate is a security-relevant contract: a route that
// wrongly matches loses its ambient RLS transaction; a pay route that wrongly
// fails to match re-pins a pooled connection across the network call.
describe('isSelfManagedDbContextRoute', () => {
  const MATCH: ReadonlyArray<[string, string]> = [
    ['POST', '/api/v1/devices/abc-123/filesystem/cleanup-execute'],
    ['POST', '/api/v1/devices/abc-123/filesystem/cleanup-execute/'],
    ['post', '/api/v1/devices/abc-123/filesystem/cleanup-execute'],
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
    ['GET', '/api/v1/portal/network/overview'],
    ['GET', '/api/v1/portal/network/overview/'],
    ['get', '/api/v1/portal/network/overview'], // method is case-insensitive
    ['GET', '/api/v1/portal/network/assets'],
    ['GET', '/api/v1/portal/network/assets/'],
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
    // #2787 bulk restore — runBulkIsolated opens one short transaction per
    // device; the ambient request tx would otherwise pin one pooled connection
    // (and every devices/device_commands lock it takes) across up to 500 items.
    ['POST', '/api/v1/devices/bulk/restore'],
    ['POST', '/api/v1/devices/bulk/restore/'],
    ['post', '/api/v1/devices/bulk/restore'], // method is case-insensitive
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
    // Accept on behalf (spec 2026-09-21) — the accept runs in its own system
    // context; the ambient request tx would pin a second pooled connection.
    ['POST', '/api/v1/quotes/abc-123/accept-on-behalf'],
    ['POST', '/api/v1/quotes/abc-123/accept-on-behalf/'],
    ['post', '/api/v1/quotes/abc-123/accept-on-behalf'], // method is case-insensitive
    // Task A9 — the tool test-call route dispatches a real outbound MCP call.
    ['POST', '/api/v1/tool-sources'],
    ['PATCH', '/api/v1/tool-sources/src-1'],
    ['POST', '/api/v1/tool-sources/src-1/discover'],
    ['POST', '/api/v1/tool-sources/src-1/tools/tool-1/test'],
    ['POST', '/api/v1/tool-sources/src-1/tools/tool-1/test/'],
    ['post', '/api/v1/tool-sources/src-1/tools/tool-1/test'], // method is case-insensitive
    // #6098 — POST /agent-versions/sync-github fetches the GitHub release +
    // manifest (RELEASE_FETCH_TIMEOUT_MS=30s) inside the handler; binarySync's
    // writes now manage their own short withSystemDbAccessContext blocks, so
    // the ambient request transaction must not be held across the fetch.
    ['POST', '/api/v1/agent-versions/sync-github'],
    ['POST', '/api/v1/agent-versions/sync-github/'],
    ['post', '/api/v1/agent-versions/sync-github'], // method is case-insensitive
    // #6008 W01 — the three backup-provider routes that call Cove inside the handler.
    ['POST', '/api/v1/backup/providers/connections'],
    ['POST', '/api/v1/backup/providers/connections/'],
    ['PATCH', '/api/v1/backup/providers/connections/conn-1'],
    ['PATCH', '/api/v1/backup/providers/connections/conn-1/'],
    ['POST', '/api/v1/backup/providers/connections/conn-1/test'],
    ['POST', '/api/v1/backup/providers/connections/conn-1/test/'],
    ['post', '/api/v1/backup/providers/connections/conn-1/test'], // method is case-insensitive
    // #6849 — policy "run now" patch-job creation calls enqueuePatchJob
    // (BullMQ) inside the handler. Under the ambient request transaction the
    // execute-patch-job worker can read the new patch_jobs row before this
    // request commits, log "not found", and leave it stranded until the
    // #1733 reconcile sweep re-enqueues it ~2 minutes later. The handler now
    // writes the row(s) in a short withAuthDbAccessContext block and enqueues
    // strictly after it commits.
    ['POST', '/api/v1/configuration-policies/policy-1/patch-job'],
    ['POST', '/api/v1/configuration-policies/policy-1/patch-job/'],
    ['post', '/api/v1/configuration-policies/policy-1/patch-job'], // method is case-insensitive
    // #6593 — Gmail inbound connect makes a DWD Google probe between short DB
    // contexts; it must own its context so that probe isn't inside a held tx.
    ['POST', '/api/v1/tickets/mailbox/connect/gmail'],
    ['POST', '/api/v1/tickets/mailbox/connect/gmail/'],
  ];

  const NO_MATCH: ReadonlyArray<[string, string, string]> = [
    ['GET', '/api/v1/configuration-policies/policy-1/patch-job', 'wrong method (only POST opts out)'],
    ['POST', '/api/v1/configuration-policies/policy-1/patch-settings', 'sibling route keeps the ambient tx'],
    // #6593 — the Microsoft mailbox /connect builds a consent URL with no
    // server-side Graph call, so it keeps the ambient tx; only the Gmail sibling
    // (which probes Google at connect time) opts out.
    ['POST', '/api/v1/tickets/mailbox/connect', 'M365 connect makes no outbound call at connect time'],
    ['POST', '/api/v1/devices/abc-123/filesystem/cleanup-preview', 'preview keeps ambient tx'],
    ['GET', '/api/v1/devices/abc-123/filesystem/cleanup-runs', 'history keeps ambient tx'],
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
    ['GET', '/api/v1/quotes/abc-123/accept-on-behalf', 'accept-on-behalf is POST-only'],
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
    ['POST', '/api/v1/portal/network/overview', 'network overview is GET-only'],
    ['GET', '/api/v1/portal/network', 'only the overview endpoint is self-managed'],
    ['GET', '/api/v1/portal/network/overview/extra', 'extra path segment must not match'],
    ['POST', '/api/v1/portal/network/assets', 'network assets is GET-only'],
    ['GET', '/api/v1/portal/network/assets/extra', 'extra path segment must not match'],
    ['POST', '/api/v1/portal/quotes/def-456/pay/confirm', 'deeper portal quote path must not match'],
    ['POST', '/api/v1/invoices', 'collection route'],
    ['DELETE', '/api/v1/partner/stripe-connect', 'disconnect is DB-only and keeps the ambient transaction'],
    ['GET', '/api/v1/tool-sources/src-1/tools/tool-1/test', 'test-call is POST-only'],
    ['POST', '/api/v1/tool-sources/src-1/tools/tool-1', 'PATCH tool route has no outbound call and keeps the ambient tx'],
    ['POST', '/api/v1/tool-sources/src-1/tools/tool-1/test/extra', 'extra path segment must not match'],
    ['POST', '/api/v1/tool-sources//tools/tool-1/test', 'empty source id segment must not match'],
    ['POST', '/api/v1/tool-sources/src-1/tools//test', 'empty tool id segment must not match'],
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

    // #2787 — the SINGLE restore does one device in one transaction and must
    // keep the ambient tx; losing it would put its writes on the bare pool with
    // no RLS GUC, silently affecting 0 rows (#1375).
    ['POST', '/api/v1/devices/11111111-1111-4111-8111-111111111111/restore', 'single restore keeps ambient tx'],
    ['POST', '/api/v1/devices/bulk/restore/extra', 'extra segment must not match'],
    ['GET', '/api/v1/devices/bulk/restore', 'bulk restore is POST-only'],
    // Bulk permanent delete only validates and ENQUEUES — no slow work in the
    // handler, so it keeps the ambient transaction (same call as quotes/bulk-send).
    ['POST', '/api/v1/devices/bulk/permanent-delete', 'bulk purge only enqueues; the worker does the work'],

    // The other catalog mutations are DB-only and MUST keep the ambient tx.
    ['GET', '/api/v1/admin/llm-provider-catalog', 'catalog listing is DB-only'],
    ['POST', '/api/v1/admin/llm-provider-catalog/entry-1/activate', 'activation is DB-only'],
    ['GET', '/api/v1/admin/llm-provider-catalog/entry-1/revisions', 'revision create is POST-only'],
    ['POST', '/api/v1/admin/llm-provider-catalog//revisions', 'empty entry id must not match'],
    ['POST', '/api/v1/admin/llm-provider-catalog/entry-1/revisions/extra', 'extra segment must not match'],
    ['GET', '/api/v1/admin/llm-provider-catalog/revisions/rev-1/verify', 'verify is POST-only'],
    ['POST', '/api/v1/admin/llm-provider-catalog/revisions//verify', 'empty revision id must not match'],
    ['POST', '/api/v1/admin/llm-provider-catalog/revisions/rev-1/verify/extra', 'extra segment must not match'],
    // #6098 — the other agent-versions routes are DB-only (or, for /pinnable,
    // the whole point is a cheap tenant-scoped read) and must keep the
    // ambient RLS transaction.
    ['GET', '/api/v1/agent-versions/sync-github', 'sync-github is POST-only'],
    ['POST', '/api/v1/agent-versions/sync-github/extra', 'extra segment must not match'],
    ['POST', '/api/v1/agent-versions', 'plain upload route is DB-only'],
    ['GET', '/api/v1/agent-versions/pinnable', 'pinnable listing is DB-only'],
    // #6337 — only the SNMP config writes enqueue a poll; the other monitoring
    // asset routes are DB-only and keep the ambient RLS transaction.
    ['GET', '/api/v1/monitoring/assets/11111111-1111-4111-8111-111111111111/snmp', 'snmp read is DB-only'],
    ['DELETE', '/api/v1/monitoring/assets/11111111-1111-4111-8111-111111111111/snmp', 'snmp delete is DB-only'],
    ['PUT', '/api/v1/monitoring/assets/11111111-1111-4111-8111-111111111111', 'asset update is DB-only'],
    ['PUT', '/api/v1/monitoring/assets/11111111-1111-4111-8111-111111111111/snmp/extra', 'extra segment must not match'],
    // The provider routes that do only DB work MUST keep the ambient tx —
    // losing it would put their writes on the bare pool with no RLS GUC, where
    // forced RLS silently affects 0 rows (#1375).
    ['GET', '/api/v1/backup/providers/connections', 'listing is DB-only'],
    ['POST', '/api/v1/backup/providers/connections/conn-1/sync', 'sync only enqueues'],
    ['DELETE', '/api/v1/backup/providers/connections/conn-1', 'delete makes no outbound call'],
    ['PUT', '/api/v1/backup/providers/customers/cust-1/mapping', 'remap is DB-only'],
    ['PUT', '/api/v1/backup/providers/devices/dev-1/link', 'manual link is DB-only'],
    ['POST', '/api/v1/backup/providers/connections//test', 'empty connection id must not match'],
    ['POST', '/api/v1/backup/providers/connections/conn-1/test/extra', 'extra segment must not match'],
    ['GET', '/api/v1/backup/providers/connections/conn-1/test', 'test is POST-only'],
  ];

  const SNMP_MATCH: ReadonlyArray<[string, string]> = [
    // #6337 — both SNMP config writes enqueue an immediate poll after their
    // own short DB context closes, so they must not inherit an ambient tx.
    ['PUT', '/api/v1/monitoring/assets/11111111-1111-4111-8111-111111111111/snmp'],
    ['PATCH', '/api/v1/monitoring/assets/11111111-1111-4111-8111-111111111111/snmp'],
  ];

  it.each(SNMP_MATCH)('opts out (#6337): %s %s', (method, path) => {
    expect(isSelfManagedDbContextRoute(method, path)).toBe(true);
  });

  it.each(MATCH)('opts out: %s %s', (method, path) => {
    expect(isSelfManagedDbContextRoute(method, path)).toBe(true);
  });

  it.each(NO_MATCH)('keeps ambient tx: %s %s (%s)', (method, path) => {
    expect(isSelfManagedDbContextRoute(method, path)).toBe(false);
  });
});

  it('opts the two system-cleanup POSTs out of the ambient transaction, and nothing else', () => {
    expect(isSelfManagedDbContextRoute('POST', '/api/v1/devices/22222222-2222-4222-8222-222222222222/filesystem/system-cleanup/run')).toBe(true);
    expect(isSelfManagedDbContextRoute('POST', '/api/v1/devices/22222222-2222-4222-8222-222222222222/filesystem/system-cleanup/list')).toBe(true);
    // The polls are plain reads — they must keep the request transaction.
    expect(isSelfManagedDbContextRoute('GET', '/api/v1/devices/22222222-2222-4222-8222-222222222222/filesystem/system-cleanup/run/44444444-4444-4444-8444-444444444444')).toBe(false);
    expect(isSelfManagedDbContextRoute('GET', '/api/v1/devices/22222222-2222-4222-8222-222222222222/filesystem/system-cleanup/list/33333333-3333-4333-8333-333333333333')).toBe(false);
    // And the file engine's routes are untouched.
    expect(isSelfManagedDbContextRoute('POST', '/api/v1/devices/22222222-2222-4222-8222-222222222222/filesystem/scan')).toBe(false);
  });

// Caller verification (#6354 W01): only the three Graph-backed operations own
// their DB context; every other verification route keeps the ambient tx.
it.each([['GET', 'caller-verification-directory-users'], ['POST', 'caller-verification-directory-sync']])('self-manages %s %s', (method, path) => {
  expect(isSelfManagedDbContextRoute(method, `/api/v1/orgs/o/${path}`)).toBe(true);
  expect(isSelfManagedDbContextRoute(method === 'GET' ? 'POST' : 'GET', `/api/v1/orgs/o/${path}`)).toBe(false);
});

it('self-manages the Graph binding POST but not ordinary verification writes', () => {
  const path = '/api/v1/orgs/o/contacts/c/caller-verification-bindings';
  expect(isSelfManagedDbContextRoute('POST', path)).toBe(true);
  expect(isSelfManagedDbContextRoute('DELETE', `${path}/b`)).toBe(false);
  expect(isSelfManagedDbContextRoute('POST', '/api/v1/orgs/o/caller-verifications')).toBe(false);
  expect(isSelfManagedDbContextRoute('PUT', '/api/v1/orgs/o/caller-verification-policy')).toBe(false);
});

// #7103 — manual Run Script creates its rows in a short committed context and
// sends only after that commit, so it cannot run inside the request tx. Only the
// execute POST opts out; the script's other routes keep the ambient tx.
it('self-manages POST /scripts/:id/execute and no sibling script route', () => {
  expect(isSelfManagedDbContextRoute('POST', '/api/v1/scripts/abc-123/execute')).toBe(true);
  expect(isSelfManagedDbContextRoute('POST', '/api/v1/scripts/abc-123/execute/')).toBe(true);
  expect(isSelfManagedDbContextRoute('GET', '/api/v1/scripts/abc-123/execute')).toBe(false);
  expect(isSelfManagedDbContextRoute('GET', '/api/v1/scripts/abc-123/executions')).toBe(false);
  expect(isSelfManagedDbContextRoute('POST', '/api/v1/scripts/abc-123/duplicate')).toBe(false);
});
