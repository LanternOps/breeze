import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { contractLineInputSchema } from '@breeze/shared';
import { addContractLineToContract, removeContractLine } from '../../services/contractService';
import { contractActorFrom, handleContractError } from './contracts';

export const contractLineRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const writePerm = requirePermission(PERMISSIONS.CONTRACTS_WRITE.resource, PERMISSIONS.CONTRACTS_WRITE.action);
const idParam = z.object({ id: z.string().guid() });
const lineParam = z.object({ id: z.string().guid(), lineId: z.string().guid() });

contractLineRoutes.post('/:id/lines', scopes, writePerm, zValidator('param', idParam), zValidator('json', contractLineInputSchema), async (c) => {
  try { return c.json({ data: await addContractLineToContract(c.req.valid('param').id, c.req.valid('json'), contractActorFrom(c)) }); }
  catch (err) { return handleContractError(c, err); }
});
contractLineRoutes.delete('/:id/lines/:lineId', scopes, writePerm, zValidator('param', lineParam), async (c) => {
  try { const p = c.req.valid('param'); return c.json({ data: await removeContractLine(p.id, p.lineId, contractActorFrom(c)) }); }
  catch (err) { return handleContractError(c, err); }
});
