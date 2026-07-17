/**
 * Canonical UUID (v1-v5) pattern, case-insensitive.
 *
 * Single shared definition for hot paths that must cheaply reject a non-UUID
 * identifier BEFORE touching the database (a non-UUID value in a uuid-typed
 * WHERE clause raises Postgres 22P02 through the caller). Used by the agent
 * WS handlers (routes/agentWs.ts) and the backup progress service — reuse
 * this rather than re-declaring a subtly different regex.
 */
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
