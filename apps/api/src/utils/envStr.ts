/**
 * Read an environment variable as a string, falling back when it is absent,
 * EMPTY, or whitespace-only.
 *
 * Same empty-string trap as `envInt` (see `envInt.ts` for the full rationale):
 * compose threads unmapped variables in as `VAR: ${VAR:-}`, which the container
 * sees as `VAR=""`. `??` does not fire on `''`, so `process.env.X ?? 'a,b,c'`
 * yields `''` — an empty allowlist, an empty base URL, an unrecognised mode.
 *
 * Returns the value trimmed, so callers never have to re-check for whitespace.
 */
export function envStr(name: string, defaultValue: string): string {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : defaultValue;
}
