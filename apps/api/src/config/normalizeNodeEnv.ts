// Canonicalize NODE_ENV at process start so production security gates are never
// silently downgraded by a non-canonical value. Almost every gate in the API
// does an exact `process.env.NODE_ENV === 'production'` match, so a deploy with
// `NODE_ENV=Production` (or `prod` / `PROD`) used to read as *not* production —
// quietly running prod with dev-mode gates. We rewrite the value to its
// canonical form once, before anything reads it. See issue #917 (L-6).
//
// This module MUST be imported before any module that reads NODE_ENV at import
// time (e.g. routes/metrics.ts, routes/docs.ts, routes/portal/schemas.ts) — it
// is imported in index.ts immediately after `dotenv/config`, so .env is loaded
// first and every later import observes the canonical value.

/**
 * Returns the canonical NODE_ENV for a raw value, or null if it is not a
 * recognized spelling (unknown values are left untouched so the config zod enum
 * can still fail-fast on them rather than us guessing a mode).
 */
export function canonicalNodeEnv(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (v === 'production' || v === 'prod') return 'production';
  if (v === 'development' || v === 'dev') return 'development';
  if (v === 'test') return 'test';
  return null;
}

export interface NodeEnvNormalization {
  from: string | undefined;
  to: string | undefined;
  changed: boolean;
}

/**
 * Rewrites `env.NODE_ENV` to its canonical form in place. Undefined and
 * unrecognized values are left exactly as-is (undefined preserves the
 * downstream `?? 'development'` / zod default behavior; unknown values stay so
 * config validation can reject them).
 */
export function normalizeNodeEnv(env: NodeJS.ProcessEnv = process.env): NodeEnvNormalization {
  const from = env.NODE_ENV;
  if (from === undefined) return { from, to: from, changed: false };
  const canon = canonicalNodeEnv(from);
  if (canon === null || canon === from) return { from, to: from, changed: false };
  env.NODE_ENV = canon;
  return { from, to: canon, changed: true };
}

// Side effect on import: normalize the live process environment and surface the
// resolved mode at boot so a misconfigured deploy is visible in the logs.
const result = normalizeNodeEnv();
if (result.changed) {
  console.log(`[config] NODE_ENV normalized: ${JSON.stringify(result.from)} -> ${result.to}`);
}
