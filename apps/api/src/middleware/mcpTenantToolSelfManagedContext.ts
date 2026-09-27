/**
 * MCP `tools/call` against a tenant (BYO MCP) tool is the one branch of the
 * MCP HTTP server that makes a real outbound network call
 * (`McpClient.callTool`, against a host the tenant configured) after
 * authorization. `apiKeyAuthMiddleware`/`bearerTokenAuthMiddleware` normally
 * wrap the ENTIRE request in one ambient `withDbAccessContext` transaction —
 * fine for ordinary DB-only handlers, but on this branch it pins a pooled
 * connection idle-in-transaction across that outbound call for as long as the
 * tenant's server takes to respond (the #1105 pool-poison class, same
 * reasoning as `SELF_MANAGED_DB_CONTEXT_ROUTES`).
 *
 * That predicate is path-based and can't express this: every MCP method
 * shares one path (`/message` or `/sse`), so which branch a request takes is
 * only knowable from the parsed JSON-RPC body (`method: 'tools/call'`,
 * `params.name` shaped `slug__name` — see `isTenantToolName`). This module is
 * the shared key both MCP auth middlewares consult, set once by
 * `mcpAuthMiddleware` after a cheap, side-effect-free body peek (a `clone()`d
 * read — the real body is parsed again, unmodified, by `preflightMcpRequest`).
 *
 * Every DB read/write on the tenant-tool-call path already manages its own
 * short caller-scoped or system-scoped context (see the block comments on
 * `services/toolSources/resolver.ts`, `services/permissions.ts` #1375/#2019,
 * `services/tenantStatus.ts#readAsSystem`, and `services/auditEvents.ts`) —
 * all of them were built to tolerate running with NO ambient context, for the
 * same reason the contextless pay-link route needed it. That is what makes
 * skipping the ambient wrap here safe rather than a matching rewrite of ~220
 * core tool handlers: this key only ever affects requests whose body already
 * matches the tenant-tool-call shape.
 */
export const MCP_SKIP_AMBIENT_DB_CONTEXT_KEY = 'mcpSkipAmbientDbContext';
