import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db } from '../db';
import { organizations } from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';

export const webhookRoutes = new Hono();

type WebhookStatus = 'active' | 'paused' | 'failed';
type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'retrying';

type WebhookHeaders = Array<{ key: string; value: string }>;

interface WebhookRecord {
  id: string;
  orgId: string;
  name: string;
  url: string;
  secret: string;
  events: string[];
  headers: WebhookHeaders;
  status: WebhookStatus;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  lastDeliveryAt: Date | null;
}

interface WebhookDeliveryRecord {
  id: string;
  webhookId: string;
  orgId: string;
  status: WebhookDeliveryStatus;
  event: string;
  payload: unknown;
  responseStatus: number | null;
  responseBody: string | null;
  attempt: number;
  nextAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deliveredAt: Date | null;
}

const webhookStore = new Map<string, WebhookRecord>();
const deliveryStore = new Map<string, WebhookDeliveryRecord>();

// ============================================
// Helper functions
// ============================================

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

async function ensureOrgAccess(orgId: string, auth: { scope: string; partnerId: string | null; orgId: string | null }) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          eq(organizations.id, orgId),
          eq(organizations.partnerId, auth.partnerId as string)
        )
      )
      .limit(1);

    return Boolean(org);
  }

  // system scope has access to all
  return true;
}

async function getOrgIdsForAuth(auth: { scope: string; partnerId: string | null; orgId: string | null }): Promise<string[] | null> {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return null;
    return [auth.orgId];
  }

  if (auth.scope === 'partner') {
    const partnerOrgs = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.partnerId, auth.partnerId as string));
    return partnerOrgs.map(o => o.id);
  }

  // system scope - return null to indicate no filtering needed
  return null;
}

function sanitizeWebhook(webhook: WebhookRecord) {
  const { secret, ...rest } = webhook;
  return { ...rest, hasSecret: Boolean(secret) };
}

function getDeliveryStats(webhookId: string) {
  const deliveries = Array.from(deliveryStore.values()).filter(delivery => delivery.webhookId === webhookId);
  const total = deliveries.length;
  const counts = deliveries.reduce<Record<WebhookDeliveryStatus, number>>((acc, delivery) => {
    acc[delivery.status] += 1;
    return acc;
  }, { pending: 0, delivered: 0, failed: 0, retrying: 0 });

  const lastDelivery = deliveries
    .filter(delivery => delivery.deliveredAt)
    .sort((a, b) => (b.deliveredAt?.getTime() ?? 0) - (a.deliveredAt?.getTime() ?? 0))[0];

  return {
    total,
    ...counts,
    lastDeliveredAt: lastDelivery?.deliveredAt ?? null
  };
}

function getWebhookWithOrgCheck(webhookId: string, auth: { scope: string; partnerId: string | null; orgId: string | null }) {
  const webhook = webhookStore.get(webhookId);
  if (!webhook) {
    return null;
  }

  return ensureOrgAccess(webhook.orgId, auth).then(hasAccess => (hasAccess ? webhook : null));
}

function getDeliveryWithOrgCheck(deliveryId: string, auth: { scope: string; partnerId: string | null; orgId: string | null }) {
  const delivery = deliveryStore.get(deliveryId);
  if (!delivery) {
    return null;
  }

  return ensureOrgAccess(delivery.orgId, auth).then(hasAccess => (hasAccess ? delivery : null));
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
  payload: z.any().optional()
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
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    let allowedOrgIds: string[] | null = null;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      allowedOrgIds = [auth.orgId];
    } else if (auth.scope === 'partner') {
      if (query.orgId) {
        const hasAccess = await ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        allowedOrgIds = [query.orgId];
      } else {
        allowedOrgIds = await getOrgIdsForAuth(auth);
      }
    } else if (auth.scope === 'system') {
      if (query.orgId) {
        allowedOrgIds = [query.orgId];
      }
    }

    const allWebhooks = Array.from(webhookStore.values());
    let filtered = allWebhooks;

    if (allowedOrgIds) {
      filtered = filtered.filter(webhook => allowedOrgIds?.includes(webhook.orgId));
    }

    if (query.status) {
      filtered = filtered.filter(webhook => webhook.status === query.status);
    }

    const total = filtered.length;
    const data = filtered
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(offset, offset + limit)
      .map(sanitizeWebhook);

    return c.json({
      data,
      pagination: { page, limit, total }
    });
  }
);

// POST /webhooks - Create webhook
webhookRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createWebhookSchema),
  async (c) => {
    const auth = c.get('auth');
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
      const hasAccess = await ensureOrgAccess(orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
    } else if (auth.scope === 'system' && !orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    const now = new Date();
    const webhook: WebhookRecord = {
      id: randomUUID(),
      orgId: orgId!,
      name: data.name,
      url: data.url,
      secret: data.secret,
      events: data.events,
      headers: data.headers ?? [],
      status: 'active',
      createdBy: auth.user.id,
      createdAt: now,
      updatedAt: now,
      lastDeliveryAt: null
    };

    webhookStore.set(webhook.id, webhook);

    return c.json({
      ...sanitizeWebhook(webhook),
      secret: webhook.secret
    }, 201);
  }
);

