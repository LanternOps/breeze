import { Hono } from 'hono';
import { z } from 'zod';

import { runAfterDbContextCommit, runAfterDbContextExit, withDbAccessContext } from '../../db';
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
  async (c, next) => {
    const header = c.req.header('content-length');
    if (header) {
      const length = Number.parseInt(header, 10);
      if (Number.isFinite(length) && length > PAM_ELEVATION_UNABLE_MAX_BODY_BYTES) {
        return c.json({ error: 'Body too large' }, 413);
      }
    }
    return next();
  },
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
    return withDbAccessContext(
      {
        scope: 'organization' as const,
        orgId: agent.orgId,
        accessibleOrgIds: [agent.orgId],
        accessiblePartnerIds: [],
        currentPartnerId: agent.partnerId ?? null,
      },
      async () => {
        const result = await recordElevationDeviceUnable({
          deviceId: agent.deviceId,
          elevationRequestId: body.elevationRequestId,
          reason: body.reason,
          detail: body.detail,
        });

        if (result.kind === 'not_found') {
          return c.json({ error: 'Elevation request not found' }, 404);
        }
        if (result.kind === 'already_reported') {
          return c.json({ status: 'already_reported', elevationStatus: result.status }, 200);
        }

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

        if (result.closed) {
          // A closed request may have fanned out to approvers' phones (only
          // uac_intercept does). approval_requests is Shape-6, so the expiry
          // runs in system scope after this context exits (#7526 ordering:
          // elevation first, then approval rows). It only touches rows whose
          // elevation is no longer pending, so a rollback makes it a no-op.
          if (result.flowType === 'uac_intercept') {
            const elevationId = result.id;
            runAfterDbContextExit(`pam: expire mobile approvals for device-unable elevation ${elevationId}`, () =>
              expireSupersededMobileApprovals(elevationId),
            );
          }
          // Announce the close only once it has committed. Same event the
          // stale-request expirer publishes, with its own cause.
          const payload = {
            elevationRequestId: result.id,
            deviceId: result.deviceId,
            flowType: result.flowType,
            status: 'expired',
            cause: 'device_unable',
            reason: body.reason,
          };
          const orgId = result.orgId;
          runAfterDbContextCommit(`pam: publish device-unable expiry ${result.id}`, async () => {
            try {
              await publishEvent('elevation.expired', orgId, payload, 'pam-device-unable');
            } catch (err) {
              console.error(`[PamElevationUnable] event publish failed for ${payload.elevationRequestId}:`, err);
            }
          });
        }

        return c.json({ status: 'recorded', elevationStatus: result.status }, 200);
      },
    );
  },
);
