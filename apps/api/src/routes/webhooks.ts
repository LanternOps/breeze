import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db } from '../db';
import { webhookDeliveries, webhooks as webhooksTable } from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { validateWebhookUrlSafetyWithDns } from '../services/notificationSenders/webhookSender';
import { getWebhookWorker, type WebhookConfig as WorkerWebhookConfig } from '../workers/webhookDelivery';
import { decryptSecret, encryptSecret } from '../services/secretCrypto';

export const webhookRoutes = new Hono();

type ApiWebhookStatus = 'active' | 'paused' | 'failed';
type DbWebhookStatus = 'active' | 'disabled' | 'error';
type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'retrying';

type WebhookHeaders = Array<{ key: string; value: string }>;

type RouteAuth = {
  scope: 'organization' | 'partner' | 'system' | string;
  partnerId: string | null;
  orgId: string | null;
  accessibleOrgIds: string[] | null;
  canAccessOrg: (orgId: string) => boolean;
  user: { id: string; email?: string };
};

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

function mapApiStatusToDb(status: ApiWebhookStatus): DbWebhookStatus {
  if (status === 'paused') return 'disabled';
  if (status === 'failed') return 'error';
  return 'active';
}

function mapDbStatusToApi(status: DbWebhookStatus): ApiWebhookStatus {
  if (status === 'disabled') return 'paused';
  if (status === 'error') return 'failed';
  return 'active';
}

function normalizeHeaders(headers: unknown): WebhookHeaders {
  if (!headers) return [];

  if (Array.isArray(headers)) {
    return headers
      .filter((entry): entry is { key: string; value: string } => {
        return Boolean(entry)
          && typeof entry === 'object'
          && typeof (entry as { key?: unknown }).key === 'string'
          && typeof (entry as { value?: unknown }).value === 'string';
      })
      .map((entry) => ({
        key: entry.key,
        value: entry.value
      }));
  }

  if (typeof headers === 'object') {
    return Object.entries(headers as Record<string, unknown>)
      .filter(([key, value]) => key.length > 0 && typeof value === 'string')
      .map(([key, value]) => ({ key, value }));
  }

  return [];
}

function headersToRecord(headers: unknown): Record<string, string> {
  return normalizeHeaders(headers).reduce<Record<string, string>>((acc, header) => {
    acc[header.key] = header.value;
    return acc;
  }, {});
}

function toWorkerWebhookConfig(webhook: typeof webhooksTable.$inferSelect): WorkerWebhookConfig {
  const retryPolicy = (webhook.retryPolicy ?? undefined) as WorkerWebhookConfig['retryPolicy'];
  let secret: string | undefined;
  if (webhook.secret) {
    try {
      secret = decryptSecret(webhook.secret) ?? undefined;
    } catch (error) {
      console.error(`[webhooks] Failed to decrypt secret for webhook ${webhook.id}:`, error);
      secret = undefined;
    }
  }

  return {
    id: webhook.id,
    orgId: webhook.orgId,
    name: webhook.name,
    url: webhook.url,
    secret,
    events: webhook.events ?? [],
    headers: headersToRecord(webhook.headers),
    retryPolicy
  };
}

function sanitizeWebhook(webhook: typeof webhooksTable.$inferSelect) {
  return {
    id: webhook.id,
    orgId: webhook.orgId,
    name: webhook.name,
    url: webhook.url,
    events: webhook.events ?? [],
    headers: normalizeHeaders(webhook.headers),
    status: mapDbStatusToApi(webhook.status as DbWebhookStatus),
    createdBy: webhook.createdBy,
    createdAt: webhook.createdAt,
    updatedAt: webhook.updatedAt,
    lastDeliveryAt: webhook.lastDeliveryAt,
    hasSecret: Boolean(webhook.secret)
  };
}

function mapDelivery(
  delivery: typeof webhookDeliveries.$inferSelect,
  orgId: string
) {
  return {
    id: delivery.id,
    webhookId: delivery.webhookId,
    orgId,
    status: delivery.status as WebhookDeliveryStatus,
    event: delivery.eventType,
    eventId: delivery.eventId,
    payload: delivery.payload,
    responseStatus: delivery.responseStatus,
    responseBody: delivery.responseBody,
    attempt: delivery.attempts,
    nextAttemptAt: delivery.nextRetryAt,
    createdAt: delivery.createdAt,
    deliveredAt: delivery.deliveredAt
  };
}

async function getWebhookWithOrgCheck(webhookId: string, auth: RouteAuth) {
  const [webhook] = await db
    .select()
    .from(webhooksTable)
    .where(eq(webhooksTable.id, webhookId))
    .limit(1);

  if (!webhook) {
    return null;
  }

  if (!auth.canAccessOrg(webhook.orgId)) {
    return null;
  }

  return webhook;
}

