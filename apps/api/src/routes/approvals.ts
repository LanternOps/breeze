import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq, gt, desc } from 'drizzle-orm';

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { approvalRequests } from '../db/schema/approvals';
import { buildApprovalPush, getUserPushTokens, sendExpoPush } from '../services/expoPush';

export const approvalRoutes = new Hono();

// Apply auth middleware to all approval routes
approvalRoutes.use('*', authMiddleware);

// GET /pending — list pending, non-expired approvals for the authed user
approvalRoutes.get('/pending', async (c) => {
  const userId = c.get('auth').user.id;
  const rows = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.userId, userId),
        eq(approvalRequests.status, 'pending'),
        gt(approvalRequests.expiresAt, new Date()),
      )
    )
    .orderBy(desc(approvalRequests.createdAt));

  return c.json({ approvals: rows.map(serialize) });
});

const denySchema = z.object({
  reason: z.string().max(500).optional(),
});

const seedSchema = z.object({
  actionLabel: z.string().min(1).max(500),
  actionToolName: z.string().min(1).max(255),
  actionArguments: z.record(z.unknown()).optional(),
  riskTier: z.enum(['low', 'medium', 'high', 'critical']),
  riskSummary: z.string().min(1).max(500),
  requestingClientLabel: z.string().min(1).max(255).optional(),
  requestingMachineLabel: z.string().max(255).optional(),
  expiresInSeconds: z.number().int().min(10).max(3600).optional(),
});

// POST /dev/seed — DEV ONLY: create a fake approval for testing. 404 in prod.
approvalRoutes.post('/dev/seed', zValidator('json', seedSchema), async (c) => {
  if (process.env.NODE_ENV === 'production') {
    return c.json({ error: 'Not found' }, 404);
  }

  const userId = c.get('auth').user.id;
  const body = c.req.valid('json');
  const expiresAt = new Date(Date.now() + (body.expiresInSeconds ?? 60) * 1000);

  const [row] = await db
    .insert(approvalRequests)
    .values({
      userId,
      requestingClientLabel: body.requestingClientLabel ?? 'Dev Seed',
      requestingMachineLabel: body.requestingMachineLabel ?? null,
      actionLabel: body.actionLabel,
      actionToolName: body.actionToolName,
      actionArguments: body.actionArguments ?? {},
      riskTier: body.riskTier,
      riskSummary: body.riskSummary,
      status: 'pending',
      expiresAt,
    })
    .returning();

  // Dispatch push notification — failures are non-blocking so seed still succeeds
  // when no token is registered yet.
  try {
    const tokens = await getUserPushTokens(userId);
    if (tokens.length > 0) {
      await sendExpoPush(
        tokens.map((to) => ({
          to,
          ...buildApprovalPush({
            approvalId: row.id,
            actionLabel: row.actionLabel,
            requestingClientLabel: row.requestingClientLabel,
          }),
        }))
      );
    }
  } catch (err) {
    console.warn('[approvals] dev/seed push dispatch failed:', err);
  }

  return c.json({ approval: serialize(row) }, 201);
});

// GET /:id — fetch one approval (full detail)
approvalRoutes.get('/:id', async (c) => {
  const userId = c.get('auth').user.id;
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.id, id), eq(approvalRequests.userId, userId)));

  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ approval: serialize(row) });
});

// POST /:id/approve — approve the request (checks pending + not expired)
approvalRoutes.post('/:id/approve', async (c) => {
  return decideHandler(c, 'approved');
});

// POST /:id/deny — deny the request with optional reason
approvalRoutes.post('/:id/deny', zValidator('json', denySchema), async (c) => {
  const reason = c.req.valid('json').reason;
  return decideHandler(c, 'denied', reason);
});

async function decideHandler(
  c: import('hono').Context,
  status: 'approved' | 'denied',
  reason?: string
) {
  const userId = c.get('auth').user.id;
  const id = c.req.param('id');

  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.id, id), eq(approvalRequests.userId, userId)));

  if (!row) return c.json({ error: 'Not found' }, 404);
  if (row.status !== 'pending') return c.json({ error: `Already ${row.status}` }, 409);
  if (row.expiresAt.getTime() <= Date.now()) return c.json({ error: 'Expired' }, 410);

  const [updated] = await db
    .update(approvalRequests)
    .set({ status, decidedAt: new Date(), decisionReason: reason ?? null })
    .where(and(eq(approvalRequests.id, id), eq(approvalRequests.userId, userId)))
    .returning();

  return c.json({ approval: serialize(updated) });
}

function serialize(r: typeof approvalRequests.$inferSelect) {
  return {
    id: r.id,
    requestingClientLabel: r.requestingClientLabel,
    requestingMachineLabel: r.requestingMachineLabel ?? null,
    actionLabel: r.actionLabel,
    actionToolName: r.actionToolName,
    actionArguments: r.actionArguments,
    riskTier: r.riskTier,
    riskSummary: r.riskSummary,
    status: r.status,
    expiresAt: r.expiresAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionReason: r.decisionReason ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}
