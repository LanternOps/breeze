import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { bulkContractIdsSchema } from '@breeze/shared';
import { runBulk } from '../../lib/bulkOps';
import { deleteDraftContract, cancelContract } from '../../services/contractService';
import { contractActorFrom, handleContractError } from './contracts';

export const contractBulkRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const writePerm = requirePermission(PERMISSIONS.CONTRACTS_WRITE.resource, PERMISSIONS.CONTRACTS_WRITE.action);
const managePerm = requirePermission(PERMISSIONS.CONTRACTS_MANAGE.resource, PERMISSIONS.CONTRACTS_MANAGE.action);

contractBulkRoutes.post('/bulk-delete', scopes, writePerm, zValidator('json', bulkContractIdsSchema), async (c) => {
  try {
    const actor = contractActorFrom(c);
    const { ids } = c.req.valid('json');
    return c.json({ data: await runBulk(ids, (id) => deleteDraftContract(id, actor)) });
  } catch (err) { return handleContractError(c, err); }
});

contractBulkRoutes.post('/bulk-cancel', scopes, managePerm, zValidator('json', bulkContractIdsSchema), async (c) => {
  try {
    const actor = contractActorFrom(c);
    const { ids } = c.req.valid('json');
    return c.json({ data: await runBulk(ids, (id) => cancelContract(id, actor)) });
  } catch (err) { return handleContractError(c, err); }
});
