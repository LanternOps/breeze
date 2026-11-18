import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  ensureOrgAccess,
  getDeviceWithOrgAndSiteCheck,
  SITE_ACCESS_DENIED,
} from './helpers';
import { createLinkGroupSchema, updateLinkGroupSchema } from './schemas';
import {
  createLinkGroup,
  dissolveLinkGroup,
  getDeviceLinkGroup,
  getLinkGroup,
  listLinkGroups,
  updateLinkGroup,
  type CheckDevice,
} from '../../services/deviceLinkGroupOps';
import { captureException } from '../../services/sentry';
import type { AuthContext } from '../../middleware/auth';

/**
 * Linked device profiles for multi-boot systems (#2138).
 *
 * Manual link/unlink of 2+ device records as boot profiles of one physical
 * machine. NON-destructive: each device keeps its own inventory/history. The
 * device list renders offline siblings as thin "expected offline" strips
 * beneath the single online member (all-offline groups get a left-edge bar;
 * 2+ online renders plain full rows — no conflict state, no primary election;
 * see apps/web/src/components/devices/linkedDevices.ts for the presentation
 * rules). The device-detail Linked Profiles tab lists all members and hosts
 * the unlink/dissolve actions.
 *
 * The logic lives in services/deviceLinkGroupOps.ts (shared with the AI
 * tools); these handlers are thin adapters.
 *
 * Mounted BEFORE coreRoutes so the static `/link-groups` paths are not eaten by
 * the core `/:id` matcher.
 */
export const linksRoutes = new Hono();

linksRoutes.use('*', authMiddleware);

/** Hono-bound device lookup for the service: org + site check, SITE_ACCESS_DENIED → 'site_denied'. */
function deviceChecker(c: Context, auth: AuthContext): CheckDevice {
  return async (id) => {
    const device = await getDeviceWithOrgAndSiteCheck(c, id, auth);
    return device === SITE_ACCESS_DENIED ? 'site_denied' : device;
  };
}

// GET /devices/link-groups — every link group in the caller's accessible orgs,
// each with its (site-scoped) members. Powers the device list's grouping.
linksRoutes.get(
  '/link-groups',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const r = await listLinkGroups({ auth, audit: (e) => writeRouteAudit(c, e) });
    return c.json(r.body, r.status);
  },
);

// POST /devices/link-groups — link 2+ devices as boot profiles of one machine
// (kind='multiboot') or as one host server plus its guest VMs (kind='vm_host',
// #2308: hostDeviceId names the host; every other member becomes a guest).
linksRoutes.post(
  '/link-groups',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requireMfa(),
  zValidator('json', createLinkGroupSchema),
  async (c) => {
    const auth = c.get('auth');
    const r = await createLinkGroup(
      {
        auth,
        checkDevice: deviceChecker(c, auth),
        audit: (e) => writeRouteAudit(c, e),
        actorUserId: auth.user.id,
      },
      c.req.valid('json'),
    );
    return c.json(r.body, r.status);
  },
);

// GET /devices/link-groups/:groupId — one group with its members.
linksRoutes.get(
  '/link-groups/:groupId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const r = await getLinkGroup(
      {
        auth,
        hasOrgAccess: (orgId) => ensureOrgAccess(orgId, auth),
        audit: (e) => writeRouteAudit(c, e),
      },
      c.req.param('groupId')!,
    );
    return c.json(r.body, r.status);
  },
);

// PATCH /devices/link-groups/:groupId — rename and/or add/remove profiles.
linksRoutes.patch(
  '/link-groups/:groupId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requireMfa(),
  zValidator('json', updateLinkGroupSchema),
  async (c) => {
    const auth = c.get('auth');
    const r = await updateLinkGroup(
      {
        auth,
        checkDevice: deviceChecker(c, auth),
        hasOrgAccess: (orgId) => ensureOrgAccess(orgId, auth),
        audit: (e) => writeRouteAudit(c, e),
      },
      c.req.param('groupId')!,
      c.req.valid('json'),
    );
    return c.json(r.body, r.status);
  },
);

// DELETE /devices/link-groups/:groupId — unlink every profile and remove the group.
linksRoutes.delete(
  '/link-groups/:groupId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_DELETE.resource, PERMISSIONS.DEVICES_DELETE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const r = await dissolveLinkGroup(
      {
        auth,
        hasOrgAccess: (orgId) => ensureOrgAccess(orgId, auth),
        audit: (e) => writeRouteAudit(c, e),
      },
      c.req.param('groupId')!,
    );
    return c.json(r.body, r.status);
  },
);

// GET /devices/:id/link-group — the boot-profile group a device belongs to,
// with its sibling profiles (agent version + last seen). Powers the device
// detail "Linked Profiles" panel. Returns { group: null } when unlinked.
linksRoutes.get(
  '/:id/link-group',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const r = await getDeviceLinkGroup(
      {
        auth,
        checkDevice: deviceChecker(c, auth),
        reportDanglingReference: (err) => captureException(err, c),
      },
      c.req.param('id')!,
    );
    return c.json(r.body, r.status);
  },
);
