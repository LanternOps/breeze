import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { assetCheckouts, devices } from '../../db/schema';
import {
  listSchema,
  assetParamSchema,
  checkoutSchema,
  checkinSchema,
} from './schemas';
import {
  getPagination,
  validatePortalCookieCsrfRequest,
  writePortalAudit,
} from './helpers';

export const assetRoutes = new Hono();

assetRoutes.get('/assets', zValidator('query', listSchema), async (c) => {
  const auth = c.get('portalAuth');
  const query = c.req.valid('query');
  const { page, limit, offset } = getPagination(query);

  const availableWhere = and(
    eq(devices.orgId, auth.user.orgId),
    isNull(assetCheckouts.id)
  );

  const assetCountResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(devices)
    .leftJoin(
      assetCheckouts,
      and(
        eq(assetCheckouts.deviceId, devices.id),
        eq(assetCheckouts.orgId, auth.user.orgId),
        isNull(assetCheckouts.checkedInAt)
      )
    )
    .where(availableWhere);
  const assetCount = assetCountResult[0]?.count ?? 0;

  const data = await db
    .select({
      id: devices.id,
      hostname: devices.hostname,
      displayName: devices.displayName,
      osType: devices.osType,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt
    })
    .from(devices)
    .leftJoin(
      assetCheckouts,
      and(
        eq(assetCheckouts.deviceId, devices.id),
        eq(assetCheckouts.orgId, auth.user.orgId),
        isNull(assetCheckouts.checkedInAt)
      )
    )
    .where(availableWhere)
    .orderBy(desc(devices.updatedAt))
    .limit(limit)
    .offset(offset);

  return c.json({
    data,
    pagination: { page, limit, total: Number(assetCount) }
  });
});

assetRoutes.post(
  '/assets/:id/checkout',
  zValidator('param', assetParamSchema),
  zValidator('json', checkoutSchema),
  async (c) => {
    const csrfError = validatePortalCookieCsrfRequest(c);
    if (csrfError) {
      return c.json({ error: csrfError }, 403);
    }

    const auth = c.get('portalAuth');
    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const [device] = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.id, id), eq(devices.orgId, auth.user.orgId)))
      .limit(1);

    if (!device) {
      return c.json({ error: 'Asset not found' }, 404);
    }

    const [activeCheckout] = await db
      .select({ id: assetCheckouts.id })
      .from(assetCheckouts)
      .where(
        and(
          eq(assetCheckouts.deviceId, id),
          eq(assetCheckouts.orgId, auth.user.orgId),
          isNull(assetCheckouts.checkedInAt)
        )
      )
      .limit(1);

    if (activeCheckout) {
      return c.json({ error: 'Asset is already checked out' }, 409);
    }

    const now = new Date();
    const expectedReturnAt = payload.expectedReturnAt ? new Date(payload.expectedReturnAt) : null;

    const [checkout] = await db
      .insert(assetCheckouts)
      .values({
        orgId: auth.user.orgId,
        deviceId: id,
        checkedOutTo: auth.user.id,
        checkedOutToName: auth.user.name ?? auth.user.email,
        checkedOutAt: now,
        expectedReturnAt,
        checkoutNotes: payload.checkoutNotes,
        condition: payload.condition,
        createdAt: now,
        updatedAt: now
      })
      .returning({
        id: assetCheckouts.id,
        deviceId: assetCheckouts.deviceId,
        checkedOutTo: assetCheckouts.checkedOutTo,
        checkedOutAt: assetCheckouts.checkedOutAt,
        expectedReturnAt: assetCheckouts.expectedReturnAt,
        checkoutNotes: assetCheckouts.checkoutNotes,
        condition: assetCheckouts.condition
      });
    if (!checkout) {
      return c.json({ error: 'Failed to checkout asset' }, 500);
    }

    writePortalAudit(c, {
      orgId: auth.user.orgId,
      actorType: 'user',
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'portal.asset.checkout',
      resourceType: 'asset_checkout',
      resourceId: checkout.id,
      details: {
        deviceId: checkout.deviceId,
      },
    });

    return c.json({ checkout }, 201);
  }
);

assetRoutes.post(
  '/assets/:id/checkin',
  zValidator('param', assetParamSchema),
  zValidator('json', checkinSchema),
  async (c) => {
    const csrfError = validatePortalCookieCsrfRequest(c);
    if (csrfError) {
      return c.json({ error: csrfError }, 403);
    }

    const auth = c.get('portalAuth');
    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const [activeCheckout] = await db
      .select({ id: assetCheckouts.id })
      .from(assetCheckouts)
      .where(
        and(
          eq(assetCheckouts.deviceId, id),
          eq(assetCheckouts.orgId, auth.user.orgId),
          isNull(assetCheckouts.checkedInAt)
        )
      )
      .limit(1);

    if (!activeCheckout) {
      return c.json({ error: 'Asset is not checked out' }, 400);
    }

    const now = new Date();
    const [checkout] = await db
      .update(assetCheckouts)
      .set({
        checkedInAt: now,
        checkinNotes: payload.checkinNotes,
        condition: payload.condition,
        updatedAt: now
      })
      .where(eq(assetCheckouts.id, activeCheckout.id))
      .returning({
        id: assetCheckouts.id,
        deviceId: assetCheckouts.deviceId,
        checkedInAt: assetCheckouts.checkedInAt,
        checkinNotes: assetCheckouts.checkinNotes,
        condition: assetCheckouts.condition
      });
    if (!checkout) {
      return c.json({ error: 'Failed to check in asset' }, 500);
    }

    writePortalAudit(c, {
      orgId: auth.user.orgId,
      actorType: 'user',
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'portal.asset.checkin',
      resourceType: 'asset_checkout',
      resourceId: checkout.id,
      details: {
        deviceId: checkout.deviceId,
      },
    });

    return c.json({ checkout });
  }
);
