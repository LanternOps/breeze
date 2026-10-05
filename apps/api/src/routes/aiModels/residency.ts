import { Hono } from 'hono';
import { residencyPutSchema } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { writeRouteAudit } from '../../services/auditEvents';
import { previewResidencyImpact, setResidencyRequired } from '../../services/aiModels/residency';
import { partnerRead, partnerWrite, registryWrite, requirePartnerWide } from './shared';

export const aiModelResidencyRoutes = new Hono();

aiModelResidencyRoutes.get('/preview', ...partnerRead, async (c) => {
  const { partnerId } = requirePartnerWide(c);
  return c.json(await previewResidencyImpact(partnerId));
});

aiModelResidencyRoutes.put('/', ...partnerWrite, zValidator('json', residencyPutSchema), async (c) => {
  const { partnerId } = requirePartnerWide(c);
  const body = c.req.valid('json');
  return registryWrite(c, partnerId, async () => {
    const result = await setResidencyRequired({ partnerId, ...body });
    writeRouteAudit(c, {
      orgId: null,
      action: 'ai_models.residency.updated',
      resourceType: 'partner',
      resourceId: partnerId,
      details: { required: body.required, unavailableSurfaces: result.impact.unavailableSurfaces },
    });
    return c.json(result);
  });
});
