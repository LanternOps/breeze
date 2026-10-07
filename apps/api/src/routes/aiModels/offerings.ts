import { Hono, type Context } from 'hono';
import { isGatewayConnectionKind, offeringDetailsPatchSchema, offeringEnableSchema } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { writeRouteAudit } from '../../services/auditEvents';
import { getConnection } from '../../services/aiModels/connections';
import { getOffering } from '../../services/aiModels/offerings';
import { CONNECTION_DISCONNECTED_MESSAGE, RegistryWriteError } from '../../services/aiModels/registryWriteErrors';
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
  partnerRateLimit,
  partnerWrite,
  platformModelIdParamSchema,
  queueConnectionSync,
  queueOfferingVerification,
  registryWrite,
  requirePartnerWide,
} from './shared';

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

// "Verify" (spec §11, Decision D4): for an Anthropic-dialect connection it re-runs
// discovery, which re-reads its capabilities and lifecycle; for a gateway
// connection (W06) it queues the fidelity-harness verification. Platform
// offerings (no connection) are verified by the operator on /admin/ai-models.
// Each verify queues upstream calls against the partner's endpoint, so it is
// bounded per partner.
const VERIFY_LIMIT_PER_WINDOW = 20;
const VERIFY_WINDOW_SECONDS = 60 * 60;

aiModelOfferingRoutes.post('/:id/verify', ...partnerWrite, partnerRateLimit('offering-verify', VERIFY_LIMIT_PER_WINDOW, VERIFY_WINDOW_SECONDS), zValidator('param', idParamSchema), async (c) => {
  const { partnerId } = requirePartnerWide(c);
  const { id: offeringId } = c.req.valid('param');
  return registryWrite(c, partnerId, async () => {
    const offering = await getOffering(offeringId);
    if (!offering || offering.partnerId !== partnerId) return c.json({ error: 'Model not found.', code: 'not_found' }, 404);
    if (!offering.connectionId) {
      return c.json({ error: 'Platform models are verified by the Breeze operator.', code: 'conflict' }, 409);
    }
    // W03 soft-disconnect: the offering outlives its connection as ledger
    // provenance. Discovery would skip it anyway; never queue it.
    const conn = await getConnection(offering.connectionId);
    if (!conn || conn.partnerId !== partnerId || conn.status === 'disconnected') {
      return c.json({ error: CONNECTION_DISCONNECTED_MESSAGE, code: 'connection_unavailable' }, 409);
    }
    if (isGatewayConnectionKind(conn.kind)) {
      // W06 (Task 12): a gateway offering is verified by the fidelity harness, the
      // only producer of its capabilities. Refuse here what the verifier would
      // refuse, so the admin gets the 4xx now instead of a silently failed job.
      if (!offering.modelId) throw new RegistryWriteError('Only models on a BYO endpoint connection are verified here.', 'not_gateway', 409);
      if (conn.status !== 'active') {
        throw new RegistryWriteError("This model's connection cannot be used right now.", 'not_eligible', 409, { reason: 'connection_unavailable' });
      }
      const failedVerify = await queueOfferingVerification(c, { offeringId: offering.id, partnerId });
      if (failedVerify) return failedVerify;
      auditOffering(c, partnerId, 'verify_requested', { offeringId: offering.id, connectionId: conn.id, mode: 'harness' });
      return c.json({ queued: true, connectionId: conn.id, offeringId: offering.id }, 202);
    }
    const failed = await queueConnectionSync(c, offering.connectionId);
    if (failed) return failed;
    auditOffering(c, partnerId, 'verify_requested', { offeringId: offering.id, connectionId: offering.connectionId });
    return c.json({ queued: true, connectionId: offering.connectionId }, 202);
  });
});
