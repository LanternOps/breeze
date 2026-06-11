import type { Context } from 'hono';

/**
 * Header the mobile app sends on every request carrying its per-install id.
 *
 * SECURITY NOTE (SR-001): this header is client-controlled — it can be
 * omitted or forged. It must NEVER be the sole basis for a server-side
 * revocation/lockout decision. The authoritative device identity is the
 * signed `mdid` JWT claim (see services/jwt.ts). The header is retained only
 * as a migration fallback for tokens minted before binding existed, and for
 * pre-auth UX hints.
 */
export const MOBILE_DEVICE_ID_HEADER = 'x-breeze-mobile-device-id';

const MAX_DEVICE_ID_LEN = 255;

/** Trim + length-validate a candidate device id. Returns null when unusable. */
export function normalizeDeviceId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_DEVICE_ID_LEN) return null;
  return trimmed;
}

/** Read + normalize the per-install device id from the request header. */
export function readMobileDeviceId(c: Context): string | null {
  const raw =
    c.req.header(MOBILE_DEVICE_ID_HEADER) ??
    c.req.header(MOBILE_DEVICE_ID_HEADER.toUpperCase());
  return normalizeDeviceId(raw);
}

/**
 * The `mdid` value to carry into a re-minted token on refresh. It is ALWAYS
 * derived from the previously-signed token, never the request header — so a
 * bound mobile session cannot be silently un-bound by omitting the header on
 * a refresh call (which would otherwise re-open the SR-001 bypass).
 */
export function carryForwardBinding(previous: { mdid?: string | null }): string | undefined {
  return previous.mdid && previous.mdid.length > 0 ? previous.mdid : undefined;
}
