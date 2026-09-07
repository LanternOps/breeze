import { Hono } from 'hono';
import { authMiddleware, requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS } from '../../services/deviceUninstallDrain';

export const removalConfigRoutes = new Hono();
removalConfigRoutes.use('*', authMiddleware);

/**
 * GET /devices/removal-config — read-only knobs the Remove dialog needs.
 *
 * `uninstallDrainWindowHours` is how long a queued self_uninstall waits for a
 * removed device to check in before the stale-command reaper cancels it
 * (`DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS`, env-driven, floored at 1). The web
 * must not hardcode it: operators tune it per deployment.
 *
 * Static path — MUST be mounted before coreRoutes in devices/index.ts or the
 * `/:id` matcher eats it as a device id.
 */
removalConfigRoutes.get(
  '/removal-config',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  (c) => c.json({ uninstallDrainWindowHours: DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS }),
);
