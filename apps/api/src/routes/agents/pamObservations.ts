import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { bodyLimitOnError } from '../../middleware/bodyLimitGate';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import type { AgentAuthContext } from '../../middleware/agentAuth';
import { db, runOutsideDbContext } from '../../db';
import { deviceCommands } from '../../db/schema';
import {
  pamAgentResultV2Schema,
  recordPamActuationResult,
  type PamActuationResultClassification,
} from '../../services/pamActuationResult';
import { consumePamReconciliationRateLimit } from '../../services/pamReconciliationRateLimit';

const PAM_OBSERVATION_MAX_BODY_BYTES = 32 * 1024;

const pamReceivedObservationRequestSchema = z.object({
  protocolVersion: z.literal(1),
  observation: pamAgentResultV2Schema.extend({ state: z.literal('received') }),
}).strict();

const pamObservationParamSchema = z.object({
  id: z.string().min(1),
  commandId: z.string().uuid(),
}).strict();

export type PamResultAcknowledgement = {
  protocolVersion: 1;
  classification: PamActuationResultClassification;
};

export const pamObservationRoutes = new Hono();

pamObservationRoutes.use('*', requireAgentRole);
pamObservationRoutes.post(
  '/:id/commands/:commandId/pam-observations',
  zValidator('param', pamObservationParamSchema),
  bodyLimit({
    maxSize: PAM_OBSERVATION_MAX_BODY_BYTES,
    onError: bodyLimitOnError(
      'agent-pam-observation',
      PAM_OBSERVATION_MAX_BODY_BYTES,
      'Request body too large',
    ),
  }),
  zValidator('json', pamReceivedObservationRequestSchema),
  async (c) => {
    const { id: agentId, commandId } = c.req.valid('param');
    const request = c.req.valid('json');
    const agent = c.get('agent') as AgentAuthContext | undefined;

    if (!agent?.agentId || !agent.deviceId || agent.agentId !== agentId) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (agent.claimTypeAllowlist) {
      return c.json({ error: 'drain_restricted' }, 403);
    }

    const rate = await consumePamReconciliationRateLimit(agent.deviceId);
    if (!rate.allowed) {
      return c.json({
        error: 'Rate limit exceeded',
        resetAt: rate.resetAt.toISOString(),
      }, 429);
    }

    const [command] = await runOutsideDbContext(() => db
      .select({ id: deviceCommands.id })
      .from(deviceCommands)
      .where(and(
        eq(deviceCommands.id, commandId),
        eq(deviceCommands.deviceId, agent.deviceId),
        eq(deviceCommands.type, 'pam_apply_v2'),
        eq(deviceCommands.targetRole, 'agent'),
      ))
      .limit(1));
    if (!command) {
      return c.json({ error: 'Command not found' }, 404);
    }

    const classification = await recordPamActuationResult({
      agentId: agent.agentId,
      deviceId: agent.deviceId,
      commandId,
      result: request.observation,
    });
    const acknowledgement: PamResultAcknowledgement = {
      protocolVersion: 1,
      classification,
    };
    return c.json(acknowledgement);
  },
);
