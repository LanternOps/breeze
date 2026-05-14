import type { Context, Next } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { mobileDevices } from '../db/schema';
import type { AuthContext } from './auth';

// Kept in sync with MOBILE_DEVICE_ID_HEADER in routes/lifecycle.ts.
// Inlined to avoid an import chain into lifecycle.ts (which pulls in
// services/configurationPolicy via services/index) just for a string.
const MOBILE_DEVICE_ID_HEADER = 'x-breeze-mobile-device-id';

/**
 * Reject API calls from a blocked mobile device with a structured
 * `device_blocked` error. The mobile app renders this as a full-screen
 * lockout state instructing the user to re-pair.
 *
 * MUST be mounted after `authMiddleware`. Without an auth context the
 * deviceId header would let an unauthenticated probe enumerate the
 * mobile_devices table and read admin block reasons; we therefore
 * scope every lookup to the authenticated user.
 *
 * Behaviour:
 *   - No `X-Breeze-Mobile-Device-Id` header → noop (web dashboard, MCP).
 *   - Header present + row exists for this user with status='blocked'
 *     → 403 with code. The 403 body never echoes `blocked_reason` —
 *     it's admin free-text and not meant for the client surface.
 *   - Header present but no matching row for this user → noop. The
 *     header from a foreign device id is treated as if absent.
 */
export async function mobileDeviceBlockedMiddleware(c: Context, next: Next): Promise<Response | void> {
  const deviceId = c.req.header(MOBILE_DEVICE_ID_HEADER) ?? c.req.header(MOBILE_DEVICE_ID_HEADER.toUpperCase());
  if (!deviceId) {
    return next();
  }

  const trimmed = deviceId.trim();
  if (trimmed.length === 0 || trimmed.length > 255) {
    return next();
  }

  const auth = c.get('auth') as AuthContext | undefined;
  if (!auth?.user?.id) {
    return next();
  }

  const [row] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ status: mobileDevices.status })
        .from(mobileDevices)
        .where(and(eq(mobileDevices.deviceId, trimmed), eq(mobileDevices.userId, auth.user.id)))
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
      },
      403
    );
  }

  return next();
}
