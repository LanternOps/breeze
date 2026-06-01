import { describe, it, expect } from 'vitest';
import {
  analyzeRouteSource,
  findDeviceScopedTables,
} from './routeScan';

// Device-scoped table export names used by the inline fixtures below.
const DEVICE_TABLES = new Set([
  'browserExtensions',
  'deviceMetrics',
  'peripheralEvents',
  'devices',
]);

describe('analyzeRouteSource — input-sourced device-data detector', () => {
  it('flags a query-param deviceId read with no site gate', () => {
    const src = `
      router.get('/extensions', async (c) => {
        const { deviceId } = c.req.query();
        const conditions = [eq(browserExtensions.orgId, auth.orgId)];
        if (deviceId) conditions.push(eq(browserExtensions.deviceId, deviceId));
        return c.json(await db.select().from(browserExtensions).where(and(...conditions)));
      });
    `;
    const route = analyzeRouteSource('routes/x.ts', src, DEVICE_TABLES)[0]!;
    expect(route.touchesDeviceData).toBe(true);
    expect(route.usesSiteScopeGate).toBe(false);
  });

  it('does NOT flag when a site gate is present', () => {
    const src = `
      router.get('/extensions', async (c) => {
        const perms = c.get('permissions');
        const allowed = await resolveSiteAllowedDeviceIds(auth.orgId, perms);
        const conditions = [eq(browserExtensions.orgId, auth.orgId)];
        if (perms?.allowedSiteIds) conditions.push(inArray(browserExtensions.deviceId, allowed));
        return c.json(await db.select().from(browserExtensions).where(and(...conditions)));
      });
    `;
    const route = analyzeRouteSource('routes/x.ts', src, DEVICE_TABLES)[0]!;
    expect(route.touchesDeviceData).toBe(true);
    expect(route.usesSiteScopeGate).toBe(true);
  });

  it('flags a body-sourced deviceIds (inArray) read with no gate', () => {
    const src = `
      router.post('/query', async (c) => {
        const data = c.req.valid('json');
        const where = and(inArray(deviceMetrics.deviceId, data.deviceIds), eq(deviceMetrics.orgId, auth.orgId));
        return c.json(await db.select().from(deviceMetrics).where(where));
      });
    `;
    const route = analyzeRouteSource('routes/x.ts', src, DEVICE_TABLES)[0]!;
    expect(route.touchesDeviceData).toBe(true);
    expect(route.usesSiteScopeGate).toBe(false);
  });

  it('flags a list read that joins devices with no gate', () => {
    const src = `
      router.get('/incidents', async (c) => {
        return c.json(await db.select().from(huntressIncidents)
          .leftJoin(devices, eq(huntressIncidents.deviceId, devices.id))
          .where(eq(huntressIncidents.orgId, auth.orgId)));
      });
    `;
    const route = analyzeRouteSource('routes/x.ts', src, DEVICE_TABLES)[0]!;
    expect(route.touchesDeviceData).toBe(true);
    expect(route.usesSiteScopeGate).toBe(false);
  });

  it('does NOT flag a handler that never touches device-scoped data', () => {
    const src = `
      router.get('/settings', async (c) => {
        return c.json(await db.select().from(orgSettings).where(eq(orgSettings.orgId, auth.orgId)));
      });
    `;
    const route = analyzeRouteSource('routes/x.ts', src, DEVICE_TABLES)[0]!;
    expect(route.touchesDeviceData).toBe(false);
  });

  it('resolves a site gate reached via a file-local helper wrapper', () => {
    // Top-level helper declared at column 0, as in real route files
    // (findLocalGateWrappers anchors helper declarations to line start).
    const src = [
      `function assertDeviceSite(c, id) { return canAccessSite(c.get('permissions'), id); }`,
      `router.get('/activity', async (c) => {`,
      `  const { deviceId } = c.req.query();`,
      `  assertDeviceSite(c, deviceId);`,
      `  return c.json(await db.select().from(peripheralEvents).where(eq(peripheralEvents.deviceId, deviceId)));`,
      `});`,
    ].join('\n');
    const route = analyzeRouteSource('routes/x.ts', src, DEVICE_TABLES)[0]!;
    expect(route.touchesDeviceData).toBe(true);
    expect(route.usesSiteScopeGate).toBe(true);
  });
});

