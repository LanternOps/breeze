import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '../db';
import { networkKnownGuests } from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';

export const networkKnownGuestsRoutes = new Hono();

networkKnownGuestsRoutes.use('*', authMiddleware);

// MAC must be colon-separated hex pairs, case-insensitive
const macRegex = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/;

const createGuestSchema = z.object({
  macAddress: z.string().regex(macRegex, 'Invalid MAC address format (expected XX:XX:XX:XX:XX:XX)'),
  label: z.string().min(1).max(255),
  notes: z.string().optional()
});

// GET /partner/known-guests
networkKnownGuestsRoutes.get('/', requireScope('partner', 'system'), async (c) => {
  const auth = c.get('auth');
  if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 403);

  const guests = await db
    .select()
    .from(networkKnownGuests)
    .where(eq(networkKnownGuests.partnerId, auth.partnerId))
    .orderBy(networkKnownGuests.createdAt);

  return c.json({ data: guests });
});

// POST /partner/known-guests
networkKnownGuestsRoutes.post(
  '/',
  requireScope('partner', 'system'),
  zValidator('json', createGuestSchema),
  async (c) => {
    const auth = c.get('auth');
    if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 403);

    const body = c.req.valid('json');
    const normalizedMac = body.macAddress.toLowerCase();

    try {
      const [guest] = await db
        .insert(networkKnownGuests)
        .values({
          partnerId: auth.partnerId,
          macAddress: normalizedMac,
          label: body.label,
          notes: body.notes ?? null,
          addedBy: auth.user?.id ?? null
        })
        .returning();

      return c.json({ data: guest }, 201);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '';
      if (message.includes('unique') || message.includes('duplicate')) {
        return c.json({ error: 'This MAC address is already in your known guests list' }, 409);
      }
      throw err;
    }
  }
);

// DELETE /partner/known-guests/:id
networkKnownGuestsRoutes.delete('/:id', requireScope('partner', 'system'), async (c) => {
  const auth = c.get('auth');
  if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 403);

  const id = c.req.param('id');

  const deleted = await db
    .delete(networkKnownGuests)
    .where(and(
      eq(networkKnownGuests.id, id),
      eq(networkKnownGuests.partnerId, auth.partnerId)
    ))
    .returning({ id: networkKnownGuests.id });

  if (deleted.length === 0) return c.json({ error: 'Not found' }, 404);
  return c.json({ success: true });
});
