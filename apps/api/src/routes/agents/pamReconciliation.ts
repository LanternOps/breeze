import { Hono } from 'hono';
import { z } from 'zod';

import { zValidator } from '../../lib/validation';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import type { AgentAuthContext } from '../../middleware/agentAuth';
import { resolvePamReconciliationBindings } from '../../services/pamReconciliationBinding';
import { consumePamReconciliationRateLimit } from '../../services/pamReconciliationRateLimit';

const PAM_RECONCILIATION_MAX_BODY_BYTES = 32 * 1024;

const pamReconciliationCandidateSchema = z.object({
  observationId: z.string().uuid(),
  actuationId: z.string().uuid(),
  generation: z.number().int().positive(),
}).strict();

export const pamReconciliationBindingRequestSchema = z.object({
  protocolVersion: z.literal(1),
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

    const request = c.req.valid('json');
    const dispositions = await resolvePamReconciliationBindings({
      agentId: agent.agentId,
      deviceId: agent.deviceId,
      orgId: agent.orgId,
      candidates: request.candidates,
    });
    return c.json({ protocolVersion: 1 as const, dispositions });
  },
);
