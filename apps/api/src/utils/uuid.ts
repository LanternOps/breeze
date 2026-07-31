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

/**
 * Every hyphenated form Postgres itself accepts for a `uuid` column — 8-4-4-4-12
 * hex, with NO version/variant constraint.
 *
 * Use this, not `UUID_REGEX`, when the only question is "will this value cast
 * cleanly instead of raising 22P02?". `UUID_REGEX` additionally requires an
 * RFC-4122 version (1-5) and variant (8/9/a/b) nibble, so it rejects ids that
 * Postgres stores happily — e.g. `33333333-3333-3333-3333-333333333333`, or any
 * id minted by a generator that does not set those bits. Guarding a lookup with
 * the stricter pattern would turn a real device into a 404.
 */
export const PG_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
