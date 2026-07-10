/**
 * OneDrive Helper picker routes — feeds the (Phase 3) policy editor UI a list
 * of the org's SharePoint document libraries, each with a prebuilt
 * TenantAutoMount registry composite ready to hand to the agent/helper.
 */

import { Hono } from 'hono';
import { authMiddleware, requirePermission, requireScope } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { resolveScopedOrgId } from './c2c/helpers';
import { hasDirectM365Connection } from '../services/m365DirectGraph';
import { listSharePointLibraries } from '../services/onedriveGraph';

export const onedriveRoutes = new Hono();

const requireDevicesRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);

// Every endpoint requires an authenticated session (populates c.get('auth') for
// the requireScope / requirePermission guards below). Without this the guards
// see no auth context and reject every request with 401.
onedriveRoutes.use('*', authMiddleware);

// Library picker for the onedrive_helper policy editor: browse the org's
// SharePoint document libraries with a prebuilt TenantAutoMount composite each.
onedriveRoutes.get(
  '/libraries',
  requireScope('organization', 'partner', 'system'),
  requireDevicesRead,
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    if (!(await hasDirectM365Connection(orgId))) {
      return c.json({ error: 'This organization has no Microsoft 365 connection. Connect M365 first.' }, 409);
    }

    const res = await listSharePointLibraries(orgId);
    if (res.kind === 'error') {
      return c.json({ error: res.message, code: res.code }, 502);
    }
    return c.json(res.data);
  },
);
