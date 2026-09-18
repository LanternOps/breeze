import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, gte, ne, sql } from 'drizzle-orm';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { getDeviceWithOrgCheck, canAccessDeviceSite } from './helpers';
import { db } from '../../db';
import { deviceCommands, scriptExecutions } from '../../db/schema';
import { AiOriginSourceNotFoundError, resolveAiOriginSummary } from '../../services/aiOriginSummary';
import type { DeviceAiActivityDto } from '@breeze/shared';

export const deviceAiOriginRoutes = new Hono();

deviceAiOriginRoutes.use('*', authMiddleware);

const aiOriginQuerySchema = z.object({
  source: z.enum(['execution', 'command']),
  sourceId: z.string().uuid(),
});

// GET /devices/:id/ai-origin — the authorized, per-viewer AI origin summary
// for one execution or command (#5022 W02, spec OD-9 A). See
// services/aiOriginSummary.ts for the authorization contract.
deviceAiOriginRoutes.get(
  '/:id/ai-origin',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', aiOriginQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const { source, sourceId } = c.req.valid('query');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    try {
      const summary = await resolveAiOriginSummary(auth, { kind: source, id: sourceId, deviceId });
      return c.json({ data: summary });
    } catch (err) {
      if (err instanceof AiOriginSourceNotFoundError) {
        return c.json({ error: 'Not found' }, 404);
      }
      throw err;
    }
  }
);

// #5022 W02 code review finding: a plain string + parseInt transform always
// "succeeds" the Zod parse even on garbage input (parseInt('abc') is NaN, and
// Math.min(NaN, 30) is still NaN) — that NaN then reaches
// `new Date(...).toISOString()` downstream and throws an uncaught
// `RangeError`, turning a bad query param into an opaque 500 instead of
// zValidator's normal readable 400. `z.coerce.number()` makes non-numeric
// input a genuine parse failure, which zValidator turns into a 400.
const aiActivityQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(30).default(7),
});

// GET /devices/:id/ai-activity — the de-duplicated Overview right-rail count
// of AI-DISPATCHED mutations in the trailing window (#5022 W02).
//
// De-duplication rule: an AI-run script writes BOTH a script_executions row
// AND a device_commands row of type='script' (scriptDispatch.ts calls
// queueCommand(device.id, 'script', …) after inserting the execution).
// Counting both would double-count every AI script dispatch, so the
// device_commands arm explicitly excludes type='script' — those dispatches
// are already counted via script_executions. A cancel command IS its own
// distinct AI mutation and is counted (not excluded).
deviceAiOriginRoutes.get(
  '/:id/ai-activity',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', aiActivityQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const { days } = c.req.valid('query');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [executionCountRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(scriptExecutions)
      .where(
        and(
          eq(scriptExecutions.deviceId, deviceId),
          sql`${scriptExecutions.aiInitiatorKind} IS NOT NULL`,
          gte(scriptExecutions.createdAt, since),
        ),
      );

    const [commandCountRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(deviceCommands)
      .where(
        and(
          eq(deviceCommands.deviceId, deviceId),
          sql`${deviceCommands.aiInitiatorKind} IS NOT NULL`,
          gte(deviceCommands.createdAt, since),
          // Excluded: the type='script' command a script dispatch ALSO writes
          // — it's already counted via script_executions above. See the
          // de-duplication rule in this handler's docstring.
          ne(deviceCommands.type, 'script'),
        ),
      );

    const dispatchedActions = Number(executionCountRow?.count ?? 0) + Number(commandCountRow?.count ?? 0);

    const dto: DeviceAiActivityDto = {
      dispatchedActions,
      windowDays: days,
      since: since.toISOString(),
    };

    return c.json({ data: dto });
  }
);
