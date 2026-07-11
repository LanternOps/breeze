/**
 * OneDrive Helper picker routes — feeds the (Phase 3) policy editor UI a list
 * of the org's SharePoint document libraries, each with a prebuilt
 * TenantAutoMount registry composite ready to hand to the agent/helper.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { authMiddleware, requirePermission, requireScope } from '../middleware/auth';
import { canAccessSite, PERMISSIONS, type UserPermissions } from '../services/permissions';
import { resolveScopedOrgId } from './c2c/helpers';
import { hasDirectM365Connection } from '../services/m365DirectGraph';
import { listSharePointLibraries } from '../services/onedriveGraph';
import { db } from '../db';
import { devices } from '../db/schema/devices';
import { onedriveDeviceState } from '../db/schema/onedriveHelper';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './devices/helpers';

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

// Per-device OneDrive state for the device detail panel. Registered BEFORE
// '/state' below for clarity — the two paths don't shadow each other under
// Hono's router, but device-scoped-first keeps the group readable.
onedriveRoutes.get(
  '/devices/:deviceId/state',
  requireScope('organization', 'partner', 'system'),
  requireDevicesRead,
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('deviceId')!;
    // Canonical org + site-scope gate (site-scope-coverage contract): a
    // site-restricted tech must not read OneDrive state for devices in
    // other sites of the same org.
    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    const [state] = await db
      .select().from(onedriveDeviceState)
      .where(eq(onedriveDeviceState.deviceId, deviceId)).limit(1);
    return c.json({ state: state ?? null });
  }
);

// Org rollup: entitled-vs-mounted / drift / KFM across the fleet. With an
// explicit ?orgId= we validate + narrow to that one org (400 if inaccessible,
// same as every other resolveScopedOrgId consumer). Without one — the case
// OneDriveFleetPage actually calls for partner techs with >1 accessible org —
// we aggregate across every org the caller can see via auth.orgCondition,
// mirroring the vuln fleet /stats route (routes/vulnerabilities.ts). System
// scope with no explicit org yields no condition = every org; RLS backstops
// this regardless of what the app layer computes.
onedriveRoutes.get(
  '/state',
  requireScope('organization', 'partner', 'system'),
  requireDevicesRead,
  async (c) => {
    const auth = c.get('auth');
    const requestedOrgId = c.req.query('orgId');
    let orgCond;
    if (requestedOrgId) {
      const orgId = resolveScopedOrgId(auth, requestedOrgId);
      if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);
      orgCond = eq(onedriveDeviceState.orgId, orgId);
    } else {
      orgCond = auth.orgCondition(onedriveDeviceState.orgId);
    }

    const allRows = await db
      .select({
        deviceId: onedriveDeviceState.deviceId,
        hostname: devices.hostname,
        siteId: devices.siteId,
        signedIn: onedriveDeviceState.signedIn,
        filesOnDemandOn: onedriveDeviceState.filesOnDemandOn,
        oneDriveVersion: onedriveDeviceState.oneDriveVersion,
        kfmFolderStates: onedriveDeviceState.kfmFolderStates,
        mountedLibraries: onedriveDeviceState.mountedLibraries,
        entitledLibraries: onedriveDeviceState.entitledLibraries,
        driftEntries: onedriveDeviceState.driftEntries,
        lastReportedAt: onedriveDeviceState.lastReportedAt,
      })
      .from(onedriveDeviceState)
      .innerJoin(devices, eq(onedriveDeviceState.deviceId, devices.id))
      .where(orgCond);

    // Site-scope narrowing (site-scope-coverage contract): a site-restricted
    // tech only sees devices in their allowed sites. `permissions` is live —
    // populated by the requireDevicesRead (requirePermission) middleware above.
    const perms = c.get('permissions') as UserPermissions | undefined;
    const rows = perms?.allowedSiteIds
      ? allRows.filter((r) => typeof r.siteId === 'string' && canAccessSite(perms, r.siteId))
      : allRows;

    const kfmProtected = (kfm: unknown) => {
      const entries = Object.values((kfm ?? {}) as Record<string, string>);
      return entries.length > 0 && entries.every((v) => v === 'redirected');
    };
    const stats = {
      total: rows.length,
      signedIn: rows.filter((r) => r.signedIn).length,
      kfmProtected: rows.filter((r) => kfmProtected(r.kfmFolderStates)).length,
      withDrift: rows.filter((r) => Array.isArray(r.driftEntries) && (r.driftEntries as unknown[]).length > 0).length,
    };
    return c.json({ devices: rows, stats });
  }
);
