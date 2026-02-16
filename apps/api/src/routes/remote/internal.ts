import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { fileTransfers } from '../../db/schema';
import { requireScope } from '../../middleware/auth';
import { getTransferWithOrgCheck } from './helpers';

export const internalRoutes = new Hono();

// PATCH /remote/transfers/:id/progress - Update transfer progress (called by agent)
internalRoutes.patch(
  '/transfers/:id/progress',
  requireScope('system'),
  async (c) => {
    const auth = c.get('auth');
    const transferId = c.req.param('id');
    const body = await c.req.json<{
      progressPercent?: number;
      status?: 'transferring' | 'completed' | 'failed';
      errorMessage?: string;
    }>();

    const result = await getTransferWithOrgCheck(transferId, auth);
    if (!result) {
      return c.json({ error: 'Transfer not found' }, 404);
    }

    const { transfer } = result;

    // Only allow updates for pending or transferring transfers
    if (!['pending', 'transferring'].includes(transfer.status)) {
      return c.json({
        error: 'Cannot update transfer in current state',
        status: transfer.status
      }, 400);
    }

    const updates: Record<string, unknown> = {};

    if (body.progressPercent !== undefined) {
      updates.progressPercent = Math.min(100, Math.max(0, body.progressPercent));
    }

    if (body.status) {
      updates.status = body.status;
      if (body.status === 'completed' || body.status === 'failed') {
        updates.completedAt = new Date();
      }
    }

    if (body.errorMessage) {
      updates.errorMessage = body.errorMessage;
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const [updated] = await db
      .update(fileTransfers)
      .set(updates)
      .where(eq(fileTransfers.id, transferId))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to update transfer' }, 500);
    }

    return c.json({
      id: updated.id,
      status: updated.status,
      progressPercent: updated.progressPercent,
      completedAt: updated.completedAt
    });
  }
);