describe('analyzeRouteSource — dead permissions-sourced site gate detector', () => {
  // The vulnerability class: a handler gates site access with the fail-open
  // idiom `if (perms?.allowedSiteIds && !canAccessSite(perms, …))` where
  // `perms = c.get('permissions')`. That context value is populated ONLY by
  // `requirePermission` middleware (auth.ts) — never by `authMiddleware` /
  // `requireScope`. With no live source, `perms` is `undefined`, the guard is
  // skipped, and a site-restricted user reads/writes out-of-site devices. The
  // existing scanner passes these because they DO reference `canAccessSite` /
  // `allowedSiteIds`; this flag catches that the gate is never actually live.

  it('flags a direct fail-open perms gate with no requirePermission in the chain', () => {
    const src = [
      `router.get(`,
      `  '/:deviceId/posture',`,
      `  requireScope('organization', 'partner', 'system'),`,
      `  async (c) => {`,
      `    const perms = c.get('permissions') as UserPermissions | undefined;`,
      `    if (perms?.allowedSiteIds && (typeof device.siteId !== 'string' || !canAccessSite(perms, device.siteId))) {`,
      `      return c.json({ error: 'Access to this site denied' }, 403);`,
      `    }`,
      `    return c.json(await getPosture(device.id));`,
      `  }`,
      `);`,
    ].join('\n');
    const route = analyzeRouteSource('routes/x.ts', src, DEVICE_TABLES)[0]!;
    expect(route.sitePermsGateDead).toBe(true);
  });

  it('does NOT flag when requirePermission is in the middleware chain (perms is live)', () => {
    const src = [
      `router.get(`,
      `  '/:deviceId/posture',`,
      `  requireScope('organization', 'partner', 'system'),`,
      `  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),`,
      `  async (c) => {`,
      `    const perms = c.get('permissions') as UserPermissions | undefined;`,
      `    if (perms?.allowedSiteIds && !canAccessSite(perms, device.siteId)) {`,
      `      return c.json({ error: 'Access to this site denied' }, 403);`,
      `    }`,
      `    return c.json(await getPosture(device.id));`,
      `  }`,
      `);`,
    ].join('\n');
    const route = analyzeRouteSource('routes/x.ts', src, DEVICE_TABLES)[0]!;
    expect(route.sitePermsGateDead).toBe(false);
  });

  it('does NOT flag when a getUserPermissions fallback makes the read live', () => {
    // The security/{posture,status,threats} pattern (#900): reads
    // c.get('permissions') but fetches it itself if the middleware didn't.
    const src = [
      `router.get(`,
      `  '/:deviceId/status',`,
      `  requireScope('organization', 'partner', 'system'),`,
      `  async (c) => {`,
      `    let perms = c.get('permissions') as UserPermissions | undefined;`,
      `    if (!perms) {`,
      `      const fetched = await getUserPermissions(auth.user.id, { orgId: auth.orgId });`,
      `      perms = fetched || undefined;`,
      `    }`,
      `    if (perms?.allowedSiteIds && !canAccessSite(perms, device.siteId)) {`,
      `      return c.json({ error: 'Access to this site denied' }, 403);`,
      `    }`,
      `    return c.json(status);`,
      `  }`,
      `);`,
    ].join('\n');
    const route = analyzeRouteSource('routes/x.ts', src, DEVICE_TABLES)[0]!;
    expect(route.sitePermsGateDead).toBe(false);
  });

  it('flags a perms gate reached via a file-local helper with no requirePermission', () => {
    // The tunnels.ts pattern: getDeviceForTunnel reads c.get('permissions')
    // and gates on canAccessSite; the calling route has only requireScope.
    const src = [
      `async function getDeviceForX(c, deviceId, auth) {`,
      `  const [device] = await db.select().from(devices).where(eq(devices.id, deviceId)).limit(1);`,
      `  if (!device) return null;`,
      `  if (!auth.canAccessOrg(device.orgId)) return null;`,
      `  const permissions = c.get('permissions') as UserPermissions | undefined;`,
      `  if (permissions?.allowedSiteIds && (typeof device.siteId !== 'string' || !canAccessSite(permissions, device.siteId))) {`,
      `    return 'SITE_ACCESS_DENIED';`,
      `  }`,
      `  return device;`,
      `}`,
      `router.get(`,
      `  '/:id',`,
      `  requireScope('organization', 'partner', 'system'),`,
      `  async (c) => {`,
      `    const device = await getDeviceForX(c, c.req.param('id'), auth);`,
      `    return c.json(device);`,
      `  }`,
      `);`,
    ].join('\n');
    const route = analyzeRouteSource('routes/x.ts', src, DEVICE_TABLES).find(
      (r) => r.id === "routes/x.ts:GET /:id",
    )!;
    expect(route.sitePermsGateDead).toBe(true);
  });

  it('does NOT flag the same helper-gated route when requirePermission is present', () => {
    const src = [
      `async function getDeviceForX(c, deviceId, auth) {`,
      `  const permissions = c.get('permissions') as UserPermissions | undefined;`,
      `  if (permissions?.allowedSiteIds && !canAccessSite(permissions, device.siteId)) {`,
      `    return 'SITE_ACCESS_DENIED';`,
      `  }`,
      `  return device;`,
      `}`,
      `router.post(`,
      `  '/',`,
      `  requireScope('organization', 'partner', 'system'),`,
      `  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),`,
      `  async (c) => {`,
      `    const device = await getDeviceForX(c, body.deviceId, auth);`,
      `    return c.json(device);`,
      `  }`,
      `);`,
    ].join('\n');
    const route = analyzeRouteSource('routes/x.ts', src, DEVICE_TABLES).find(
      (r) => r.id === "routes/x.ts:POST /",
    )!;
    expect(route.sitePermsGateDead).toBe(false);
  });

  it('does NOT flag when a requirePermission-bound middleware const is in the chain', () => {
    // Real-world idiom: routes use `const requireXRead = requirePermission(…)`
    // and put `requireXRead` in the chain. That populates c.get('permissions')
    // exactly like inline requirePermission — so the gate is live.
    const src = [
      `const requireMonitorRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);`,
      `router.get(`,
      `  '/',`,
      `  requireScope('organization', 'partner', 'system'),`,
      `  requireMonitorRead,`,
      `  async (c) => {`,
      `    const perms = c.get('permissions') as UserPermissions | undefined;`,
      `    if (perms?.allowedSiteIds && !canAccessSite(perms, asset.siteId)) return c.json({}, 403);`,
      `    return c.json(results);`,
      `  }`,
      `);`,
    ].join('\n');
    const route = analyzeRouteSource('routes/x.ts', src, DEVICE_TABLES).find(
      (r) => r.id === "routes/x.ts:GET /",
    )!;
    expect(route.sitePermsGateDead).toBe(false);
  });

  it('does NOT flag when requireSiteAccess middleware is in the chain', () => {
    // requireSiteAccess self-resolves perms (getUserPermissions fallback) and
    // does its own canAccessSite check — so the route is gated live.
    const src = [
      `router.get(`,
      `  '/sites/:siteId/report',`,
      `  requireScope('organization', 'partner', 'system'),`,
      `  requireSiteAccess('siteId'),`,
      `  async (c) => {`,
      `    const perms = c.get('permissions');`,
      `    if (perms?.allowedSiteIds && !canAccessSite(perms, siteId)) return c.json({}, 403);`,
      `    return c.json(report);`,
      `  }`,
      `);`,
    ].join('\n');
    const route = analyzeRouteSource('routes/x.ts', src, DEVICE_TABLES)[0]!;
    expect(route.sitePermsGateDead).toBe(false);
  });

  it('does NOT flag a fail-closed helper that throws when perms is missing', () => {
    // The getDeviceWithOrgAndSiteCheck pattern: throws 500 if perms absent, so
    // a missing requirePermission breaks the request rather than silently
    // granting cross-site access — not a security hole.
    const src = [
      `async function getDeviceChecked(c, deviceId, auth) {`,
      `  const userPerms = c.get('permissions') as UserPermissions | undefined;`,
      `  if (!userPerms) {`,
      `    throw new HTTPException(500, { message: 'called without requirePermission middleware' });`,
      `  }`,
      `  if (!userPerms.allowedSiteIds) return device;`,
      `  if (!canAccessSite(userPerms, device.siteId)) return SITE_ACCESS_DENIED;`,
      `  return device;`,
      `}`,
      `router.get(`,
      `  '/:deviceId',`,
      `  requireScope('organization', 'partner', 'system'),`,
      `  async (c) => {`,
      `    const device = await getDeviceChecked(c, c.req.param('deviceId'), auth);`,
      `    return c.json(device);`,
      `  }`,
      `);`,
    ].join('\n');
    const route = analyzeRouteSource('routes/x.ts', src, DEVICE_TABLES).find(
      (r) => r.id === "routes/x.ts:GET /:deviceId",
    )!;
    expect(route.sitePermsGateDead).toBe(false);
  });

  it('does NOT flag a plain org-only handler with no perms-sourced site gate', () => {
    const src = `
      router.get('/settings', async (c) => {
        return c.json(await db.select().from(orgSettings).where(eq(orgSettings.orgId, auth.orgId)));
      });
    `;
    const route = analyzeRouteSource('routes/x.ts', src, DEVICE_TABLES)[0]!;
    expect(route.sitePermsGateDead).toBe(false);
  });
});

