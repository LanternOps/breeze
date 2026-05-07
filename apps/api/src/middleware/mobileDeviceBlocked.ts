import type { Context, Next } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { mobileDevices } from '../db/schema';
import { MOBILE_DEVICE_ID_HEADER } from '../routes/lifecycle';

/**
 * Reject API calls from a blocked mobile device with a structured
 * `device_blocked` error. The mobile app renders this as a full-screen
 * lockout state instructing the user to re-pair.
 *
 * Behaviour:
 *   - No `X-Breeze-Mobile-Device-Id` header → noop (web dashboard, MCP).
 *   - Header present but no matching row → noop (first call before
 *     /devices register lands).
 *   - Header present + row's status='blocked' → 403 with code.
 *
 * The lookup runs under system DB context: this middleware fires before
 * the per-request RLS scope is set up, and we want it to see the row
 * even if the user is otherwise locked out.
 */
export async function mobileDeviceBlockedMiddleware(c: Context, next: Next): Promise<Response | void> {
  const deviceId = c.req.header(MOBILE_DEVICE_ID_HEADER) ?? c.req.header(MOBILE_DEVICE_ID_HEADER.toUpperCase());
  if (!deviceId) {
    return next();
  }

  // We need the auth context to scope the lookup to the calling user;
  // /mobile/* paths run authMiddleware via the route file itself, but
  // this middleware fires earlier. Look up by device_id only — the
  // device_id space is global and the caller proves identity via the
  // bearer token; we don't need to gate further here.
  const trimmed = deviceId.trim();
  if (trimmed.length === 0 || trimmed.length > 255) {
    return next();
  }

  const [row] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ status: mobileDevices.status, blockedReason: mobileDevices.blockedReason })
        .from(mobileDevices)
        .where(eq(mobileDevices.deviceId, trimmed))
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

// Suppress lint about unused import when consuming `and`.
void and;
