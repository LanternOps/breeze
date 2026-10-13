import { Hono } from 'hono';
import { z } from 'zod';

import { withDbAccessContext } from '../../db';
import { zValidator } from '../../lib/validation';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import type { AgentAuthContext } from '../../middleware/agentAuth';
import {
  resolvePamReconciliationBindings,
  type PamReconciliationBindingDisposition,
  type PamReconciliationProtocolVersion,
} from '../../services/pamReconciliationBinding';
import { consumePamReconciliationRateLimit } from '../../services/pamReconciliationRateLimit';

const PAM_RECONCILIATION_MAX_BODY_BYTES = 32 * 1024;

const pamReconciliationCandidateSchema = z.object({
  observationId: z.string().uuid(),
  actuationId: z.string().uuid(),
  generation: z.number().int().positive(),
}).strict();

// Protocol v1 and v2 share the request shape; v2 (PAM ownership epochs,
// #8202) only adds the `retired` disposition to the response. Any other
// version is a 400. Size caps and rate limits are unchanged.
export const pamReconciliationBindingRequestSchema = z.object({
  protocolVersion: z.union([z.literal(1), z.literal(2)]),
  candidates: z.array(pamReconciliationCandidateSchema).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  const observations = new Set<string>();
  const actuationGenerations = new Set<string>();
  value.candidates.forEach((candidate, index) => {
    if (observations.has(candidate.observationId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['candidates', index, 'observationId'],
        message: 'Duplicate observationId',
      });
    }
    observations.add(candidate.observationId);

    const actuationGeneration = `${candidate.actuationId}:${candidate.generation}`;
    if (actuationGenerations.has(actuationGeneration)) {
      ctx.addIssue({
        code: 'custom',
        path: ['candidates', index],
        message: 'Duplicate actuation generation',
      });
    }
    actuationGenerations.add(actuationGeneration);
  });
});

const observationIdSchema = z.string().uuid();
const boundDispositionSchema = z.object({
  status: z.literal('bound'), observationId: observationIdSchema, commandId: z.string().uuid(),
}).strict();
const v1DispositionSchema = z.union([
  boundDispositionSchema,
  z.object({
    status: z.enum(['duplicate', 'stale', 'unresolved']), observationId: observationIdSchema,
  }).strict(),
]);
const v2DispositionSchema = z.union([
  boundDispositionSchema,
  z.object({
    status: z.enum(['duplicate', 'stale', 'unresolved', 'retired']), observationId: observationIdSchema,
  }).strict(),
]);

/** Response contract per protocol version: v1 can never carry `retired`. */
export const pamReconciliationBindingResponseSchemas = {
  1: z.object({ protocolVersion: z.literal(1), dispositions: z.array(v1DispositionSchema) }).strict(),
  2: z.object({ protocolVersion: z.literal(2), dispositions: z.array(v2DispositionSchema) }).strict(),
} as const;

/**
 * Serializes resolver output for the negotiated version. The service already
 * maps `retired` to `stale` for v1; parsing against the version's schema makes
 * that a contract — a `retired` leaking into a v1 response throws instead of
 * reaching a v1 agent that cannot interpret it.
 */
export function serializePamReconciliationBindingResponse(
  protocolVersion: PamReconciliationProtocolVersion,
  dispositions: readonly PamReconciliationBindingDisposition[],
) {
  return pamReconciliationBindingResponseSchemas[protocolVersion].parse({ protocolVersion, dispositions });
}

export const pamReconciliationRoutes = new Hono();

pamReconciliationRoutes.use('*', requireAgentRole);
pamReconciliationRoutes.post(
  '/:id/pam/reconciliation-bindings',
  async (c, next) => {
    const header = c.req.header('content-length');
    if (header) {
      const length = Number.parseInt(header, 10);
      if (Number.isFinite(length) && length > PAM_RECONCILIATION_MAX_BODY_BYTES) {
        return c.json({ error: 'Body too large' }, 413);
      }
    }
    return next();
  },
  zValidator('json', pamReconciliationBindingRequestSchema),
  async (c) => {
    const agent = c.get('agent') as AgentAuthContext | undefined;
    if (!agent?.deviceId || !agent.orgId || !agent.agentId) {
      return c.json({ error: 'Agent context not found' }, 401);
    }

    const rate = await consumePamReconciliationRateLimit(agent.deviceId);
    if (!rate.allowed) {
      return c.json({
        error: 'Rate limit exceeded',
        resetAt: rate.resetAt.toISOString(),
      }, 429);
    }

    // #6260 / #1105 — everything below touches the DB, so it runs inside a
    // context this handler opens ITSELF. `pam/reconciliation-bindings` is in
    // SELF_MANAGED_DB_CONTEXT_TWO_SEGMENT_ACTIONS (middleware/agentAuth.ts),
    // so agentAuthMiddleware no longer wraps the whole request in a
    // request-long transaction — which is what let the Redis rate-limit
    // round-trip above run without pinning a pooled connection
    // idle-in-transaction. Mirrors routes/agents/elevationRequests.ts (#6130):
    // org scope, no partner-AXIS write access, device org's owning partner on
    // the read-only `currentPartnerId` axis. `resolvePamReconciliationBindings`
    // calls the definer function `breeze_pam_epoch_binding`, which admits the
    // device only if THIS ambient context has access to the device's live org
    // (#8205); without the context every candidate is `unresolved`.
    const request = c.req.valid('json');
    return withDbAccessContext(
      {
        scope: 'organization' as const,
        orgId: agent.orgId,
        accessibleOrgIds: [agent.orgId],
        accessiblePartnerIds: [],
        currentPartnerId: agent.partnerId ?? null,
      },
      async () => {
        const dispositions = await resolvePamReconciliationBindings({
          agentId: agent.agentId,
          deviceId: agent.deviceId,
          protocolVersion: request.protocolVersion,
          candidates: request.candidates,
        });
        return c.json(serializePamReconciliationBindingResponse(request.protocolVersion, dispositions));
      },
    );
  },
);
