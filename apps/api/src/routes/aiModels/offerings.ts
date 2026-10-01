import { Hono, type Context } from 'hono';
import { offeringDetailsPatchSchema, offeringEnableSchema } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  ensurePlatformOffering,
  listOfferingDefaultUses,
  setOfferingEnabled,
  updateOfferingDetails,
} from '../../services/aiModels/offeringWrites';
import {
  APPROVALS_DECIDE_REQUIRED,
  canDecideApprovals,
  idParamSchema,
  partnerWrite,
  platformModelIdParamSchema,
  registryWrite,
  requirePartnerWide,
} from './shared';

// POST /:id/verify (enqueueConnectionSync, W03 Task 16) lands in W04 Task 8b.

export const aiModelOfferingRoutes = new Hono();

function auditOffering(c: Context, partnerId: string, action: string, details: Record<string, unknown>) {
  writeRouteAudit(c, { orgId: null, action: `ai_models.offering.${action}`, resourceType: 'partner', resourceId: partnerId, details });
}

aiModelOfferingRoutes.post('/platform/:platformModelId', ...partnerWrite, zValidator('param', platformModelIdParamSchema), zValidator('json', offeringEnableSchema), async (c) => {
  const { partnerId } = requirePartnerWide(c);
  const { platformModelId } = c.req.valid('param');
  const { enabled } = c.req.valid('json');
  return registryWrite(c, partnerId, async () => {
    // One statement: add + (gated) enable. Never a separate setOfferingEnabled on
    // the just-inserted row, because the loader cannot see it yet (Q13).
    const offering = await ensurePlatformOffering({ partnerId, platformModelId, enabled });
    auditOffering(c, partnerId, 'added', { offeringId: offering.id, platformModelId, enabled });
    return c.json({ id: offering.id, enabled: offering.enabled, updatedAt: offering.updatedAt.toISOString() });
  });
});

// Enable/disable (incl. force) needs no approvals:decide even on the script
// reviewer's default: a disabled reviewer model fails closed (no review runs).
aiModelOfferingRoutes.post('/:id/enabled', ...partnerWrite, zValidator('param', idParamSchema), zValidator('json', offeringEnableSchema), async (c) => {
  const { partnerId } = requirePartnerWide(c);
  const { enabled, force } = c.req.valid('json');
  return registryWrite(c, partnerId, async () => {
    const { offering, inUse } = await setOfferingEnabled({ partnerId, offeringId: c.req.valid('param').id, enabled, force });
    auditOffering(c, partnerId, enabled ? 'enabled' : 'disabled', { offeringId: offering.id, force, affectedSurfaces: inUse });
    return c.json({ id: offering.id, enabled: offering.enabled, inUse, updatedAt: offering.updatedAt.toISOString() });
  });
});

/** Patch keys that change what the script reviewer runs with (options, refusal fallback). */
const REVIEWER_BEHAVIOUR_KEYS = ['defaultOptions', 'allowedOptions', 'refusalFallbackOfferingId'] as const;

aiModelOfferingRoutes.patch('/:id', ...partnerWrite, zValidator('param', idParamSchema), zValidator('json', offeringDetailsPatchSchema), async (c) => {
  const { partnerId } = requirePartnerWide(c);
  const { id: offeringId } = c.req.valid('param');
  const patch = c.req.valid('json');
  return registryWrite(c, partnerId, async () => {
    // Same gate as PUT /assignments for script_reviewer: changing how the
    // reviewer's default model runs (at partner level or in any org override)
    // is a privileged widening. A rename or price change is not.
    if (REVIEWER_BEHAVIOUR_KEYS.some((k) => patch[k] !== undefined) && !canDecideApprovals(c)) {
      const uses = await listOfferingDefaultUses(partnerId, offeringId);
      if (uses.some((u) => u.surface === 'script_reviewer')) return c.json(APPROVALS_DECIDE_REQUIRED, 403);
    }
    const offering = await updateOfferingDetails({ partnerId, offeringId, patch });
    const { expectedUpdatedAt: _ignored, ...changed } = patch;
    auditOffering(c, partnerId, 'updated', { offeringId: offering.id, fields: Object.keys(changed) });
    return c.json({ id: offering.id, updatedAt: offering.updatedAt.toISOString() });
  });
});
