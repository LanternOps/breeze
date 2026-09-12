import type { Context, Next } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { mobileDevices } from '../db/schema';
import { verifyToken } from '../services/jwt';
import { MOBILE_DEVICE_ID_HEADER, readMobileDeviceId } from '../services/mobileDeviceBinding';
import { captureMessage } from '../services/sentry';
import { createReportThrottle } from '../utils/reportThrottle';

/**
 * An inert security control is indistinguishable from a working one — which is
 * exactly how #2913 stayed hidden: the id in the header could never match a
 * `mobile_devices.device_id`, so the lookup below missed on EVERY request and
 * nothing anywhere said so.
 *
 * We deliberately do NOT fail closed on a miss. A miss is legitimate during
 * onboarding (the first calls land before the phone has registered), and any
 * install that has not yet re-registered under its installation id would be
 * locked out of the app entirely. Instead we make the miss observable, rate
 * limited to one report per source per interval so a fleet of unregistered
 * phones cannot flood Sentry.
 */
const unresolvedReportThrottle = createReportThrottle(15 * 60 * 1000);

function reportUnresolvedDeviceId(source: 'signed-claim' | 'header'): void {
  if (!unresolvedReportThrottle.shouldReport(source)) {
    return;
  }
  captureMessage(
    'mobile device id resolved to no mobile_devices row — block enforcement is inert for this caller',
    {
      eventCode: 'mobile_device_unresolved',
      tags: { mobile_device_id_source: source },
    }
  );
}

export type MobileDeviceBlock = Readonly<{ reason: string | null }>;

async function lookupMobileDevice(
  deviceId: string,
  userId: string | null,
): Promise<{ status: 'active' | 'blocked'; blockedReason: string | null } | null> {
  const whereClause = userId !== null
    ? and(eq(mobileDevices.deviceId, deviceId), eq(mobileDevices.userId, userId))
    : eq(mobileDevices.deviceId, deviceId);

  const [row] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ status: mobileDevices.status, blockedReason: mobileDevices.blockedReason })
        .from(mobileDevices)
        .where(whereClause)
        .limit(1)
    )
  );
  return row ?? null;
}

/**
 * Resolve the live block state for an already-verified signed mobile binding.
 * This is the authoritative check used by ordinary bearer authentication and
 * refresh, so coverage cannot drift as new mobile-used route prefixes appear.
 */
export async function getBoundMobileDeviceBlock(
  userId: string,
  deviceId: string,
): Promise<MobileDeviceBlock | null> {
  const row = await lookupMobileDevice(deviceId, userId);
  if (!row) {
    reportUnresolvedDeviceId('signed-claim');
    return null;
  }
  return row.status === 'blocked' ? { reason: row.blockedReason } : null;
}

export function mobileDeviceBlockedResponse(c: Context, block: MobileDeviceBlock): Response {
  return c.json(
    {
      error: 'This device has been deactivated. Please re-pair to continue.',
      code: 'device_blocked',
      reason: block.reason,
    },
    403
  );
}

/** Test seam: clears the report rate limiter between cases. */
export function _resetUnresolvedDeviceReportsForTests(): void {
  unresolvedReportThrottle.reset();
}

/**
 * Reject API calls from a blocked mobile device with a structured
 * `device_blocked` error. The mobile app renders this as a full-screen
 * lockout state instructing the user to re-pair.
 *
 * SR-001: the authoritative device identity is the SIGNED `mdid` JWT claim,
 * not the `X-Breeze-Mobile-Device-Id` header. The header is spoofable and
 * omittable, so a stolen-phone bearer token could previously bypass the
 * lockout entirely by simply not sending it. We now:
 *
 *   1. Prefer the signed `mdid` claim. When present, the lookup is scoped to
 *      BOTH the bound device id and the token's user — an attacker cannot
 *      strip or alter it without re-authenticating (login/refresh re-mint).
 *   2. Fall back to the header ONLY for legacy tokens minted before binding
 *      (migration window) and for non-mobile callers that never carry the
 *      claim — preserving the original behaviour for them.
 *   3. No matching row → noop (the very first calls land before the device
 *      registers; we must not break onboarding).
 *
 * Runs under system DB context: this fires before the per-request RLS scope
 * is set up, and must see the row even when the user is otherwise locked out.
 */
export async function mobileDeviceBlockedMiddleware(c: Context, next: Next): Promise<Response | void> {
  // Derive the device identity from the signed bearer token when possible.
  let signedDeviceId: string | null = null;
  let tokenUserId: string | null = null;
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const payload = await verifyToken(authHeader.slice(7)).catch(() => null);
    if (payload && payload.type === 'access') {
      tokenUserId = payload.sub ?? null;
      if (typeof payload.mdid === 'string' && payload.mdid.length > 0) {
        signedDeviceId = payload.mdid;
      }
    }
  }

  // Bound token → trust the signed id and scope by user. Otherwise fall back
  // to the (legacy, spoofable) header with device-id-only scoping.
  const deviceId = signedDeviceId ?? readMobileDeviceId(c);
  if (!deviceId) {
    return next();
  }
  const scopeByUser = signedDeviceId !== null && tokenUserId !== null;
  const row = await lookupMobileDevice(deviceId, scopeByUser ? tokenUserId : null);

  if (!row) {
    reportUnresolvedDeviceId(scopeByUser ? 'signed-claim' : 'header');
    return next();
  }

  if (row.status === 'blocked') {
    return mobileDeviceBlockedResponse(c, { reason: row.blockedReason ?? null });
  }

  return next();
}

// Re-exported for callers that previously imported the header constant from
// here (and the lifecycle route module).
export { MOBILE_DEVICE_ID_HEADER };
