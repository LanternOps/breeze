import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, like, sql, asc } from 'drizzle-orm';
import { db } from '../../db';
import { softwareInventory, patches, devicePatches } from '../../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { resolvePatchConfigForDevice } from '../../services/featureConfigResolver';
import { captureException } from '../../services/sentry';
import { getPagination, getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';
import { softwareQuerySchema } from './schemas';
import { buildUpdateIndex, annotateSoftwareRow } from './softwareUpdateMatch';

export const softwareRoutes = new Hono();

softwareRoutes.use('*', authMiddleware);

// GET /devices/:id/software - Get installed software list
softwareRoutes.get(
  '/:id/software',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', softwareQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query, 1000);

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // Build conditions
    const conditions: ReturnType<typeof eq>[] = [eq(softwareInventory.deviceId, deviceId)];

    if (query.search) {
      conditions.push(like(softwareInventory.name, `%${query.search}%`));
    }

    const whereCondition = and(...conditions);

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(softwareInventory)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // The core software list is the load-bearing data and is fetched on its
    // own so it can never be taken down by the optional update annotation.
    const software = await db
      .select()
      .from(softwareInventory)
      .where(whereCondition)
      .orderBy(asc(softwareInventory.name))
      .limit(limit)
      .offset(offset);

    // Best-effort: annotate each row with the available third-party updates the
    // agent already reports through the patch pipeline, plus whether the device's
    // patch policy manages third-party updates. This is additive UI sugar (an
    // Update-button gate + a nudge banner), so a failure in the patch/policy
    // subsystem degrades to an unannotated list rather than 500-ing a request
    // whose primary job is "show me what's installed". Mirrors the graceful
    // degradation pattern used for remote-access policy resolution in core.ts.
    let data: Array<Record<string, unknown>> = software;
    let thirdPartyUpdatesManaged = false;
    try {
      const [updateRows, patchPolicy] = await Promise.all([
        db
          .select({
            title: patches.title,
            packageId: patches.packageId,
            version: patches.version,
            source: patches.source,
          })
          .from(devicePatches)
          .innerJoin(patches, eq(devicePatches.patchId, patches.id))
          .where(
            and(
              eq(devicePatches.deviceId, deviceId),
              eq(devicePatches.status, 'pending'),
              eq(patches.source, 'third_party')
            )
          ),
        resolvePatchConfigForDevice(deviceId),
      ]);

      const updateIndex = buildUpdateIndex(updateRows);
      data = software.map((row) => ({
        ...row,
        ...annotateSoftwareRow(row, updateIndex),
      }));

      // A patch policy whose `sources` includes 'third_party' means these updates
      // are managed (eligible for policy-driven jobs/auto-approve). This only
      // drives the nudge banner; the per-row manual Update button is gated on
      // actual update availability, not on policy-managed state.
      thirdPartyUpdatesManaged = !!patchPolicy?.sources?.includes('third_party');
    } catch (err) {
      captureException(err, c);
      console.error(
        `[Software] update annotation failed for device ${deviceId}; serving unannotated list:`,
        err
      );
    }

    return c.json({
      data,
      thirdPartyUpdatesManaged,
      pagination: { page, limit, total }
    });
  }
);
