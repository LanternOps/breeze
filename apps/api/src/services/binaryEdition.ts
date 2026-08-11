/**
 * BINARY_EDITION controls which agent-build "edition" this deployment
 * considers itself to be serving: "self-host" (the public, potentially
 * unsigned release — default, preserves today's behavior) or "hosted" (a
 * privately-distributed build that must never fall back onto public GitHub
 * release assets). See releaseAssetTrust.ts for the manifest-side edition
 * vocabulary this mirrors.
 *
 * Fail-closed by design: BINARY_EDITION=hosted changes behavior in two
 * places — config/validate.ts (production boot refusal unless
 * BINARY_SOURCE=local + a manifest trust root are both configured) and
 * binarySync.ts (local-mode GitHub fallbacks refuse instead of silently
 * pulling public self-host assets).
 */

export type BinaryEdition = 'self-host' | 'hosted';

let binaryEditionWarned = false;

export function getBinaryEdition(): BinaryEdition {
  const raw = (process.env.BINARY_EDITION || 'self-host').trim().toLowerCase();
  if (raw === 'hosted') return 'hosted';
  if (raw !== 'self-host' && !binaryEditionWarned) {
    console.warn(`[binaryEdition] Unrecognized BINARY_EDITION="${raw}", defaulting to "self-host"`);
    binaryEditionWarned = true;
  }
  return 'self-host';
}
