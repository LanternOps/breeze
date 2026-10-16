import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { listContractHourPeriods } from '../../services/contractHourPeriodsRead';
import { contractActorFrom, handleContractError } from './contracts';

export const contractHourPeriodRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.CONTRACTS_READ.resource, PERMISSIONS.CONTRACTS_READ.action);
const idParam = z.object({ id: z.string().guid() });
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(24),
  cursor: z.string().regex(/^\d{4}-\d{2}-\d{2}\|[0-9a-fA-F-]{36}$/).optional(),
}).strict();

contractHourPeriodRoutes.get('/:id/hour-periods', scopes, readPerm,
  zValidator('param', idParam), zValidator('query', querySchema), async (c) => {
  try {
    return c.json({ data: await listContractHourPeriods(c.req.valid('param').id, c.req.valid('query'), contractActorFrom(c)) });
  } catch (err) { return handleContractError(c, err); }
});
