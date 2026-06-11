import type { Context, Next } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { mobileDevices } from '../db/schema';
import { verifyToken } from '../services/jwt';
import { MOBILE_DEVICE_ID_HEADER, readMobileDeviceId } from '../services/mobileDeviceBinding';

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

  const whereClause = scopeByUser
    ? and(eq(mobileDevices.deviceId, deviceId), eq(mobileDevices.userId, tokenUserId as string))
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

  if (!row) {
    return next();
  }

  if (row.status === 'blocked') {
    return c.json(
      {
        error: 'This device has been deactivated. Please re-pair to continue.',
        code: 'device_blocked',
        reason: row.blockedReason ?? null,
      },
      403
    );
  }

  return next();
}

// Re-exported for callers that previously imported the header constant from
// here (and the lifecycle route module).
export { MOBILE_DEVICE_ID_HEADER };