// GET /webhooks/:id - Get webhook details including delivery stats
webhookRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const webhookId = c.req.param('id');

    const webhook = await getWebhookWithOrgCheck(webhookId, auth);
    if (!webhook) {
      return c.json({ error: 'Webhook not found' }, 404);
    }

    return c.json({
      ...sanitizeWebhook(webhook),
      deliveryStats: getDeliveryStats(webhook.id)
    });
  }
);

// PATCH /webhooks/:id - Update webhook
webhookRoutes.patch(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateWebhookSchema),
  async (c) => {
    const auth = c.get('auth');
    const webhookId = c.req.param('id');
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const webhook = await getWebhookWithOrgCheck(webhookId, auth);
    if (!webhook) {
      return c.json({ error: 'Webhook not found' }, 404);
    }

    const updated: WebhookRecord = {
      ...webhook,
      name: data.name ?? webhook.name,
      url: data.url ?? webhook.url,
      secret: data.secret ?? webhook.secret,
      events: data.events ?? webhook.events,
      headers: data.headers ?? webhook.headers,
      status: data.status ?? webhook.status,
      updatedAt: new Date()
    };

    webhookStore.set(webhook.id, updated);

    return c.json({
      ...sanitizeWebhook(updated),
      secret: data.secret ? updated.secret : undefined
    });
  }
);

// DELETE /webhooks/:id - Delete webhook
webhookRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const webhookId = c.req.param('id');

    const webhook = await getWebhookWithOrgCheck(webhookId, auth);
    if (!webhook) {
      return c.json({ error: 'Webhook not found' }, 404);
    }

    webhookStore.delete(webhookId);
    Array.from(deliveryStore.values())
      .filter(delivery => delivery.webhookId === webhookId)
      .forEach(delivery => deliveryStore.delete(delivery.id));

    return c.json({ success: true });
  }
);

// GET /webhooks/:id/deliveries - Get delivery history (paginated, filtered by status)
webhookRoutes.get(
  '/:id/deliveries',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listDeliveriesSchema),
  async (c) => {
    const auth = c.get('auth');
    const webhookId = c.req.param('id');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const webhook = await getWebhookWithOrgCheck(webhookId, auth);
    if (!webhook) {
      return c.json({ error: 'Webhook not found' }, 404);
    }

    let deliveries = Array.from(deliveryStore.values()).filter(delivery => delivery.webhookId === webhook.id);

    if (query.status) {
      deliveries = deliveries.filter(delivery => delivery.status === query.status);
    }

    const total = deliveries.length;
    const data = deliveries
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(offset, offset + limit);

    return c.json({
      data,
      pagination: { page, limit, total }
    });
  }
);

// POST /webhooks/:id/test - Send test payload to webhook
webhookRoutes.post(
  '/:id/test',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', testWebhookSchema),
  async (c) => {
    const auth = c.get('auth');
    const webhookId = c.req.param('id');
    const data = c.req.valid('json');

    const webhook = await getWebhookWithOrgCheck(webhookId, auth);
    if (!webhook) {
      return c.json({ error: 'Webhook not found' }, 404);
    }

    const event = data.event ?? 'webhook.test';
    const payload = data.payload ?? {
      message: 'Test webhook from Breeze RMM',
      timestamp: new Date().toISOString(),
      webhookId: webhook.id
    };

    const now = new Date();
    const delivery: WebhookDeliveryRecord = {
      id: randomUUID(),
      webhookId: webhook.id,
      orgId: webhook.orgId,
      status: 'delivered',
      event,
      payload,
      responseStatus: 200,
      responseBody: 'Simulated delivery (no outbound request sent)',
      attempt: 1,
      nextAttemptAt: null,
      createdAt: now,
      updatedAt: now,
      deliveredAt: now
    };

    deliveryStore.set(delivery.id, delivery);
    webhookStore.set(webhook.id, { ...webhook, lastDeliveryAt: now, updatedAt: now });

    return c.json({
      message: 'Test delivery recorded (simulated)',
      delivery
    }, 202);
  }
);

// POST /webhooks/:id/retry/:deliveryId - Retry a failed delivery
webhookRoutes.post(
  '/:id/retry/:deliveryId',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const webhookId = c.req.param('id');
    const deliveryId = c.req.param('deliveryId');

    const webhook = await getWebhookWithOrgCheck(webhookId, auth);
    if (!webhook) {
      return c.json({ error: 'Webhook not found' }, 404);
    }

    const delivery = await getDeliveryWithOrgCheck(deliveryId, auth);
    if (!delivery || delivery.webhookId !== webhook.id) {
      return c.json({ error: 'Delivery not found' }, 404);
    }

    if (delivery.status !== 'failed') {
      return c.json({ error: 'Only failed deliveries can be retried' }, 400);
    }

    const updated: WebhookDeliveryRecord = {
      ...delivery,
      status: 'retrying',
      attempt: delivery.attempt + 1,
      nextAttemptAt: new Date(),
      updatedAt: new Date()
    };

    deliveryStore.set(delivery.id, updated);

    return c.json({
      message: 'Delivery retry queued (simulated)',
      delivery: updated
    }, 202);
  }
);
