import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import type { AuthContext } from '../../middleware/auth';
import { requirePermission, requireScope } from '../../middleware/auth';
import { getConfigPolicy } from '../../services/configurationPolicy';
import { computePolicyReach, readablePolicyIds, type ConfigPolicyReach } from '../../services/configPolicyReach';
import { PERMISSIONS } from '../../services/permissions';

// Policy reach (#12465, plan W02a R3): how many devices a policy targets,
// directly and through its child policies, and across how many organizations.
// Counted in the caller's own request context (see services/configPolicyReach).
// Mounted before crudRoutes so `/reach` is never read as `/:id`.
export const reachRoutes = new Hono();

const requireConfigPolicyRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);

export const REACH_BATCH_MAX_IDS = 100;

// `ids` is a comma-separated list of 1-100 policy guids. Duplicates are
// dropped before the limit is checked.
const batchQuerySchema = z.object({
  ids: z
    .string()
    .transform((value) => [...new Set(value.split(',').map((id) => id.trim()).filter((id) => id.length > 0))])
    .pipe(z.array(z.string().guid()).min(1).max(REACH_BATCH_MAX_IDS)),
});

const idParamSchema = z.object({ id: z.string().guid() });

// GET /reach?ids=… — reach for list rows. Ids the caller cannot read are absent.
reachRoutes.get(
  '/reach',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyRead,
  zValidator('query', batchQuerySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { ids } = c.req.valid('query');

    const readable = await readablePolicyIds(auth, ids);
    const data: Record<string, ConfigPolicyReach> = {};
    if (readable.length > 0) {
      const reach = await computePolicyReach(auth, readable);
      for (const [id, counts] of reach) data[id] = counts;
    }
    return c.json({ data });
  },
);

// GET /:id/reach — reach for one policy; 404 when the caller cannot read it.
reachRoutes.get(
  '/:id/reach',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyRead,
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const policy = await getConfigPolicy(id, auth);
    if (!policy) return c.json({ error: 'Configuration policy not found' }, 404);

    // computePolicyReach answers for every policy its RLS context reads, so a
    // missing entry means the two reads disagreed. Never answer "0 devices"
    // for a policy that was not counted.
    const counts = (await computePolicyReach(auth, [id])).get(id);
    if (!counts) return c.json({ error: 'Configuration policy not found' }, 404);
    return c.json(counts);
  },
);
