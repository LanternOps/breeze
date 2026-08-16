import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { officeAddinTechAuthMiddleware, requireAddinCapability } from '../../middleware/officeAddinTechAuth';
import { buildEmailContext, searchOrgsForAddin } from '../../services/officeAddin/emailContext';
import { emailContextSchema, orgSearchSchema } from './schemas';

/**
 * Tech add-in email-context + org-search endpoints (spec §3.1, Task 15).
 * Both require the `email-context` capability, which is tickets:read RBAC
 * intersected with the add-in binding — see officeAddinTechAuth.ts.
 *
 * Unlike the other tech-token sub-routers, these two paths share no common
 * prefix, so this router stays mounted at '/' in ./index.ts and attaches
 * `officeAddinTechAuthMiddleware` per route instead of via `use('*')` — a
 * wildcard here would flatten onto every sibling mount and run the (expensive,
 * DB-backed) auth middleware a second time for /tickets/* and /time/*.
 */
export const officeAddinEmailContextRoutes = new Hono();

officeAddinEmailContextRoutes.post(
  '/email-context',
  officeAddinTechAuthMiddleware,
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
  officeAddinTechAuthMiddleware,
  requireAddinCapability('email-context'),
  zValidator('json', orgSearchSchema),
  async (c) => {
    const tech = c.get('officeAddinAuth');
    const { query } = c.req.valid('json');
    const orgs = await searchOrgsForAddin(query, tech);
    return c.json({ orgs });
  }
);
