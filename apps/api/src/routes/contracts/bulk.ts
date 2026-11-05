import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { requireScope, requirePermission, dbAccessContextFromAuth, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { bulkContractIdsSchema } from '@breeze/shared';
import { runBulkIsolated } from '../../lib/bulkOps';
import { deleteDraftContract, cancelContract } from '../../services/contractService';
import { contractActorFrom, handleContractError } from './contracts';
import { auditBillingDocument } from '../../services/billingDocumentAudit';
import { assertBillingEnabledForPartner } from '../../services/billingEnabled';
import { ContractServiceError, type ContractServiceErrorCode } from '../../services/contractTypes';

export const contractBulkRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const writePerm = requirePermission(PERMISSIONS.CONTRACTS_WRITE.resource, PERMISSIONS.CONTRACTS_WRITE.action);
const managePerm = requirePermission(PERMISSIONS.CONTRACTS_MANAGE.resource, PERMISSIONS.CONTRACTS_MANAGE.action);
// Per-item errors would be tallied as 'skipped'; the master switch answers 404 for the whole call.
const assertBulkBillingEnabled = (c: { get: (k: string) => unknown }) =>
  assertBillingEnabledForPartner((c.get('auth') as AuthContext).partnerId,
    (m, s, code) => new ContractServiceError(m, s, code as ContractServiceErrorCode));

contractBulkRoutes.post('/bulk-delete', scopes, writePerm, zValidator('json', bulkContractIdsSchema), async (c) => {
  try {
    await assertBulkBillingEnabled(c);
    const ctx = dbAccessContextFromAuth(c.get('auth') as AuthContext);
    const actor = contractActorFrom(c);
    const { ids } = c.req.valid('json');
    // Each item is audited after its own transaction commits; skipped/failed ids are not.
    return c.json({ data: await runBulkIsolated(ctx, ids, (id) => deleteDraftContract(id, actor),
      async (_id, deleted) => auditBillingDocument(c, 'contract', 'delete', deleted, { bulk: true })) });
  } catch (err) { return handleContractError(c, err); }
});

// Decision (spec 2b): only bulk-cancel is gated; the single cancel stays open
// (kept working with billing off, §7.2) — a known inconsistency.
contractBulkRoutes.post('/bulk-cancel', scopes, managePerm, zValidator('json', bulkContractIdsSchema), async (c) => {
  try {
    await assertBulkBillingEnabled(c);
    const ctx = dbAccessContextFromAuth(c.get('auth') as AuthContext);
    const actor = contractActorFrom(c);
    const { ids } = c.req.valid('json');
    return c.json({ data: await runBulkIsolated(ctx, ids, (id) => cancelContract(id, actor),
      async (_id, cancelled) => auditBillingDocument(c, 'contract', 'cancel', cancelled, { bulk: true })) });
  } catch (err) { return handleContractError(c, err); }
});
