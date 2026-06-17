import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope, requirePermission, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import {
  createContractSchema, updateContractSchema, listContractsQuerySchema
} from '@breeze/shared';
import {
  createContract, getContract, listContracts, updateContract, deleteDraftContract,
  computeContractEstimate
} from '../../services/contractService';
import { ContractServiceError, type ContractActor } from '../../services/contractTypes';

export const contractCrudRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.CONTRACTS_READ.resource, PERMISSIONS.CONTRACTS_READ.action);
const writePerm = requirePermission(PERMISSIONS.CONTRACTS_WRITE.resource, PERMISSIONS.CONTRACTS_WRITE.action);
const idParam = z.object({ id: z.string().guid() });

export function contractActorFrom(c: { get: (k: string) => unknown }): ContractActor {
  const auth = c.get('auth') as AuthContext;
  return { userId: auth.user.id, partnerId: auth.partnerId ?? null, accessibleOrgIds: auth.accessibleOrgIds };
}
export function handleContractError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof ContractServiceError) return c.json({ error: err.message, code: err.code }, err.status);
  throw err;
}

contractCrudRoutes.get('/', scopes, readPerm, zValidator('query', listContractsQuerySchema), async (c) => {
  try { return c.json({ data: await listContracts(c.req.valid('query'), contractActorFrom(c)) }); }
  catch (err) { return handleContractError(c, err); }
});
contractCrudRoutes.post('/', scopes, writePerm, zValidator('json', createContractSchema), async (c) => {
  try { return c.json({ data: await createContract(c.req.valid('json'), contractActorFrom(c)) }); }
  catch (err) { return handleContractError(c, err); }
});
contractCrudRoutes.get('/:id/estimate', scopes, readPerm, zValidator('param', idParam), async (c) => {
  try { return c.json({ data: await computeContractEstimate(c.req.valid('param').id, contractActorFrom(c)) }); }
  catch (err) { return handleContractError(c, err); }
});
contractCrudRoutes.get('/:id', scopes, readPerm, zValidator('param', idParam), async (c) => {
  try { return c.json({ data: await getContract(c.req.valid('param').id, contractActorFrom(c)) }); }
  catch (err) { return handleContractError(c, err); }
});
contractCrudRoutes.patch('/:id', scopes, writePerm, zValidator('param', idParam), zValidator('json', updateContractSchema), async (c) => {
  try { return c.json({ data: await updateContract(c.req.valid('param').id, c.req.valid('json'), contractActorFrom(c)) }); }
  catch (err) { return handleContractError(c, err); }
});
contractCrudRoutes.delete('/:id', scopes, writePerm, zValidator('param', idParam), async (c) => {
  try { await deleteDraftContract(c.req.valid('param').id, contractActorFrom(c)); return c.json({ data: { ok: true } }); }
  catch (err) { return handleContractError(c, err); }
});
