import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import {
  activateContract, pauseContract, resumeContract, cancelContract
} from '../../services/contractService';
import { type ContractActor } from '../../services/contractTypes';
import { contractActorFrom, handleContractError } from './contracts';

export const contractLifecycleRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const managePerm = requirePermission(PERMISSIONS.CONTRACTS_MANAGE.resource, PERMISSIONS.CONTRACTS_MANAGE.action);
const idParam = z.object({ id: z.string().guid() });

type LifecycleFn = (contractId: string, actor: ContractActor) => Promise<unknown>;
const lifecycleActions: Array<[string, LifecycleFn]> = [
  ['activate', activateContract],
  ['pause', pauseContract],
  ['resume', resumeContract],
  ['cancel', cancelContract],
];

for (const [verb, fn] of lifecycleActions) {
  contractLifecycleRoutes.post(`/:id/${verb}`, scopes, managePerm, zValidator('param', idParam), async (c) => {
    try { return c.json({ data: await fn(c.req.valid('param').id, contractActorFrom(c)) }); }
    catch (err) { return handleContractError(c, err); }
  });
}
