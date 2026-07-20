/**
 * Deterministic, key-sorted JSON so the signer and the frozen verifier agree
 * byte-for-byte.
 *
 * This is a verbatim transcription of
 * `apps/api/src/extensions/bundleVerifier.ts:217-229`. Do not "improve" it —
 * any divergence here silently produces bundles the verifier cannot accept.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
  );
  return `{${entries.join(',')}}`;
}