async function getDeliveryStats(webhookId: string) {
  const [counts, lastDelivered] = await Promise.all([
    db
      .select({
        status: webhookDeliveries.status,
        count: sql<number>`count(*)::int`
      })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, webhookId))
      .groupBy(webhookDeliveries.status),
    db
      .select({ deliveredAt: webhookDeliveries.deliveredAt })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.webhookId, webhookId),
          eq(webhookDeliveries.status, 'delivered')
        )
      )
      .orderBy(desc(webhookDeliveries.deliveredAt))
      .limit(1)
  ]);

  const stats: Record<WebhookDeliveryStatus, number> = {
    pending: 0,
    delivered: 0,
    failed: 0,
    retrying: 0
  };

  for (const row of counts) {
    stats[row.status as WebhookDeliveryStatus] = Number(row.count ?? 0);
  }

  const total = stats.pending + stats.delivered + stats.failed + stats.retrying;

  return {
    total,
    ...stats,
    lastDeliveredAt: lastDelivered[0]?.deliveredAt ?? null
  };
}

// ============================================
// Validation schemas
// ============================================

const listWebhooksSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  status: z.enum(['active', 'paused', 'failed']).optional()
});

const createWebhookSchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  url: z.string().url(),
  secret: z.string().min(1).max(255),
  events: z.array(z.string().min(1)).min(1),
  headers: z.array(z.object({ key: z.string().min(1), value: z.string() })).optional().default([])
});

const updateWebhookSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  url: z.string().url().optional(),
  secret: z.string().min(1).max(255).optional(),
  events: z.array(z.string().min(1)).min(1).optional(),
  headers: z.array(z.object({ key: z.string().min(1), value: z.string() })).optional(),
  status: z.enum(['active', 'paused', 'failed']).optional()
});

const listDeliveriesSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.enum(['pending', 'delivered', 'failed', 'retrying']).optional()
});

const testWebhookSchema = z.object({
  event: z.string().min(1).optional(),
  payload: z.record(z.unknown()).optional()
});

// ============================================
// Routes
// ============================================

webhookRoutes.use('*', authMiddleware);

// GET /webhooks - List webhooks for org (paginated, filtered by status)
webhookRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listWebhooksSchema),
  async (c) => {
    const auth = c.get('auth') as RouteAuth;
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const conditions: SQL[] = [];

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      conditions.push(eq(webhooksTable.orgId, auth.orgId));
    } else if (auth.scope === 'partner') {
      if (query.orgId) {
        if (!auth.canAccessOrg(query.orgId)) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        conditions.push(eq(webhooksTable.orgId, query.orgId));
      } else {
        const orgIds = auth.accessibleOrgIds ?? [];
        if (orgIds.length === 0) {
          return c.json({
            data: [],
            pagination: { page, limit, total: 0 }
          });
        }
        conditions.push(inArray(webhooksTable.orgId, orgIds));
      }
    } else if (query.orgId) {
      conditions.push(eq(webhooksTable.orgId, query.orgId));
    }

    if (query.status) {
      conditions.push(eq(webhooksTable.status, mapApiStatusToDb(query.status)));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const [countResult, webhookRows] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(webhooksTable)
        .where(whereCondition),
      db
        .select()
        .from(webhooksTable)
        .where(whereCondition)
        .orderBy(desc(webhooksTable.createdAt))
        .limit(limit)
        .offset(offset)
    ]);

    return c.json({
      data: webhookRows.map((webhook) => sanitizeWebhook(webhook)),
      pagination: {
        page,
        limit,
        total: Number(countResult[0]?.count ?? 0)
      }
    });
  }
);

// POST /webhooks - Create webhook
webhookRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createWebhookSchema),
  async (c) => {
    const auth = c.get('auth') as RouteAuth;
    const data = c.req.valid('json');

    let orgId = data.orgId;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgId = auth.orgId;
    } else if (auth.scope === 'partner') {
      if (!orgId) {
        return c.json({ error: 'orgId is required for partner scope' }, 400);
      }
      if (!auth.canAccessOrg(orgId)) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
    } else if (!orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    const urlErrors = await validateWebhookUrlSafetyWithDns(data.url);
    if (urlErrors.length > 0) {
      return c.json({ error: 'Invalid webhook URL', details: urlErrors }, 400);
    }

    const [created] = await db
      .insert(webhooksTable)
      .values({
        orgId,
        name: data.name,
        url: data.url,
        secret: encryptSecret(data.secret),
        events: data.events,
        headers: data.headers ?? [],
        status: 'active',
        createdBy: auth.user.id,
        createdAt: new Date(),
        updatedAt: new Date()
      })
      .returning();

    if (!created) {
      return c.json({ error: 'Failed to create webhook' }, 500);
    }

    writeRouteAudit(c, {
      orgId: created.orgId,
      action: 'webhook.create',
      resourceType: 'webhook',
      resourceId: created.id,
      resourceName: created.name,
      details: {
        urlHost: URL.canParse(created.url) ? new URL(created.url).hostname : 'redacted',
        eventCount: created.events?.length ?? 0
      }
    });

    return c.json(sanitizeWebhook(created), 201);
  }
);

