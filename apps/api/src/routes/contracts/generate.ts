import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { getContract, generateDueInvoice } from '../../services/contractService';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { contractActorFrom, handleContractError } from './contracts';

export const contractGenerateRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const managePerm = requirePermission(PERMISSIONS.CONTRACTS_MANAGE.resource, PERMISSIONS.CONTRACTS_MANAGE.action);
const idParam = z.object({ id: z.string().uuid() });

contractGenerateRoutes.post('/:id/generate', scopes, managePerm, zValidator('param', idParam), async (c) => {
  try {
    const id = c.req.valid('param').id;
    // Authorize: verify the caller can see this contract (404/403 gate).
    await getContract(id, contractActorFrom(c));
    // Execute generation under system scope (generateDueInvoice runs its own
    // DB writes that must bypass per-request RLS context).
    const result = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() => generateDueInvoice(id))
    );
    return c.json({ data: result });
  } catch (err) { return handleContractError(c, err); }
});
