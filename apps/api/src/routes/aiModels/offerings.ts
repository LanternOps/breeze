import { Hono, type Context } from 'hono';
import { offeringDetailsPatchSchema, offeringEnableSchema } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { writeRouteAudit } from '../../services/auditEvents';
import { ensurePlatformOffering, setOfferingEnabled, updateOfferingDetails } from '../../services/aiModels/offeringWrites';
import { partnerWrite, registryWrite, requirePartnerWide } from './shared';

// POST /:id/verify (enqueueConnectionSync, W03 Task 16) lands in W04 Task 8b.

export const aiModelOfferingRoutes = new Hono();

function auditOffering(c: Context, partnerId: string, action: string, details: Record<string, unknown>) {
  writeRouteAudit(c, { orgId: null, action: `ai_models.offering.${action}`, resourceType: 'partner', resourceId: partnerId, details });
}

aiModelOfferingRoutes.post('/platform/:platformModelId', ...partnerWrite, zValidator('json', offeringEnableSchema), async (c) => {
  const { partnerId } = requirePartnerWide(c);
  const platformModelId = c.req.param('platformModelId');
  const { enabled } = c.req.valid('json');
  return registryWrite(c, partnerId, async () => {
    // One statement: add + (gated) enable. Never a separate setOfferingEnabled on
    // the just-inserted row, because the loader cannot see it yet (Q13).
    const offering = await ensurePlatformOffering({ partnerId, platformModelId, enabled });
    auditOffering(c, partnerId, 'added', { offeringId: offering.id, platformModelId, enabled });
    return c.json({ id: offering.id, enabled: offering.enabled, updatedAt: offering.updatedAt.toISOString() });
  });
});

aiModelOfferingRoutes.post('/:id/enabled', ...partnerWrite, zValidator('json', offeringEnableSchema), async (c) => {
  const { partnerId } = requirePartnerWide(c);
  const { enabled, force } = c.req.valid('json');
  return registryWrite(c, partnerId, async () => {
    const { offering, inUse } = await setOfferingEnabled({ partnerId, offeringId: c.req.param('id'), enabled, force });
    auditOffering(c, partnerId, enabled ? 'enabled' : 'disabled', { offeringId: offering.id, force, affectedSurfaces: inUse });
    return c.json({ id: offering.id, enabled: offering.enabled, inUse, updatedAt: offering.updatedAt.toISOString() });
  });
});

aiModelOfferingRoutes.patch('/:id', ...partnerWrite, zValidator('json', offeringDetailsPatchSchema), async (c) => {
  const { partnerId } = requirePartnerWide(c);
  const patch = c.req.valid('json');
  return registryWrite(c, partnerId, async () => {
    const offering = await updateOfferingDetails({ partnerId, offeringId: c.req.param('id'), patch });
    const { expectedUpdatedAt: _ignored, ...changed } = patch;
    auditOffering(c, partnerId, 'updated', { offeringId: offering.id, fields: Object.keys(changed) });
    return c.json({ id: offering.id, updatedAt: offering.updatedAt.toISOString() });
  });
});
