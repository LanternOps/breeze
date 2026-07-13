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
  // QuickBooks customer import — both routes page the QBO query API (a
  // multi-second, up-to-1000-per-page outbound call) inside the handler; the
  // import service manages its own short withSystemDbAccessContext blocks
  // around each DB op, so we must NOT pin a request transaction across the call.
  { method: 'GET', pattern: /^\/api\/v1\/accounting\/[^/]+\/customers\/?$/ },
  { method: 'POST', pattern: /^\/api\/v1\/accounting\/[^/]+\/customers\/import\/?$/ },
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
