import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { contractLineInputSchema, updateContractLineSchema } from '@breeze/shared';
import {
  addContractLineToContract,
  contractLineAuditDetails,
  removeContractLine,
  updateContractLine,
} from '../../services/contractService';
import { writeRouteAudit } from '../../services/auditEvents';
import type { ContractLineAudit } from '../../services/contractTypes';
import { contractActorFrom, handleContractError } from './contracts';

export const contractLineRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const writePerm = requirePermission(PERMISSIONS.CONTRACTS_WRITE.resource, PERMISSIONS.CONTRACTS_WRITE.action);
const idParam = z.object({ id: z.string().guid() });
const lineParam = z.object({ id: z.string().guid(), lineId: z.string().guid() });

type AuditableContext = Parameters<typeof writeRouteAudit>[0];
type ContractLineAuditAction = 'contract.line.added' | 'contract.line.removed' | 'contract.line.updated';

/**
 * #3205 W03: all three line mutations audit, through one helper so the call
 * sites cannot drift. resourceType 'contract' with the CONTRACT id as
 * resourceId (the line id lives in details), so filtering the audit log by a
 * contract shows its whole line history together.
 *
 * NO FREE TEXT: only the line id, the lineType, the changed column NAMES and a
 * numeric old/new unit price. No description, no site name, no group name.
 * A no-op patch (changedFields: []) writes no event at all.
 */
const writeLineAudit = (c: AuditableContext, action: ContractLineAuditAction, a: ContractLineAudit): void => {
  if (a.changedFields && a.changedFields.length === 0) return;
  writeRouteAudit(c, {
    orgId: a.orgId,
    action,
    resourceType: 'contract',
    resourceId: a.contractId,
    resourceName: a.contractName,
    details: contractLineAuditDetails(a),
  });
};

contractLineRoutes.post('/:id/lines', scopes, writePerm, zValidator('param', idParam), zValidator('json', contractLineInputSchema), async (c) => {
  try {
    const contractId = c.req.valid('param').id;
    const { contractName, ...row } = await addContractLineToContract(contractId, c.req.valid('json'), contractActorFrom(c));
    writeLineAudit(c, 'contract.line.added', {
      orgId: row.orgId, contractId, contractName, contractLineId: row.id, lineType: row.lineType, newUnitPrice: row.unitPrice,
    });
    return c.json({ data: row });
  }
  catch (err) { return handleContractError(c, err); }
});

// #3205 W03. Mount order needs no change: contractLineRoutes is registered
// before contractCrudRoutes (routes/contracts/index.ts:19-20) and Hono matches
// method+path, so PATCH /:id/lines/:lineId cannot shadow PATCH /:id.
contractLineRoutes.patch('/:id/lines/:lineId', scopes, writePerm,
  zValidator('param', lineParam), zValidator('json', updateContractLineSchema), async (c) => {
  try {
    const p = c.req.valid('param');
    const { line, audit } = await updateContractLine(p.id, p.lineId, c.req.valid('json'), contractActorFrom(c));
    writeLineAudit(c, 'contract.line.updated', audit);
    return c.json({ data: line });
  } catch (err) { return handleContractError(c, err); }
});

contractLineRoutes.delete('/:id/lines/:lineId', scopes, writePerm, zValidator('param', lineParam), async (c) => {
  try {
    const p = c.req.valid('param');
    const audit = await removeContractLine(p.id, p.lineId, contractActorFrom(c));
    writeLineAudit(c, 'contract.line.removed', audit);
    // Was {"data":undefined} -> {} before W03; removeContractLine returns the
    // pre-read audit payload now and 404s on a miss.
    return c.json({ data: { ok: true } });
  }
  catch (err) { return handleContractError(c, err); }
});
