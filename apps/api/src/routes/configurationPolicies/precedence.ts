import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import type { AuthContext } from '../../middleware/auth';
import { requirePermission, requireScope } from '../../middleware/auth';
import { getConfigPolicy } from '../../services/configurationPolicy';
import { computePolicyPrecedence } from '../../services/configPolicyPrecedence';
import { PERMISSIONS } from '../../services/permissions';

// "Outranked on N devices" per feature (#12472, plan W05a O2): on how many of
// the devices a policy reaches another policy wins each of its features.
// Counted in the caller's own request context and answered as counts only
// (see services/configPolicyPrecedence). Mounted before crudRoutes.
export const precedenceRoutes = new Hono();

const requireConfigPolicyRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);

const idParamSchema = z.object({ id: z.string().guid() });

// GET /:id/precedence: 404 when the caller cannot read the policy.
precedenceRoutes.get(
  '/:id/precedence',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyRead,
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    // The read predicate (W03a) decides who may ask, as on reach: an org admin
    // gets the counts of an MSP-managed policy that applies to its
    // organization. The count itself reads under RLS (see the service header).
    const policy = await getConfigPolicy(id, auth, { access: 'read' });
    if (!policy) return c.json({ error: 'Configuration policy not found' }, 404);

    const precedence = await computePolicyPrecedence(auth, id);
    if (!precedence) return c.json({ error: 'Configuration policy not found' }, 404);
    return c.json(precedence);
  },
);
