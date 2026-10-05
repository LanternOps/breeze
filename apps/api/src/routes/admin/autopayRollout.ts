import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { partners } from '../../db/schema';
import { zValidator } from '../../lib/validation';
import { requireMfa } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';

export const adminAutopayRolloutRoutes = new Hono();
adminAutopayRolloutRoutes.patch('/partners/:partnerId/autopay', requireMfa(),
  zValidator('param', z.object({ partnerId: z.string().guid() })),
  zValidator('json', z.object({ autopayEnabled: z.boolean() }).strict()),
  async c => {
    const { partnerId } = c.req.valid('param');
    const { autopayEnabled } = c.req.valid('json');
    const [updated] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      db.update(partners).set({ autopayEnabled }).where(eq(partners.id, partnerId))
        .returning({ id: partners.id, autopayEnabled: partners.autopayEnabled })));
    if (!updated) return c.json({ error: 'Partner not found' }, 404);
    writeRouteAudit(c as never, { orgId: null, action: 'partner.autopay_rollout.update',
      resourceType: 'partner', resourceId: partnerId, details: { autopayEnabled } });
    return c.json({ data: updated });
  });
