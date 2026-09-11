/**
 * GET /contracts/:id/deliverables (#5573 W01) — the deliverables attached to
 * one contract. Resolves the contract's org first (the contracts table is
 * RLS-scoped, so a cross-tenant id simply reads as absent → 404), then
 * delegates to the org-scoped service with `{ contractId }`.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { zValidator } from '../../lib/validation';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { db } from '../../db';
import { contracts } from '../../db/schema/contracts';
import { listDeliverables } from '../../services/serviceDeliverableService';
import { deliverableActorFrom, handleDeliverableError } from '../serviceDeliverables';

export const contractDeliverableRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.CONTRACTS_READ.resource, PERMISSIONS.CONTRACTS_READ.action);
const idParam = z.object({ id: z.string().guid() });

contractDeliverableRoutes.get('/:id/deliverables', scopes, readPerm, zValidator('param', idParam), async (c) => {
  const { id } = c.req.valid('param');
  const [contract] = await db
    .select({ id: contracts.id, orgId: contracts.orgId })
    .from(contracts)
    .where(eq(contracts.id, id));
  if (!contract) return c.json({ error: 'Contract not found', code: 'CONTRACT_NOT_FOUND' }, 404);
  try {
    return c.json({ data: await listDeliverables(contract.orgId, { contractId: id }, deliverableActorFrom(c)) });
  } catch (err) { return handleDeliverableError(c, err); }
});
