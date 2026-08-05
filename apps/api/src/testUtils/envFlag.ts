/**
 * Strict boolean env-flag parsing for the integration-run escape hatches
 * (#3066). Bare `process.env[X]` truthiness would treat `X=0` / `X=false` as
 * ENABLED — and for a flag whose job is bypassing a safety guard, someone
 * "explicitly disabling" it with `=0` silently getting the bypass is the
 * worst possible reading. Only `1` and `true` (case-insensitive, trimmed)
 * enable a flag.
 */
export function isEnvFlagEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}
