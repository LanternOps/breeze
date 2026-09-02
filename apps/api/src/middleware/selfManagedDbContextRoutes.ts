// #1448 — routes that opt OUT of the auto request-transaction.
//
// The auth middlewares (auth.ts, portal/auth.ts) normally wrap the entire
// route handler in `withDbAccessContext` → `baseDb.transaction`, pinning one
// pooled PG connection idle-in-transaction for the whole handler. That is fine
// for handlers that only do DB work, but a handler that makes a slow outbound
// HTTP call (e.g. Stripe Checkout `sessions.create`, a hundreds-of-ms round
// trip) inside that held transaction holds the connection idle across the
// network call — the #1105 pool-poison class.
//
// `runOutsideDbContext` alone does NOT help: it only swaps the AsyncLocalStorage
// `db` proxy reference (pool vs tx); the OUTER `baseDb.transaction` opened by the
// middleware is still held for the whole handler regardless. The only way to not
// hold the connection across the HTTP call is to never open the wrapping
// transaction for these routes — so the middleware consults this predicate and,
// when it matches, runs the handler with NO ambient context. Those handlers then
// manage their own short DB access contexts (read in a `withSystemDbAccessContext`,
// run the HTTP call truly outside any tx, write the result in a fresh short
// `withSystemDbAccessContext`), keeping the contextless-write guard (#1375) happy
// while never pinning a connection across the network call.
//
// Match against the full request path the middleware sees (`c.req.path`, which
// includes the `/api/v1` mount prefix and the substituted `:id`), so each entry
// is a regex over the concrete path, not a literal route pattern.
interface SelfManagedRoute {
  method: string;
  pattern: RegExp;
}

