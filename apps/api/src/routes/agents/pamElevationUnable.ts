import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

import { withDbAccessContext } from '../../db';
import { zValidator } from '../../lib/validation';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import type { AgentAuthContext } from '../../middleware/agentAuth';
import { writeAuditEvent } from '../../services/auditEvents';
import { publishEvent } from '../../services/eventBus';
import { expireSupersededMobileApprovals } from '../../services/pamMobileApprovals';
import {
  PAM_DEVICE_UNABLE_DETAIL_MAX,
  PAM_DEVICE_UNABLE_REASONS,
  recordElevationDeviceUnable,
} from '../../services/pamDeviceUnable';
import { rateLimiter } from '../../services/rate-limit';
import { getRedis } from '../../services/redis';

// #9517: the agent reports an elevation request it cannot act on (no SYSTEM
// helper could be found or started in the requester's session). See
// services/pamDeviceUnable.ts for what recording it does.

const PAM_ELEVATION_UNABLE_MAX_BODY_BYTES = 8 * 1024;

// One report per request, and the agent only reports a request it just
// created, so this is far above legitimate use; it bounds a misbehaving agent.
const PAM_ELEVATION_UNABLE_RATE_LIMIT = 120;
const PAM_ELEVATION_UNABLE_RATE_WINDOW_SECONDS = 60;

export const pamElevationUnableSchema = z.object({
  elevationRequestId: z.string().uuid(),
  reason: z.enum(PAM_DEVICE_UNABLE_REASONS),
  // Sanitized and capped again by the service; the schema bound only rejects
  // an absurd body before it is parsed further.
  detail: z.string().max(PAM_DEVICE_UNABLE_DETAIL_MAX * 4).optional(),
}).strict();

export const pamElevationUnableRoutes = new Hono();

// Reporting is the main agent's job; reject watchdog tokens.
pamElevationUnableRoutes.use('*', requireAgentRole);
pamElevationUnableRoutes.post(
  '/:id/pam/elevation-unable',
  // Enforced on the bytes actually read, so a chunked body without a
  // Content-Length cannot get past it.
  bodyLimit({
    maxSize: PAM_ELEVATION_UNABLE_MAX_BODY_BYTES,
    onError: (c) => c.json({ error: 'Body too large' }, 413),
  }),
  zValidator('json', pamElevationUnableSchema),
  async (c) => {
    const agent = c.get('agent') as AgentAuthContext | undefined;
    if (!agent?.deviceId || !agent.orgId || !agent.agentId) {
      return c.json({ error: 'Agent context not found' }, 401);
    }
    // Same guards as pamReconciliation.ts: the path names the authenticated
    // agent, and a drain-restricted credential cannot change PAM state.
    if (agent.agentId !== c.req.param('id')) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (agent.claimTypeAllowlist) {
      return c.json({ error: 'drain_restricted' }, 403);
    }

    const rate = await rateLimiter(
      getRedis(),
      `pam:elevation-unable:rate:device:${agent.deviceId}`,
      PAM_ELEVATION_UNABLE_RATE_LIMIT,
      PAM_ELEVATION_UNABLE_RATE_WINDOW_SECONDS,
    );
    if (!rate.allowed) {
      return c.json({ error: 'Rate limit exceeded', resetAt: rate.resetAt.toISOString() }, 429);
    }

    const body = c.req.valid('json');

    // `pam/elevation-unable` is in SELF_MANAGED_DB_CONTEXT_TWO_SEGMENT_ACTIONS
    // (middleware/agentAuth.ts), so no request-long transaction is open: the
    // Redis round-trip above held no pooled connection, and this handler opens
    // its own org-scoped context — the same one pamReconciliation.ts uses.
    // When the callback returns, that transaction has committed.
    const result = await withDbAccessContext(
      {
        scope: 'organization' as const,
        orgId: agent.orgId,
        accessibleOrgIds: [agent.orgId],
        accessiblePartnerIds: [],
        currentPartnerId: agent.partnerId ?? null,
      },
      () => recordElevationDeviceUnable({
        deviceId: agent.deviceId,
        elevationRequestId: body.elevationRequestId,
        reason: body.reason,
        detail: body.detail,
      }),
    );

    if (result.kind === 'not_found') {
      return c.json({ error: 'Elevation request not found' }, 404);
    }

    if (result.kind === 'recorded') {
      writeAuditEvent(c, {
        orgId: result.orgId,
        actorType: 'agent',
        actorId: agent.agentId,
        action: 'agent.elevation_request.device_unable',
        resourceType: 'elevation_request',
        resourceId: result.id,
        details: {
          flow_type: result.flowType,
          reason: body.reason,
          prior_status: result.priorStatus,
          closed: result.closed,
        },
      });
    }

    // Withdraw the request's phone approvals (only uac_intercept fans out).
    // Outside the committed context and in system scope: approval_requests is
    // Shape-6, and #7526 orders elevation first, then approval rows. This runs
    // on a repeated report too, so a failure here heals on the agent's retry:
    // a 503 is retryable for the agent, and the retry lands in
    // 'already_reported'. expireSupersededMobileApprovals only touches rows
    // whose elevation is no longer pending, so it is a no-op for a request the
    // report did not close. Even if it never runs, a phone cannot approve a
    // closed request: decideApprovalRequest locks the elevation, sees it is
    // not pending, and expires that approval row instead.
    if (result.flowType === 'uac_intercept' && result.status !== 'pending') {
      try {
        await expireSupersededMobileApprovals(result.id);
      } catch (err) {
        console.error(`[PamElevationUnable] mobile approval expiry failed for ${result.id}:`, err);
        return c.json({ error: 'Mobile approval withdrawal failed; retry' }, 503);
      }
    }

    if (result.kind === 'already_reported') {
      return c.json({ status: 'already_reported', elevationStatus: result.status }, 200);
    }

    if (result.closed) {
      // Committed: announce the close. Same event the stale-request expirer
      // publishes, with its own cause. Best-effort; the row is the record.
      try {
        await publishEvent('elevation.expired', result.orgId, {
          elevationRequestId: result.id,
          deviceId: result.deviceId,
          flowType: result.flowType,
          status: 'expired',
          cause: 'device_unable',
          reason: body.reason,
        }, 'pam-device-unable');
      } catch (err) {
        console.error(`[PamElevationUnable] event publish failed for ${result.id}:`, err);
      }
    }

    return c.json({ status: 'recorded', elevationStatus: result.status }, 200);
  },
);