// GET /webhooks/:id - Get webhook details including delivery stats
webhookRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth') as RouteAuth;
    const webhookId = c.req.param('id');

    const webhook = await getWebhookWithOrgCheck(webhookId, auth);
    if (!webhook) {
      return c.json({ error: 'Webhook not found' }, 404);
    }

    const stats = await getDeliveryStats(webhook.id);

    return c.json({
      ...sanitizeWebhook(webhook),
      deliveryStats: stats
    });
  }
);

// PATCH /webhooks/:id - Update webhook
webhookRoutes.patch(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateWebhookSchema),
  async (c) => {
    const auth = c.get('auth') as RouteAuth;
    const webhookId = c.req.param('id');
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const webhook = await getWebhookWithOrgCheck(webhookId, auth);
    if (!webhook) {
      return c.json({ error: 'Webhook not found' }, 404);
    }

    if (data.url) {
      const urlErrors = await validateWebhookUrlSafetyWithDns(data.url);
      if (urlErrors.length > 0) {
        return c.json({ error: 'Invalid webhook URL', details: urlErrors }, 400);
      }
    }

    const updatePayload: Partial<typeof webhooksTable.$inferInsert> = {
      updatedAt: new Date()
    };

    if (data.name !== undefined) updatePayload.name = data.name;
    if (data.url !== undefined) updatePayload.url = data.url;
    if (data.secret !== undefined) updatePayload.secret = encryptSecret(data.secret);
    if (data.events !== undefined) updatePayload.events = data.events;
    if (data.headers !== undefined) updatePayload.headers = data.headers;
    if (data.status !== undefined) updatePayload.status = mapApiStatusToDb(data.status);

    const [updated] = await db
      .update(webhooksTable)
      .set(updatePayload)
      .where(eq(webhooksTable.id, webhookId))
      .returning();

    if (!updated) {
      return c.json({ error: 'Webhook not found' }, 404);
    }

    writeRouteAudit(c, {
      orgId: updated.orgId,
      action: 'webhook.update',
      resourceType: 'webhook',
      resourceId: updated.id,
      resourceName: updated.name,
      details: {
        changedFields: Object.keys(data)
      }
    });

    return c.json(sanitizeWebhook(updated));
  }
);

// DELETE /webhooks/:id - Delete webhook
webhookRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth') as RouteAuth;
    const webhookId = c.req.param('id');

    const webhook = await getWebhookWithOrgCheck(webhookId, auth);
    if (!webhook) {
      return c.json({ error: 'Webhook not found' }, 404);
    }

    await db
      .delete(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, webhook.id));

    await db
      .delete(webhooksTable)
      .where(eq(webhooksTable.id, webhook.id));

    writeRouteAudit(c, {
      orgId: webhook.orgId,
      action: 'webhook.delete',
      resourceType: 'webhook',
      resourceId: webhook.id,
      resourceName: webhook.name
    });

    return c.json({ success: true });
  }
);

// GET /webhooks/:id/deliveries - Get delivery history (paginated, filtered by status)
webhookRoutes.get(
  '/:id/deliveries',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listDeliveriesSchema),
  async (c) => {
    const auth = c.get('auth') as RouteAuth;
    const webhookId = c.req.param('id');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const webhook = await getWebhookWithOrgCheck(webhookId, auth);
    if (!webhook) {
      return c.json({ error: 'Webhook not found' }, 404);
    }

    const conditions: SQL[] = [eq(webhookDeliveries.webhookId, webhook.id)];
    if (query.status) {
      conditions.push(eq(webhookDeliveries.status, query.status));
    }

    const whereCondition = and(...conditions);

    const [countResult, deliveryRows] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(webhookDeliveries)
        .where(whereCondition),
      db
        .select()
        .from(webhookDeliveries)
        .where(whereCondition)
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(limit)
        .offset(offset)
    ]);

    return c.json({
      data: deliveryRows.map((delivery) => mapDelivery(delivery, webhook.orgId)),
      pagination: {
        page,
        limit,
        total: Number(countResult[0]?.count ?? 0)
      }
    });
  }
);