const SELF_MANAGED_DB_CONTEXT_ROUTES: readonly SelfManagedRoute[] = [
  // Partner-initiated "Send payment link" — createInvoicePayLink.
  { method: 'POST', pattern: /^\/api\/v1\/invoices\/[^/]+\/pay-link\/?$/ },
  // Customer-portal "Pay invoice online".
  { method: 'POST', pattern: /^\/api\/v1\/portal\/invoices\/[^/]+\/pay\/?$/ },
  // Customer-portal "Pay quote" — createQuotePayLink → createInvoicePayLink →
  // checkout.sessions.create. Same shape as the invoice pay route; it was missed
  // when the route shipped, so the portal request tx was pinned across Stripe
  // (#3777 review F2).
  { method: 'POST', pattern: /^\/api\/v1\/portal\/quotes\/[^/]+\/pay\/?$/ },
  // Stripe key verification — savePartnerStripeKey calls accounts.retrieve.
  { method: 'POST', pattern: /^\/api\/v1\/partner\/stripe-connect\/key\/?$/ },
  // Stripe cache lazy refresh — getPartnerStripeAccountSnapshot may call accounts.retrieve.
  { method: 'GET', pattern: /^\/api\/v1\/partner\/stripe-connect\/?$/ },
  // Stripe cache forced refresh — refreshPartnerStripeAccount calls accounts.retrieve.
  { method: 'POST', pattern: /^\/api\/v1\/partner\/stripe-connect\/refresh\/?$/ },
  // QuickBooks customer import — both routes page the QBO query API (a
  // multi-second, up-to-1000-per-page outbound call) inside the handler; the
  // import service manages its own short withSystemDbAccessContext blocks
  // around each DB op, so we must NOT pin a request transaction across the call.
  { method: 'GET', pattern: /^\/api\/v1\/accounting\/[^/]+\/customers\/?$/ },
  { method: 'POST', pattern: /^\/api\/v1\/accounting\/[^/]+\/customers\/import\/?$/ },
  // Task 5 (2026-08-29-quickbooks-customer-item-mapping) — entity-mapping
  // reconciliation and sync routes. GET .../mappings and GET
  // .../income-accounts call the QBO list APIs inside the handler
  // (listMappingProposals / listRemoteIncomeAccountsForPartner); PUT
  // .../mappings calls the same provider list to verify a `confirmed`
  // decision before writing (saveMappingDecision); POST .../mappings/sync
  // calls provider.upsertCustomer/upsertItem (syncMappedEntity).
  //
  // Each of those services takes a `runInDbContext` runner from the route
  // (`(fn) => withAuthDbAccessContext(auth, fn)`) and RE-ENTERS it per DB
  // phase, asserting at entry that no context is already open
  // (services/accounting/dbContextGuard.ts). Registering the route here is
  // what makes that assertion satisfiable: the auth middleware would
  // otherwise open one request transaction for the whole handler, which
  // `runOutsideDbContext` cannot close — it only re-routes the ALS lookup.
  // An earlier revision of this comment claimed these services already kept
  // short contexts; they did not, and the routes wrapped the whole call in a
  // single `withAuthDbAccessContext`.
  { method: 'GET', pattern: /^\/api\/v1\/accounting\/[^/]+\/mappings\/?$/ },
  { method: 'GET', pattern: /^\/api\/v1\/accounting\/[^/]+\/income-accounts\/?$/ },
  { method: 'PUT', pattern: /^\/api\/v1\/accounting\/[^/]+\/mappings\/?$/ },
  { method: 'POST', pattern: /^\/api\/v1\/accounting\/[^/]+\/mappings\/sync\/?$/ },
  // Phase C Task 2 (2026-09-01-quickbooks-phase-c-invoice-push) — on-demand
  // realm settings refresh. refreshRealmSettings (accountingConnectionService.ts)
  // calls provider.fetchRealmSettings, a real outbound QuickBooks HTTP call, and
  // manages its own short DB access contexts around it — the same treatment as
  // the mapping routes above.
  { method: 'POST', pattern: /^\/api\/v1\/accounting\/[^/]+\/settings\/refresh\/?$/ },
  // Phase C Task 5 (2026-09-01-quickbooks-phase-c-invoice-push) — manual
  // invoice push and remote-candidate search. `pushInvoiceToAccounting`
  // (accountingInvoicePush.ts) and `resolveConnectionAndToken` +
  // `listRemoteCustomers`/`listRemoteItems` (accountingMappingService.ts) both
  // make a real outbound QuickBooks HTTP call, and both take the route's
  // `runInDbContext` runner (see the mapping-routes comment above). For the
  // push coordinator the split is not just about the connection hold: its
  // Phase 2 sync-state writes (the mapping row's error marker / remote ref)
  // must COMMIT independently, or they roll back with the caller when the
  // push then throws — and the retry double-books the invoice in QuickBooks.
  // `push-bulk` is NOT registered here: it only enqueues to Redis
  // (`enqueueAccountingInvoicePush`) and never calls QuickBooks itself, so it
  // keeps the normal ambient request transaction.
  { method: 'POST', pattern: /^\/api\/v1\/accounting\/[^/]+\/invoices\/[^/]+\/push\/?$/ },
  { method: 'GET', pattern: /^\/api\/v1\/accounting\/[^/]+\/remote-candidates\/?$/ },
  // #2190 — the three distributor catalog import routes run a best-effort AI
  // enrichment (enrichDistributorListing, up to a 12s outbound Anthropic call)
  // before persisting. The import services manage their own short
  // withDbAccessContext blocks around each DB op (the request-scoped context
  // built by the route from `auth`), so the enrichment call runs with NO
  // ambient transaction held across it.
  { method: 'POST', pattern: /^\/api\/v1\/catalog\/distributors\/td-synnex\/import\/?$/ },
  { method: 'POST', pattern: /^\/api\/v1\/catalog\/distributors\/td-synnex-ec\/import\/?$/ },
  { method: 'POST', pattern: /^\/api\/v1\/catalog\/distributors\/pax8\/import\/?$/ },
  // The TD SYNNEX SFTP "test connection" route opens a real SSH/SFTP socket to
  // the distributor (DNS resolve + handshake + auth + directory list, up to a
  // 30s readyTimeout). testSftpConnection wraps each DB op in its own short
  // withDbAccessContext, so the socket is never held across an open transaction.
  { method: 'POST', pattern: /^\/api\/v1\/catalog\/distributors\/td-synnex-sftp\/test\/?$/ },
  // PR3 (SSO/OIDC) — the three provider routes that run OIDC discovery
  // (`discoverOIDCConfig` → `safeFetch`, up to OIDC_FETCH_TIMEOUT_MS = 10s
  // against a TENANT-CONTROLLED issuer host). Held inside the request
  // transaction, a tenant admin pointing `issuer` at a blackholed host pins a
  // pooled connection idle-in-transaction for 10s per call, on unrate-limited
  // routes, against a 25-connection prod pool — tenant-triggerable pool
  // starvation for every tenant (#1105 class). The handlers wrap each DB op in
  // its own short `withDbAccessContext(dbAccessContextFromAuth(auth), …)` block
  // (see `withAuthDbAccessContext` in middleware/auth.ts) and run discovery between
  // them, holding no connection across the network call.
  { method: 'POST', pattern: /^\/api\/v1\/sso\/providers\/?$/ },
  { method: 'PATCH', pattern: /^\/api\/v1\/sso\/providers\/[^/]+\/?$/ },
  { method: 'POST', pattern: /^\/api\/v1\/sso\/providers\/[^/]+\/test\/?$/ },
  // Pax8 order line authoring may fetch product commitment dependencies. The
  // service re-enters short partner-scoped DB contexts around each DB phase,
  // with the Pax8 HTTP request running after those contexts close.
  { method: 'POST', pattern: /^\/api\/v1\/pax8\/orders\/[^/]+\/lines\/?$/ },
  // Pax8 preflight, submit, and human reconciliation likewise split DB claims
  // and result persistence around Pax8 HTTP. Pax8 writes are never retried.
  { method: 'POST', pattern: /^\/api\/v1\/pax8\/orders\/[^/]+\/(?:preflight|submit|reconcile)\/?$/ },
  // Dynamic Pax8 order forms proxy product metadata. The route reads and
  // decrypts the active integration in one short partner context, then closes
  // it before making the outbound request.
  { method: 'GET', pattern: /^\/api\/v1\/pax8\/products\/[^/]+\/(?:provision-details|dependencies)\/?$/ },
  // M365 consent callback and retest own short DB contexts around outbound
  // Microsoft/executor HTTP and must never inherit an ambient request tx.
  { method: 'GET', pattern: /^\/api\/v1\/m365\/consent\/callback\/?$/ },
  { method: 'POST', pattern: /^\/api\/v1\/m365\/connections\/[^/]+\/retest\/?$/ },
  // Notification channel "Send test" fires a REAL synchronous outbound send
  // (email/webhook/Slack/Teams/PagerDuty/Pushover/SMS), observed holding the
  // connection ~10s (Sentry #1105 / BREEZE-A). The handler wraps the channel
  // read and the test-result write in their own short withDbAccessContext
  // blocks (see withAuthDbAccessContext in middleware/auth.ts) and runs
  // the send between them, holding no connection across the network call.
  { method: 'POST', pattern: /^\/api\/v1\/alerts\/channels\/[^/]+\/test\/?$/ },
  // #3006 orphaned-snapshot reconcile. The handler pages an ENTIRE S3 bucket
  // listing and then fetches multi-MB snapshot manifests, all against a
  // customer-supplied (therefore tenant-controlled) endpoint host — a
  // blackholed or merely slow destination would otherwise pin a pooled
  // connection idle-in-transaction for the whole call. The service takes a
  // `runInDbContext` runner and wraps each DB phase (config lookup, job
  // lookup, each adoption write) in its own short withDbAccessContext, with
  // the listing and manifest fetches between them.
  //
  // Known exception: applyBackupCommandResultToJob applies provider-enforced
  // object lock (checkBackupProviderCapabilities + applyBackupSnapshotImmutability)
  // INSIDE the adoption write context, so an org using WORM still holds a
  // connection across that S3 call. Pre-existing behaviour shared with the
  // agent result path and routes/backup/{hyperv,mssql}.ts — bounded here by
  // RECONCILE_MAX_LIMIT, and still far better than the whole-handler
  // transaction this registration replaces. Hoisting it out is a follow-up.
  { method: 'POST', pattern: /^\/api\/v1\/backup\/reconcile\/?$/ },
  // PSA connection "Test connection" — constructs a real PSA adapter and calls
  // the remote PSA API (psaFetch, 20s timeout) against a TENANT-CONTROLLED
  // baseUrl; a blackholed host would otherwise pin a pooled connection
  // idle-in-transaction for the whole call. The handler wraps the connection
  // read+decrypt and the result persist in their own short withDbAccessContext
  // blocks (see withAuthDbAccessContext in middleware/auth.ts) and runs the HTTP call
  // between them.
  { method: 'POST', pattern: /^\/api\/v1\/psa\/connections\/[^/]+\/test\/?$/ },
  // PSA company import (#3246), both halves.
  //
  // PREVIEW walks the PSA's own pagination — up to PSA_COMPANY_LIST_CAP/100
  // requests at the 20s psaFetch timeout each, against a TENANT-CONTROLLED
  // baseUrl. Holding a pooled connection idle-in-transaction across that is the
  // same #1105 pool-poison as the /test route, only an order of magnitude
  // longer, so it is rate-limited AND context-self-managed.
  //
  // COMMIT makes no outbound call, but `commitOrgImport` opens its own
  // transaction per row group inside a SYSTEM db context (the new org's id
  // cannot be in the caller's accessible_org_ids yet). Wrapping an ambient
  // request transaction around hundreds of those pins a second connection for
  // the entire import for no benefit — the seam's writes are deliberately not
  // atomic across groups, so the outer tx buys no atomicity either.
  //
  // Both handlers read the connection through short `withAuthDbAccessContext`
  // blocks and do everything else outside any context.
  { method: 'POST', pattern: /^\/api\/v1\/psa\/connections\/[^/]+\/import\/preview\/?$/ },
  { method: 'POST', pattern: /^\/api\/v1\/psa\/connections\/[^/]+\/import\/?$/ },
  // Live agent session listing — the handler issues a `list_sessions` command to
  // the agent and awaits the round-trip for up to LIST_SESSIONS_TIMEOUT_MS (10s).
  // That await is a network wait on a customer device, not a DB operation, so
  // holding a pooled connection idle-in-transaction across it is the same #1105
  // pool-poison as the routes above. A handful of concurrent dashboard tabs
  // polling this route is enough to exhaust the pool and 503 the whole API.
  // The handler reads the device row through a short `withAuthDbAccessContext`
  // block and makes the agent call outside any context.
  { method: 'GET', pattern: /^\/api\/v1\/devices\/[^/]+\/sessions\/live\/?$/ },
  // #3922 — LLM provider catalog fidelity verification. The handler runs the
  // full two-stage harness against an operator-supplied provider endpoint: a
  // direct tool_use/tool_result round-trip (60s client timeout) AND a real
  // Agent SDK subprocess session (150s timeout). Holding a pooled connection
  // idle-in-transaction for up to minutes per call is the #1105 pool-poison
  // class, and `safeFetch`'s own `assertOutsideHeldDbContext` tripwire throws
  // in CI when it is called inside a held context — which the guarded fetch in
  // the harness would do on every verification. The handler reads the revision
  // and writes the verification through the service's own short
  // `withSystemDbAccessContext` blocks, with the harness call between them.
  { method: 'POST', pattern: /^\/api\/v1\/admin\/llm-provider-catalog\/revisions\/[^/]+\/verify\/?$/ },
  // #3922 review round 2 — revision AUTHORING is the second network-touching
  // route on this surface, and the quieter one. `createRevision` runs
  // `validateBaseUrl` → `assertSafeUrl` on the operator-supplied base URL,
  // which is a real `dns.lookup` against a host the operator chose, BEFORE any
  // of its DB work. A blackholed or merely slow resolver therefore held a
  // pooled connection idle-in-transaction for the whole resolution — the
  // #1105 pool-poison class without a single byte of payload leaving the box.
  // `createRevision` wraps its reads and its insert in their own short
  // `withSystemDbAccessContext` block, run strictly AFTER the URL check, so
  // the handler needs no ambient transaction at all.
  { method: 'POST', pattern: /^\/api\/v1\/admin\/llm-provider-catalog\/[^/]+\/revisions\/?$/ },
];

/**
 * True when the given request opts out of the auth middleware's auto
 * request-transaction (it manages its own short DB access contexts so a slow
 * outbound HTTP call isn't made inside a held transaction — #1448).
 */
export function isSelfManagedDbContextRoute(method: string, path: string): boolean {
  const upper = method.toUpperCase();
  return SELF_MANAGED_DB_CONTEXT_ROUTES.some(
    (route) => route.method === upper && route.pattern.test(path)
  );
}
