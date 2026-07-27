/**
 * Parse an environment variable as an integer, falling back when it is
 * absent, EMPTY, or unparseable.
 *
 * The empty-string case is the whole reason this exists as a shared helper
 * (#2776). Our compose files thread every variable in explicitly as
 * `VAR: ${VAR:-}`, and `docker compose config` renders an unset one as
 * `VAR: ""` — the container sees the variable SET to an empty string, not
 * absent. So the obvious-looking reader
 *
 * ```ts
 * const ttl = Number(process.env.SOME_TTL_MINUTES ?? 1440); // WRONG
 * ```
 *
 * silently yields `0`: `??` does not fire on `''`, and `Number('') === 0`.
 * For a TTL that means every token is born already expired. Use this instead
 * of hand-rolling `Number(process.env.X ?? default)`.
 */
/**
 * Plain decimal integers only (a trailing fraction is tolerated and truncated).
 * `parseInt` alone takes any valid PREFIX, which re-admits the same class of
 * silent wrong-small-number this helper exists to prevent: `parseInt('5e3')`
 * is `5`, not `5000`, and `parseInt('0x10', 10)` is `0`. Reject those outright
 * and fall back to the default rather than acting on a misread value (#2823).
 */
const DECIMAL_INT = /^[+-]?\d+(?:\.\d+)?$/;

export function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const trimmed = raw.trim();
  if (!DECIMAL_INT.test(trimmed)) return defaultValue;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}
