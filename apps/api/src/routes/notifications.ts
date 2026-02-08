import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db } from '../db';
import { userNotifications } from '../db/schema';
import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import { authMiddleware } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';

export const notificationRoutes = new Hono();

// Apply auth middleware to all routes
notificationRoutes.use('*', authMiddleware);

const listQuerySchema = z.object({
  limit: z.string().optional().transform(v => v ? parseInt(v, 10) : 50),
  offset: z.string().optional().transform(v => v ? parseInt(v, 10) : 0),
  unreadOnly: z.string().optional().transform(v => v === 'true'),
  type: z.enum(['alert', 'device', 'script', 'automation', 'system', 'user', 'security']).optional()
});

const markReadSchema = z.object({
  ids: z.array(z.string().uuid()).optional(),
  all: z.boolean().optional(),
  read: z.boolean().optional()
});

// GET /notifications - List notifications for current user
notificationRoutes.get(
  '/',
  zValidator('query', listQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const conditions = [eq(userNotifications.userId, auth.user.id)];

    if (query.unreadOnly) {
      conditions.push(eq(userNotifications.read, false));
    }

    if (query.type) {
      conditions.push(eq(userNotifications.type, query.type));
    }

    const [notifications, countResult] = await Promise.all([
      db
        .select()
        .from(userNotifications)
        .where(and(...conditions))
        .orderBy(desc(userNotifications.createdAt))
        .limit(query.limit)
        .offset(query.offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(userNotifications)
        .where(and(...conditions))
    ]);

    const unreadCountResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(userNotifications)
      .where(and(
        eq(userNotifications.userId, auth.user.id),
        eq(userNotifications.read, false)
      ));

    return c.json({
      notifications,
      total: countResult[0]?.count ?? 0,
      unreadCount: unreadCountResult[0]?.count ?? 0,
      limit: query.limit,
      offset: query.offset
    });
  }
);

// GET /notifications/unread-count - Get unread count
notificationRoutes.get('/unread-count', async (c) => {
  const auth = c.get('auth');

  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(userNotifications)
    .where(and(
      eq(userNotifications.userId, auth.user.id),
      eq(userNotifications.read, false)
    ));

  return c.json({ count: result[0]?.count ?? 0 });
});

// PATCH /notifications/read - Mark notifications as read or unread
notificationRoutes.patch(
  '/read',
  zValidator('json', markReadSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const now = new Date();
    const read = body.read ?? true;
    const targetCurrentReadState = !read;
    const updates: { read: boolean; readAt: Date | null } = {
      read,
      readAt: read ? now : null
    };

    if (body.all) {
      await db
        .update(userNotifications)
        .set(updates)
        .where(and(
          eq(userNotifications.userId, auth.user.id),
          eq(userNotifications.read, targetCurrentReadState)
        ));
    } else if (body.ids && body.ids.length > 0) {
      await db
        .update(userNotifications)
        .set(updates)
        .where(and(
          inArray(userNotifications.id, body.ids),
          eq(userNotifications.userId, auth.user.id),
          eq(userNotifications.read, targetCurrentReadState)
        ));
    }

    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: 'notification.read.mark',
      resourceType: 'notification',
      details: {
        all: Boolean(body.all),
        read,
        count: body.ids?.length ?? null
      }
    });

    return c.json({ success: true });
  }
);

// DELETE /notifications/:id - Delete a notification
notificationRoutes.delete(
  '/:id',
  zValidator('param', z.object({ id: z.string().uuid() })),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const result = await db
      .delete(userNotifications)
      .where(and(
        eq(userNotifications.id, id),
        eq(userNotifications.userId, auth.user.id)
      ))
      .returning({ id: userNotifications.id });

    if (result.length === 0) {
      return c.json({ error: 'Notification not found' }, 404);
    }

    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: 'notification.delete',
      resourceType: 'notification',
      resourceId: id
    });

    return c.json({ success: true });
  }
);

// DELETE /notifications - Delete all notifications
notificationRoutes.delete('/', async (c) => {
  const auth = c.get('auth');

  await db
    .delete(userNotifications)
    .where(eq(userNotifications.userId, auth.user.id));

  writeRouteAudit(c, {
    orgId: auth.orgId,
    action: 'notification.delete_all',
    resourceType: 'notification'
  });

  return c.json({ success: true });
});
