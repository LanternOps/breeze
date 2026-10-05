import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { requireScope, requirePermission, dbAccessContextFromAuth, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { bulkContractIdsSchema } from '@breeze/shared';
import { runBulkIsolated } from '../../lib/bulkOps';
import { deleteDraftContract, cancelContract } from '../../services/contractService';
import { contractActorFrom, handleContractError } from './contracts';
import { auditBillingDocument } from '../../services/billingDocumentAudit';

export const contractBulkRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const writePerm = requirePermission(PERMISSIONS.CONTRACTS_WRITE.resource, PERMISSIONS.CONTRACTS_WRITE.action);
const managePerm = requirePermission(PERMISSIONS.CONTRACTS_MANAGE.resource, PERMISSIONS.CONTRACTS_MANAGE.action);

contractBulkRoutes.post('/bulk-delete', scopes, writePerm, zValidator('json', bulkContractIdsSchema), async (c) => {
  try {
    const ctx = dbAccessContextFromAuth(c.get('auth') as AuthContext);
    const actor = contractActorFrom(c);
    const { ids } = c.req.valid('json');
    // Each item is audited after its own transaction commits; skipped/failed ids are not.
    return c.json({ data: await runBulkIsolated(ctx, ids, (id) => deleteDraftContract(id, actor),
      async (_id, deleted) => auditBillingDocument(c, 'contract', 'delete', deleted, { bulk: true })) });
  } catch (err) { return handleContractError(c, err); }
});

contractBulkRoutes.post('/bulk-cancel', scopes, managePerm, zValidator('json', bulkContractIdsSchema), async (c) => {
  try {
    const ctx = dbAccessContextFromAuth(c.get('auth') as AuthContext);
    const actor = contractActorFrom(c);
    const { ids } = c.req.valid('json');
    return c.json({ data: await runBulkIsolated(ctx, ids, (id) => cancelContract(id, actor),
      async (_id, cancelled) => auditBillingDocument(c, 'contract', 'cancel', cancelled, { bulk: true })) });
  } catch (err) { return handleContractError(c, err); }
});