// POST /webhooks/:id/test - Send test payload to webhook
webhookRoutes.post(
  '/:id/test',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', testWebhookSchema),
  async (c) => {
    const auth = c.get('auth') as RouteAuth;
    const webhookId = c.req.param('id');
    const data = c.req.valid('json');

    const webhook = await getWebhookWithOrgCheck(webhookId, auth);
    if (!webhook) {
      return c.json({ error: 'Webhook not found' }, 404);
    }

    const eventType = data.event ?? 'webhook.test';
    const payload = data.payload ?? {
      message: 'Test webhook from Breeze RMM',
      timestamp: new Date().toISOString(),
      webhookId: webhook.id
    };

    const eventId = randomUUID();
    const now = new Date();

    const [delivery] = await db
      .insert(webhookDeliveries)
      .values({
        webhookId: webhook.id,
        eventType,
        eventId,
        payload,
        status: 'pending',
        attempts: 0,
        createdAt: now
      })
      .returning();

    if (!delivery) {
      return c.json({ error: 'Failed to create delivery record' }, 500);
    }

    const event = {
      id: eventId,
      type: eventType,
      orgId: webhook.orgId,
      source: 'webhook.test',
      priority: 'normal',
      payload,
      metadata: {
        timestamp: now.toISOString(),
        userId: auth.user.id
      }
    };

    try {
      await getWebhookWorker().queueDelivery(toWorkerWebhookConfig(webhook), event as any, delivery.id);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown queue error';
      const [failedDelivery] = await db
        .update(webhookDeliveries)
        .set({
          status: 'failed',
          attempts: 1,
          errorMessage,
          deliveredAt: new Date()
        })
        .where(eq(webhookDeliveries.id, delivery.id))
        .returning();

      return c.json({
        error: 'Failed to queue webhook delivery',
        delivery: mapDelivery(failedDelivery ?? delivery, webhook.orgId)
      }, 503);
    }

    writeRouteAudit(c, {
      orgId: webhook.orgId,
      action: 'webhook.test',
      resourceType: 'webhook',
      resourceId: webhook.id,
      resourceName: webhook.name,
      details: {
        deliveryId: delivery.id,
        event: eventType
      }
    });

    return c.json({
      message: 'Test delivery queued',
      delivery: mapDelivery(delivery, webhook.orgId)
    }, 202);
  }
);

// POST /webhooks/:id/retry/:deliveryId - Retry a failed delivery
webhookRoutes.post(
  '/:id/retry/:deliveryId',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth') as RouteAuth;
    const webhookId = c.req.param('id');
    const deliveryId = c.req.param('deliveryId');

    const webhook = await getWebhookWithOrgCheck(webhookId, auth);
    if (!webhook) {
      return c.json({ error: 'Webhook not found' }, 404);
    }

    const [delivery] = await db
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.id, deliveryId),
          eq(webhookDeliveries.webhookId, webhook.id)
        )
      )
      .limit(1);

    if (!delivery) {
      return c.json({ error: 'Delivery not found' }, 404);
    }

    if (delivery.status !== 'failed') {
      return c.json({ error: 'Only failed deliveries can be retried' }, 400);
    }

    const retryEventId = randomUUID();
    const now = new Date();

    const [retryDelivery] = await db
      .insert(webhookDeliveries)
      .values({
        webhookId: webhook.id,
        eventType: delivery.eventType,
        eventId: retryEventId,
        payload: delivery.payload,
        status: 'pending',
        attempts: 0,
        createdAt: now
      })
      .returning();

    if (!retryDelivery) {
      return c.json({ error: 'Failed to create retry delivery record' }, 500);
    }

    const retryEvent = {
      id: retryEventId,
      type: delivery.eventType,
      orgId: webhook.orgId,
      source: 'webhook.retry',
      priority: 'normal',
      payload: delivery.payload,
      metadata: {
        timestamp: now.toISOString(),
        userId: auth.user.id
      }
    };

    try {
      await getWebhookWorker().queueDelivery(toWorkerWebhookConfig(webhook), retryEvent as any, retryDelivery.id);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown queue error';
      const [failedRetry] = await db
        .update(webhookDeliveries)
        .set({
          status: 'failed',
          attempts: 1,
          errorMessage,
          deliveredAt: new Date()
        })
        .where(eq(webhookDeliveries.id, retryDelivery.id))
        .returning();

      return c.json({
        error: 'Failed to queue retry delivery',
        delivery: mapDelivery(failedRetry ?? retryDelivery, webhook.orgId)
      }, 503);
    }

    writeRouteAudit(c, {
      orgId: webhook.orgId,
      action: 'webhook.retry',
      resourceType: 'webhook',
      resourceId: webhook.id,
      resourceName: webhook.name,
      details: {
        sourceDeliveryId: delivery.id,
        retryDeliveryId: retryDelivery.id
      }
    });

    return c.json({
      message: 'Delivery retry queued',
      delivery: mapDelivery(retryDelivery, webhook.orgId)
    }, 202);
  }
);
