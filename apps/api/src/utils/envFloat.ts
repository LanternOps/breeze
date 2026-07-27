/**
 * Parse an environment variable as a floating-point number, falling back when
 * it is absent, EMPTY, or unparseable.
 *
 * Same empty-string trap as `envInt` (see `envInt.ts` for the full rationale):
 * compose threads unmapped variables in as `VAR: ${VAR:-}`, which the container
 * sees as `VAR=""`. `??` does not fire on `''` and `Number('') === 0`, so
 * `Number(process.env.X ?? 1.5)` silently yields `0`.
 *
 * Use this instead of `envInt` only where a fractional value is meaningful
 * (prices, ratios, multipliers) — `envInt` truncates via `parseInt`.
 */
export function envFloat(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}
