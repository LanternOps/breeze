import { Hono } from 'hono';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { authMiddleware, requirePartner, requireScope } from '../middleware/auth';
import { PartnerDeviceCapacityError, partnerAdmissionStatus } from '../services/partnerDeviceCapacity';

/**
 * GET /partner/device-capacity — read-only: the caller's own partner device
 * admission limit, how many devices count against it, and whether new
 * enrollment is paused (Settings → Plan & features shows the reason and links
 * to the billing app's Change plan page).
 *
 * The partner is always the caller's `auth.partnerId`; nothing in the request
 * selects it. The read runs in system scope, outside the request context, so
 * the count covers every org of the partner the way admission counts it — a
 * partner user with `selected` org access would otherwise see a partial count
 * and no pause. Only the partner's own aggregate numbers leave this handler.
 */
export const partnerDeviceCapacityRoutes = new Hono();

partnerDeviceCapacityRoutes.use('*', authMiddleware);
partnerDeviceCapacityRoutes.use('*', requireScope('partner'));
partnerDeviceCapacityRoutes.use('*', requirePartner);

partnerDeviceCapacityRoutes.get('/', async (c) => {
  const partnerId = c.get('auth').partnerId as string;
  try {
    const { limit, activeCount } = await runOutsideDbContext(() => withSystemDbAccessContext(
      () => db.transaction((tx) => partnerAdmissionStatus(tx, partnerId)),
      'partnerDeviceCapacity.status',
    ));
    return c.json({ limit, activeCount, enrollmentPaused: limit !== null && activeCount >= limit });
  } catch (err) {
    if (err instanceof PartnerDeviceCapacityError && err.code === 'PARTNER_NOT_FOUND') {
      return c.json({ error: 'partner not found' }, 404);
    }
    throw err;
  }
});
