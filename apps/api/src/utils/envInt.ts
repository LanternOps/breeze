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
export function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}
