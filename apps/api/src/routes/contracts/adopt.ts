/**
 * POST /contracts/:id/adopt-draft (#9346) — fold the org's hand-built DRAFT
 * contract `sourceContractId` into contract `:id` (normally the one a quote
 * accept created): its deliverables move here, its signed agreements and
 * agreement requests are re-linked here, and the draft is deleted. Same gate
 * as editing or deleting a draft: contracts:write.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { adoptDraftContractSchema } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { adoptDraftContract } from '../../services/contractAdoptService';
import { auditBillingDocument } from '../../services/billingDocumentAudit';
import { contractActorFrom, handleContractError } from './contracts';

export const contractAdoptRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const writePerm = requirePermission(PERMISSIONS.CONTRACTS_WRITE.resource, PERMISSIONS.CONTRACTS_WRITE.action);
const idParam = z.object({ id: z.string().guid() });

contractAdoptRoutes.post(
  '/:id/adopt-draft',
  scopes, writePerm,
  zValidator('param', idParam), zValidator('json', adoptDraftContractSchema),
  async (c) => {
    try {
      const result = await adoptDraftContract(c.req.valid('param').id, c.req.valid('json'), contractActorFrom(c));
      // One row, on the surviving contract; the deleted draft is named in details.
      auditBillingDocument(c, 'contract', 'draft_adopted', result.target, {
        sourceContractId: result.source.id,
        sourceContractName: result.source.name,
        movedDeliverables: result.movedDeliverables,
        movedDocuments: result.movedDocuments,
        movedAgreementRequests: result.movedAgreementRequests,
      });
      return c.json({ data: result });
    } catch (err) { return handleContractError(c, err); }
  },
);
