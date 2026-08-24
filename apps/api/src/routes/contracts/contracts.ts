import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { requireScope, requirePermission, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS, hasPermission, type UserPermissions } from '../../services/permissions';
import {
  createContractSchema, updateContractSchema, listContractsQuerySchema, changeContractCurrencySchema
} from '@breeze/shared';
import {
  createContract, getContract, listContracts, updateContract, deleteDraftContract,
  computeContractEstimate, changeContractCurrency
} from '../../services/contractService';
import { ContractServiceError, type ContractActor } from '../../services/contractTypes';

export const contractCrudRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.CONTRACTS_READ.resource, PERMISSIONS.CONTRACTS_READ.action);
const writePerm = requirePermission(PERMISSIONS.CONTRACTS_WRITE.resource, PERMISSIONS.CONTRACTS_WRITE.action);
const idParam = z.object({ id: z.string().guid() });

/**
 * Contract permissions surfaced to the service layer as verified evidence
 * (#3778). Evaluated through hasPermission so wildcard grants resolve exactly
 * as the middleware resolves them — a raw string match on the grant list would
 * miss `contracts:*`. A request whose permissions were never resolved yields an
 * EMPTY set, which the service treats as DENY (fail-closed by construction:
 * system/background callers pass no permissions and can never reach the
 * ACTIVE-contract restamp).
 */
const CONTRACT_ACTOR_PERMISSIONS = [
  PERMISSIONS.CONTRACTS_READ, PERMISSIONS.CONTRACTS_WRITE, PERMISSIONS.CONTRACTS_MANAGE,
] as const;

export function contractActorFrom(c: { get: (k: string) => unknown }): ContractActor {
  const auth = c.get('auth') as AuthContext;
  const userPerms = c.get('permissions') as UserPermissions | undefined;
  const granted = new Set<string>();
  if (userPerms) {
    for (const p of CONTRACT_ACTOR_PERMISSIONS) {
      if (hasPermission(userPerms, p.resource, p.action)) granted.add(`${p.resource}:${p.action}`);
    }
  }
  return {
    userId: auth.user.id,
    partnerId: auth.partnerId ?? null,
    accessibleOrgIds: auth.accessibleOrgIds,
    permissions: granted,
  };
}
export function handleContractError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  // `details` names the exact blocking rows (#3778) — dropping it left the
  // operator with a bare 409 and nothing to act on.
  if (err instanceof ContractServiceError) {
    return c.json({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) }, err.status);
  }
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
// Atomic change-currency op (#3774) — the ONLY mutation path for a document's
// stamped currency. CURRENCY_LOCKED (409) when contract lines exist and
// clearLines wasn't passed; clearLines deletes lines + restamps atomically.
// Wave 6 (#3778): an ACTIVE contract may also be restamped through the
// owner-approved escape hatch. The ROUTE keeps CONTRACTS_WRITE so the draft path
// is unchanged for existing callers; the SERVICE enforces CONTRACTS_MANAGE (and
// confirmActiveChange, and eligibility under the row lock) on the ACTIVE branch.
contractCrudRoutes.post('/:id/currency', scopes, writePerm, zValidator('param', idParam), zValidator('json', changeContractCurrencySchema), async (c) => {
  try { return c.json({ data: await changeContractCurrency(c.req.valid('param').id, c.req.valid('json'), contractActorFrom(c)) }); }
  catch (err) { return handleContractError(c, err); }
});
