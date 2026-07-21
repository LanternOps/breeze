import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '../db';
import { networkKnownGuests } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { canManagePartnerWidePolicies } from '../services/partnerWideAccess';
import { PERMISSIONS } from '../services/permissions';

export const networkKnownGuestsRoutes = new Hono();
const requireKnownGuestRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
const requireKnownGuestWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);

networkKnownGuestsRoutes.use('*', authMiddleware);
networkKnownGuestsRoutes.use('*', async (c, next) => {
  if (!canManagePartnerWidePolicies(c.get('auth'))) {
    return c.json({ error: 'Full partner scope is required to manage the shared known-guest list' }, 403);
  }
  return next();
});

// MAC must be colon-separated hex pairs, case-insensitive
const macRegex = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/;

const createGuestSchema = z.object({
  macAddress: z.string().regex(macRegex, 'Invalid MAC address format (expected XX:XX:XX:XX:XX:XX)'),
  label: z.string().min(1).max(255),
  notes: z.string().optional()
});

// GET /partner/known-guests
networkKnownGuestsRoutes.get('/', requireScope('partner', 'system'), requireKnownGuestRead, async (c) => {
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
  requireKnownGuestWrite,
  requireMfa(),
  zValidator('json', createGuestSchema),
  async (c) => {
    const auth = c.get('auth');
    if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 403);

    const body = c.req.valid('json');
    const normalizedMac = body.macAddress.toLowerCase();

    // ON CONFLICT DO NOTHING instead of catch-and-map: the request runs inside
    // the withDbAccessContext transaction, and postgres.js re-throws a raised
    // unique violation at commit time even after it's caught here, turning the
    // mapped 409 back into a raw 500 (see createCatalogItem in catalogService.ts).
    // Zero returned rows means this partner/MAC pair already exists.
    const [guest] = await db
      .insert(networkKnownGuests)
      .values({
        partnerId: auth.partnerId,
        macAddress: normalizedMac,
        label: body.label,
        notes: body.notes ?? null,
        addedBy: auth.user?.id ?? null
      })
      .onConflictDoNothing()
      .returning();

    if (!guest) {
      return c.json({ error: 'This MAC address is already in your known guests list' }, 409);
    }

    return c.json({ data: guest }, 201);
  }
);

// DELETE /partner/known-guests/:id
networkKnownGuestsRoutes.delete('/:id', requireScope('partner', 'system'), requireKnownGuestWrite, requireMfa(), async (c) => {
  const auth = c.get('auth');
  if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 403);

  const id = c.req.param('id')!;

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
