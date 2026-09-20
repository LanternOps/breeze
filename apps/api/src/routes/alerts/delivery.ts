import { Hono } from 'hono';
import { z } from 'zod';
import { monitorKindSchema, monitorSeveritySchema } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { previewDelivery } from '../../services/delivery/describeDelivery';
import { DeliveryWriteError } from '../../services/delivery/routingRuleWrites';

export const deliveryPreviewQuerySchema = z.object({
  orgId: z.string().guid(), severity: monitorSeveritySchema,
  kind: monitorKindSchema.optional(), siteId: z.string().guid().optional(), monitorId: z.string().guid().optional(),
}).strict();
export const deliveryRoutes = new Hono();
deliveryRoutes.get('/delivery/resolve',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ALERTS_READ.resource, PERMISSIONS.ALERTS_READ.action),
  zValidator('query', deliveryPreviewQuerySchema),
  async c => {
    try {
      return c.json(await previewDelivery(c.req.valid('query'), c.get('auth')));
    } catch (error) {
      if (error instanceof DeliveryWriteError) return c.json({ error: error.message }, error.status);
      console.error('[DeliveryPreview] Failed to resolve delivery', error);
      return c.json({ error: 'Failed to resolve delivery' }, 500);
    }
  },
);
