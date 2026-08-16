import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { officeAddinTechAuthMiddleware, requireAddinCapability } from '../../middleware/officeAddinTechAuth';
import { buildEmailContext, searchOrgsForAddin } from '../../services/officeAddin/emailContext';
import { emailContextSchema, orgSearchSchema } from './schemas';

/**
 * Tech add-in email-context + org-search endpoints (spec §3.1, Task 15).
 * Both require the `email-context` capability, which is tickets:read RBAC
 * intersected with the add-in binding — see officeAddinTechAuth.ts.
 */
export const officeAddinEmailContextRoutes = new Hono();

officeAddinEmailContextRoutes.use('*', officeAddinTechAuthMiddleware);

officeAddinEmailContextRoutes.post(
  '/email-context',
  requireAddinCapability('email-context'),
  zValidator('json', emailContextSchema),
  async (c) => {
    const tech = c.get('officeAddinAuth');
    const input = c.req.valid('json');
    const result = await buildEmailContext(input, tech);
    return c.json(result);
  }
);

officeAddinEmailContextRoutes.post(
  '/orgs/search',
  requireAddinCapability('email-context'),
  zValidator('json', orgSearchSchema),
  async (c) => {
    const tech = c.get('officeAddinAuth');
    const { query } = c.req.valid('json');
    const orgs = await searchOrgsForAddin(query, tech);
    return c.json({ orgs });
  }
);
