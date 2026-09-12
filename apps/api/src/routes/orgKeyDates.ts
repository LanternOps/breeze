/**
 * Organization key date routes (#5573 W01), mounted at `/orgs`:
 *
 *   GET/POST      /orgs/:orgId/key-dates
 *   PATCH/DELETE  /orgs/:orgId/key-dates/:id
 *
 * Sibling `/orgs` router (orgSummary / orgArchive style) owning its own
 * authMiddleware. Shares the contracts permission family with deliverables
 * (spec §12); org access is enforced in the service as 404 `NOT_FOUND`.
 * GET returns the merged view (key dates + contract end dates) sorted by date.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../lib/validation';
import { authMiddleware, requireScope, requirePermission } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { createKeyDateSchema, updateKeyDateSchema } from '@breeze/shared';
import { listKeyDates, createKeyDate, updateKeyDate, deleteKeyDate } from '../services/orgKeyDateService';
import { deliverableActorFrom, handleDeliverableError } from './serviceDeliverables';

export const orgKeyDateRoutes = new Hono();
orgKeyDateRoutes.use('*', authMiddleware);

const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.CONTRACTS_READ.resource, PERMISSIONS.CONTRACTS_READ.action);
const writePerm = requirePermission(PERMISSIONS.CONTRACTS_WRITE.resource, PERMISSIONS.CONTRACTS_WRITE.action);

const orgParam = z.object({ orgId: z.string().guid() });
const keyDateParam = orgParam.extend({ id: z.string().guid() });

orgKeyDateRoutes.get('/:orgId/key-dates', scopes, readPerm, zValidator('param', orgParam), async (c) => {
  try {
    return c.json({
      data: await listKeyDates(c.req.valid('param').orgId, deliverableActorFrom(c), { includeContractEnds: true }),
    });
  } catch (err) { return handleDeliverableError(c, err); }
});

orgKeyDateRoutes.post(
  '/:orgId/key-dates',
  scopes, writePerm,
  zValidator('param', orgParam), zValidator('json', createKeyDateSchema),
  async (c) => {
    try {
      return c.json({ data: await createKeyDate(c.req.valid('param').orgId, c.req.valid('json'), deliverableActorFrom(c)) });
    } catch (err) { return handleDeliverableError(c, err); }
  },
);

orgKeyDateRoutes.patch(
  '/:orgId/key-dates/:id',
  scopes, writePerm,
  zValidator('param', keyDateParam), zValidator('json', updateKeyDateSchema),
  async (c) => {
    const { orgId, id } = c.req.valid('param');
    try {
      return c.json({ data: await updateKeyDate(orgId, id, c.req.valid('json'), deliverableActorFrom(c)) });
    } catch (err) { return handleDeliverableError(c, err); }
  },
);

orgKeyDateRoutes.delete('/:orgId/key-dates/:id', scopes, writePerm, zValidator('param', keyDateParam), async (c) => {
  const { orgId, id } = c.req.valid('param');
  try {
    await deleteKeyDate(orgId, id, deliverableActorFrom(c));
    return c.json({ data: { ok: true } });
  } catch (err) { return handleDeliverableError(c, err); }
});