describe('analyzeRouteSource — non-user-session auth guard detection', () => {
  it('flags a file mounting a non-user auth guard (helperAuth)', () => {
    const src = [
      `helperRoutes.use('*', helperAuth);`,
      `helperRoutes.get('/chat/sessions', async (c) => c.json([]));`,
    ].join('\n');
    const route = analyzeRouteSource('routes/helper/index.ts', src, DEVICE_TABLES)[0]!;
    expect(route.referencesNonUserAuthGuard).toBe(true);
  });

  it('does NOT flag a file guarded only by the user authMiddleware', () => {
    const src = [
      `mobileRoutes.use('*', authMiddleware);`,
      `mobileRoutes.post('/devices', async (c) => c.json({}));`,
    ].join('\n');
    const route = analyzeRouteSource('routes/mobile.ts', src, DEVICE_TABLES)[0]!;
    expect(route.referencesNonUserAuthGuard).toBe(false);
  });

  it('treats the routes/agents/ tree as non-user auth (mounted at agents/index.ts)', () => {
    // Sub-files rely on the parent agentAuthMiddleware mount and reference no
    // guard token themselves.
    const src = `changesRoutes.put('/:id/changes', async (c) => c.json({}));`;
    const route = analyzeRouteSource('routes/agents/changes.ts', src, DEVICE_TABLES)[0]!;
    expect(route.referencesNonUserAuthGuard).toBe(true);
  });

  it('flags agent-role, viewer-token, portal, and platform-admin guards', () => {
    for (const guard of ['requireAgentRole', 'requireViewerToken', "c.get('portalAuth')", 'platformAdminMiddleware']) {
      const src = `${guard}\nr.get('/x', async (c) => c.json([]));`;
      const route = analyzeRouteSource('routes/x.ts', src, DEVICE_TABLES)[0]!;
      expect(route.referencesNonUserAuthGuard, guard).toBe(true);
    }
  });

  it('treats the routes/admin/ tree as non-user auth (platformAdminMiddleware at admin/index.ts)', () => {
    const src = `abuseRoutes.post('/partners/:id/suspend-for-abuse', async (c) => c.json({}));`;
    const route = analyzeRouteSource('routes/admin/abuse.ts', src, DEVICE_TABLES)[0]!;
    expect(route.referencesNonUserAuthGuard).toBe(true);
  });

  it('does NOT flag on a bare users.isPlatformAdmin column reference outside routes/admin/', () => {
    // The column/context field is not an auth guard — a user-session route that
    // merely reads it must not pass the re-verification (regression guard).
    const src = [
      `mcpRoutes.use('*', apiKeyAuthMiddleware);`,
      `mcpRoutes.get('/x', async (c) => { const a = users.isPlatformAdmin; return c.json([]); });`,
    ].join('\n');
    const route = analyzeRouteSource('routes/mcpServer.ts', src, DEVICE_TABLES)[0]!;
    expect(route.referencesNonUserAuthGuard).toBe(false);
  });
});

describe('findDeviceScopedTables — schema-derived table set', () => {
  it('includes known device/site-scoped tables', async () => {
    const tables = await findDeviceScopedTables();
    expect(tables.has('browserExtensions')).toBe(true);
    expect(tables.has('peripheralEvents')).toBe(true);
    expect(tables.has('deviceMetrics')).toBe(true);
  });

  it('excludes a clearly org-only table (organizations)', async () => {
    const tables = await findDeviceScopedTables();
    expect(tables.has('organizations')).toBe(false);
  });
});
