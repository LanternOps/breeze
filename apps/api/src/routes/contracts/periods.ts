import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { getPeriodOutcome } from '../../services/billingEvidence';
import { contractActorFrom, handleContractError } from './contracts';

export const contractPeriodRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.CONTRACTS_READ.resource, PERMISSIONS.CONTRACTS_READ.action);
const periodParam = z.object({ id: z.string().guid(), periodId: z.string().guid() });

contractPeriodRoutes.get(
  '/:id/periods/:periodId/outcome',
  scopes,
  readPerm,
  zValidator('param', periodParam),
  async (c) => {
    const { id, periodId } = c.req.valid('param');
    try {
      return c.json({ data: await getPeriodOutcome(id, periodId, contractActorFrom(c)) });
    } catch (err) {
      return handleContractError(c, err);
    }
  },
);
