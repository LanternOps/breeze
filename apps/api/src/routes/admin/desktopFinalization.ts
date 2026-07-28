import { Hono } from 'hono';
import { z } from 'zod';
import { runOutsideDbContext } from '../../db';
import { zValidator } from '../../lib/validation';
import { requireMfa } from '../../middleware/auth';
import {
  inspectDesktopFinalization,
  reconcileDesktopFinalizationFence,
} from '../../services/desktopSessionFinalization';

export const desktopFinalizationRoutes = new Hono();

const sessionParamSchema = z.object({
  sessionId: z.string().uuid(),
}).strict();

const reconcileSchema = z.object({
  expectedFinalizationId: z.string().uuid(),
  changeTicket: z.string()
    .trim()
    .min(3)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
}).strict();

desktopFinalizationRoutes.get(
  '/:sessionId',
  requireMfa(),
  zValidator('param', sessionParamSchema),
  async (c) => {
    const { sessionId } = c.req.valid('param');
    const inspection = await runOutsideDbContext(
      () => inspectDesktopFinalization(sessionId),
    );
    if (inspection.state !== 'persisted') return c.json(inspection);

    // Never expose connection IDs, the shared lease token, or the canonical
    // persisted payload through the operator surface.
    return c.json({
      state: inspection.state,
      finalizationId: inspection.intent.input.finalizationId,
      payloadSha256: inspection.intent.payloadSha256,
      payload: {
        version: inspection.intent.input.version,
        sessionId: inspection.intent.input.sessionId,
        orgId: inspection.intent.input.orgId,
        userId: inspection.intent.input.userId,
        deviceId: inspection.intent.input.deviceId,
        reason: inspection.intent.input.reason,
        terminalStatus: inspection.intent.input.terminalStatus,
        endedAt: inspection.intent.input.endedAt,
        startedAt: inspection.intent.input.startedAt,
        inputEvents: inspection.intent.input.inputEvents,
        frameBytes: inspection.intent.input.frameBytes,
      },
      jobState: inspection.jobState,
      sessionStatus: inspection.sessionStatus,
      stopState: inspection.stopState,
    });
  },
);

desktopFinalizationRoutes.post(
  '/:sessionId/reconcile',
  requireMfa(),
  zValidator('param', sessionParamSchema),
  zValidator('json', reconcileSchema),
  async (c) => {
    const auth = c.get('auth');
    const { sessionId } = c.req.valid('param');
    const { expectedFinalizationId, changeTicket } = c.req.valid('json');
    const result = await runOutsideDbContext(
      () => reconcileDesktopFinalizationFence({
        sessionId,
        expectedFinalizationId,
        operatorUserId: auth.user.id,
        operatorEmail: auth.user.email,
        changeTicket,
      }),
    );
    return result === 'released'
      ? c.json({ status: 'released' as const })
      : c.json({ status: 'retained' as const }, 202);
  },
);
