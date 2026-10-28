import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

import { runAfterDbContextCommit, runAfterDbContextExit } from '../../db';
import { PAM_WITHDRAW_REASONS } from '../../db/schema/elevations';
import { zValidator } from '../../lib/validation';
import type { AgentAuthContext } from '../../middleware/agentAuth';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import { writeAuditEvent } from '../../services/auditEvents';
import { publishEvent } from '../../services/eventBus';
import { expireSupersededMobileApprovals } from '../../services/pamMobileApprovals';
import { withdrawElevationRequest } from '../../services/pamWithdraw';

// #8971: the end user declined a pending elevation on the device (Deny, the
// PAM dialog timed out, or it failed). See services/pamWithdraw.ts for the
// transition. The agent's durable decline record is the outbox: it retries
// this call until it gets a definitive answer (200, 404, 409, 400), so every
// one of those must mean exactly what it says.
//
// DB context: the path has three segments after :id, so it is not in
// agentAuth's SELF_MANAGED_DB_CONTEXT_* sets and runs inside the request-long
// org-scoped wrap. The handler does one short transaction and no Redis or
// network work before it; the phone-approval expiry and the event run after the
// wrap exits. No rate limiter: each call is one indexed row lock on the
// caller's own device, and the agent backs off.

const ELEVATION_WITHDRAW_MAX_BODY_BYTES = 4 * 1024;

const withdrawParamSchema = z.object({
  id: z.string().min(1),
  requestId: z.string().uuid(),
});

// Not .strict(): a 400 is final for the agent, so a newer agent that adds a
// field must not be rejected by an older server.
export const elevationWithdrawBodySchema = z.object({
  reason: z.enum(PAM_WITHDRAW_REASONS),
  declinedAt: z.string().datetime({ offset: true }).optional(),
});

export const elevationWithdrawRoutes = new Hono();

elevationWithdrawRoutes.post(
  '/:id/elevation-requests/:requestId/withdraw',
  // Withdrawing is the main agent's job; reject watchdog tokens.
  requireAgentRole,
  bodyLimit({
    maxSize: ELEVATION_WITHDRAW_MAX_BODY_BYTES,
    onError: (c) => c.json({ error: 'Body too large' }, 413),
  }),
  zValidator('param', withdrawParamSchema),
  zValidator('json', elevationWithdrawBodySchema),
  async (c) => {
    const agent = c.get('agent') as AgentAuthContext | undefined;
    if (!agent?.deviceId || !agent.orgId || !agent.agentId) {
      return c.json({ error: 'Agent context not found' }, 401);
    }
    const { id, requestId } = c.req.valid('param');
    // Same guards as pamReconciliation.ts: the path names the authenticated
    // agent, and a drain-restricted credential cannot change PAM state.
    if (agent.agentId !== id) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (agent.claimTypeAllowlist) {
      return c.json({ error: 'drain_restricted' }, 403);
    }

    const body = c.req.valid('json');
    const agentDeclinedAt = body.declinedAt ? new Date(body.declinedAt) : null;

    const result = await withdrawElevationRequest({
      orgId: agent.orgId,
      deviceId: agent.deviceId,
      requestId,
      reason: body.reason,
      agentDeclinedAt,
    });

    if (result.kind === 'not_found') {
      return c.json({ error: 'not_found' }, 404);
    }
    if (result.kind === 'not_pending') {
      // The agent acks this and never resends; its local record still refuses
      // the launch. Leave a server-side trace that the user said no to a
      // request that was already decided ("Approved · Declined on the device").
      console.warn(`[ElevationWithdraw] user declined elevation ${requestId} on device ${agent.deviceId} after it left pending (status ${result.status}, reason ${body.reason})`);
      return c.json({ error: 'not_pending', status: result.status }, 409);
    }

    // The withdraw is a savepoint inside the request transaction, so the
    // elevation stays locked until the request ends. Expire the linked phone
    // approvals after that (#7526: elevation first, then approval rows), in
    // system scope (approval_requests is Shape-6). Its guard (elevation no
    // longer pending) makes it a no-op if the request rolled back. It also runs
    // on a replay, so an expiry that failed after the first withdraw heals on
    // the agent's retry. If it never runs, a phone still cannot approve:
    // decideApprovalRequest locks the elevation and sees it is not pending.
    runAfterDbContextExit(`pam: expire mobile approvals of withdrawn elevation ${requestId}`, async () => {
      try {
        await expireSupersededMobileApprovals(requestId);
      } catch (err) {
        console.error(`[ElevationWithdraw] mobile approval expiry failed for ${requestId}:`, err);
      }
    });

    if (!result.replay) {
      writeAuditEvent(c, {
        orgId: agent.orgId,
        actorType: 'agent',
        actorId: agent.agentId,
        action: 'pam.elevation_request.withdrawn',
        resourceType: 'elevation_request',
        resourceId: requestId,
        details: {
          reason: body.reason,
          agent_declined_at: agentDeclinedAt ? agentDeclinedAt.toISOString() : null,
        },
      });

      // Announce only a committed withdraw. Best-effort; the row is the record.
      runAfterDbContextCommit(`pam: publish elevation.withdrawn ${requestId}`, async () => {
        try {
          await publishEvent('elevation.withdrawn', agent.orgId, {
            elevationRequestId: requestId,
            deviceId: agent.deviceId,
            flowType: 'uac_intercept',
            status: 'withdrawn',
            reason: body.reason,
          }, 'pam-withdraw');
        } catch (err) {
          console.error(`[ElevationWithdraw] event publish failed for ${requestId}:`, err);
        }
      });
    }

    return c.json({ id: requestId, status: 'withdrawn', withdrawnAt: result.withdrawnAt.toISOString() }, 200);
  },
);
