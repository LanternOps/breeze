/**
 * The opaque version of a device's TPM key state under review (#8318 wave T2).
 *
 * Accepting or dismissing a held key change must act on exactly the baseline
 * and the held key the operator was shown: GET /devices/:id/tpm-baseline hands
 * out this HMAC, the POST recomputes it from the row read under the device
 * lock and compares in constant time, and the `device_tpm_baseline_accept`
 * step-up is bound to it. No key hash ever leaves the API.
 *
 * Same keyring and rotation behaviour as the reattach target version
 * (services/deviceReattach/targetVersion.ts), under its own domain.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getSecretDerivedKeyMaterials } from '../secretCrypto';

const DOMAIN = 'device-tpm-baseline-version';

/** 43 base64url characters, an HMAC-SHA256. */
export const TPM_BASELINE_VERSION_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface TpmBaselineUnderReview {
  deviceId: string;
  baselineSha256: string;
  mismatchSha256: string;
}

function mac(key: Buffer, state: TpmBaselineUnderReview): Buffer {
  return createHmac('sha256', key)
    .update(`${DOMAIN}\0${state.deviceId.trim().toLowerCase()}:${state.baselineSha256}:${state.mismatchSha256}`)
    .digest();
}

export function tpmBaselineVersion(state: TpmBaselineUnderReview): string {
  return mac(getSecretDerivedKeyMaterials(DOMAIN).active.key, state).toString('base64url');
}

/** Whether `supplied` is the version of this state under any retained key. Constant time per key. */
export function tpmBaselineVersionMatches(supplied: string, state: TpmBaselineUnderReview): boolean {
  if (!TPM_BASELINE_VERSION_PATTERN.test(supplied)) return false;
  const given = Buffer.from(supplied, 'base64url');
  if (given.length !== 32) return false;
  let matched = false;
  for (const { key } of getSecretDerivedKeyMaterials(DOMAIN).retained) {
    if (timingSafeEqual(given, mac(key, state))) matched = true;
  }
  return matched;
}
