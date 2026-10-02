/**
 * MCP tenant tools and explicitly self-managed core actions must run without
 * an ambient request transaction across outbound I/O. Both API-key and bearer
 * auth consult this key after authentication, scoping and permission checks.
 *
 * All JSON-RPC methods share a path, so mcpAuthMiddleware peeks at a cloned,
 * size-limited body before auth opens its transaction. Tenant names use the
 * slug__name shape; core actions use toolManagesDbContext, the same opt-in
 * predicate used by the chat/agent dispatcher. Malformed or unrecognized
 * requests retain the ordinary ambient context.
 *
 * Every DB phase on these paths owns a short context: tenant resolution,
 * permissions, tenant status and audit already support contextless callers;
 * executeTool wraps its own gates/capture in caller-scoped contexts for opted-in
 * core handlers. Auth, scoping, guardrails and audit otherwise remain unchanged.
 * Clearing AsyncLocalStorage inside a handler would not release an auth-owned
 * transaction, so this decision must happen before either auth wrapper opens it.
 */
export const MCP_SKIP_AMBIENT_DB_CONTEXT_KEY = 'mcpSkipAmbientDbContext';
