import { describe, it, expect } from 'vitest';
import {
  analyzeRouteSource,
  findDeviceScopedTables,
  stripComments,
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

  it('resolves a site gate reached via an exported async function helper (tickets pattern)', () => {
    // LOCAL_HELPER_DECL must recognise `export async function` declarations
    // (PR #1238). Modeled on getScopedTicketOr404 in routes/tickets/tickets.ts:
    // exported + async. This fixture inlines the gate token in the helper body.
    const src = [
      `export async function getScopedTicketOr404(auth, id) {`,
      `  if (auth.allowedSiteIds && !(await deviceInSiteScope(auth, deviceId))) return null;`,
      `  return ticket;`,
      `}`,
      `router.get('/:id', async (c) => {`,
      `  const ticket = await getScopedTicketOr404(auth, id);`,
      `  return c.json(await db.select().from(devices).where(eq(devices.deviceId, id)));`,
      `});`,
    ].join('\n');
    const route = analyzeRouteSource('routes/x.ts', src, DEVICE_TABLES)[0]!;
    expect(route.touchesDeviceData).toBe(true);
    expect(route.usesSiteScopeGate).toBe(true);
  });

  it('resolves a site gate when the exported wrapper delegates and the token only appears below it (real tickets.ts shape)', () => {
    // In the REAL routes/tickets/tickets.ts, getScopedTicketOr404 contains no
    // literal gate token — it calls deviceInSiteScope, and the scanner only
    // sees `allowedSiteIds` because the wrapper's scan window runs to the next
    // declaration and so includes the gate helper's docblock/body below it.
    // The scanner does not resolve helper calls transitively, so this window
    // spill is load-bearing: this fixture mirrors that exact two-function
    // shape so a windowing change that breaks it fails here, loudly, instead
    // of only in the site-scope-coverage integration ratchet.
    const src = [
      `export async function getScopedTicketOr404(auth, id) {`,
      `  const ticket = await fetchScoped(auth, id);`,
      `  if (ticket.deviceId && !(await deviceInSiteScope(auth, ticket.deviceId))) return null;`,
      `  return ticket;`,
      `}`,
      `/** Site gate: checks the caller's allowedSiteIds allowlist. */`,
      `async function deviceInSiteScope(auth, deviceId) {`,
      `  if (!auth.allowedSiteIds) return true;`,
      `  return siteAccessCheck(auth.allowedSiteIds)(deviceId);`,
      `}`,
      `router.get('/:id', async (c) => {`,
      `  const ticket = await getScopedTicketOr404(auth, id);`,
      `  return c.json(await db.select().from(devices).where(eq(devices.deviceId, id)));`,
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

  it('does NOT flag when a requirePermission-bound const is mounted file-level via .use(\'*\', …)', () => {
    // The vulnerabilities.ts idiom (#1889): apply the perms middleware once as
    // file-level `router.use('*', requireXRead)` instead of inline per-route.
    // It populates c.get('permissions') for EVERY route, but the `.use(...)` call
    // sits above each per-route slice — so the per-route scan must consult the
    // file-level source or it false-flags the gate as dead.
    const src = [
      `const requireVulnRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);`,
      `router.use('*', authMiddleware);`,
      `router.use('*', requireScope('organization', 'partner', 'system'));`,
      `router.use('*', requireVulnRead);`,
      `router.get(`,
      `  '/',`,
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

  it('STILL flags when the file-level .use() is a non-wildcard path (does not cover all routes)', () => {
    // `.use('/admin', requireXRead)` only mounts on the /admin subtree, so a
    // sibling route reading `permissions` is still ungated — must NOT be
    // suppressed by the file-level source.
    const src = [
      `const requireVulnRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);`,
      `router.use('/admin', requireVulnRead);`,
      `router.get(`,
      `  '/',`,
      `  requireScope('organization', 'partner', 'system'),`,
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
    expect(route.sitePermsGateDead).toBe(true);
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

// ---------------------------------------------------------------------------
// #4019 — comments must not be able to change the scanner's answer.
// ---------------------------------------------------------------------------

/** Filler comment prose of at least `bytes` bytes, as a JSDoc block. */
function commentFiller(bytes: number): string {
  const line = '   * this is explanatory prose that competes with code for the byte budget\n';
  return `  /**\n${line.repeat(Math.ceil(bytes / line.length))}   */\n`;
}

describe('stripComments', () => {
  it('removes line and block comments but keeps every newline', () => {
    const src = ['const a = 1; // trailing', '/* block', '   more */', 'const b = 2;'].join('\n');
    const out = stripComments(src);
    expect(out).not.toContain('trailing');
    expect(out).not.toContain('more');
    expect(out).toContain('const a = 1;');
    expect(out).toContain('const b = 2;');
    // Line structure is the contract that keeps reported line numbers honest.
    expect(out.split('\n').length).toBe(src.split('\n').length);
  });

  it('leaves comment-looking text inside string and template literals alone', () => {
    const src = [
      `const url = 'https://example.com/a//b';`,
      'const t = `path // not a comment ${x /* nor this */} tail`;',
      `const d = "/* still a string */";`,
    ].join('\n');
    const out = stripComments(src);
    expect(out).toContain('https://example.com/a//b');
    expect(out).toContain('path // not a comment');
    expect(out).toContain('/* still a string */');
    // The interpolation IS code, so a comment inside it is stripped.
    expect(out).not.toContain('nor this');
  });

  it('does not let an unescaped slash inside a regex character class open a comment', () => {
    // This shape is common under routes/ (base64 validators) and is exactly how
    // a naive stripper swallows the rest of the file.
    const src = [
      'const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==)?$/;',
      'const keep = eq(deviceMetrics.deviceId, id);',
    ].join('\n');
    const out = stripComments(src);
    expect(out).toContain('BASE64_RE');
    expect(out).toContain('eq(deviceMetrics.deviceId, id)');
  });

  it('keeps a division expression intact', () => {
    const src = 'const half = Math.ceil(total / 3) * 4; const g = canAccessSite(p, s);';
    expect(stripComments(src)).toBe(src);
  });

  it('does not fuse identifiers across an inline block comment', () => {
    expect(stripComments('canAcc/* x */essSite')).toBe('canAcc essSite');
  });

  it('keeps division intact after a closing paren or bracket', () => {
    // `)` and `]` end a VALUE, so a following `/` divides. Getting this wrong
    // would open a phantom regex that swallows code to the next `/`.
    const src = 'const a = (x)/y; const b = arr[0]/2; const g = canAccessSite(p, s);';
    expect(stripComments(src)).toBe(src);
  });

  it('handles an escaped delimiter inside a regex literal', () => {
    const src = ['const RE = /^a\\/b$/;', 'const keep = eq(deviceMetrics.deviceId, id);'].join('\n');
    expect(stripComments(src)).toBe(src);
  });

  it('handles a template interpolation nested inside another template', () => {
    const src = 'const t = `outer ${`inner ${a / b} // tail`} done`;';
    expect(stripComments(src)).toBe(src);
  });

  it('strips a comment inside a NESTED template interpolation', () => {
    const out = stripComments('const t = `o ${`i ${x /* gone */} `} `;');
    expect(out).not.toContain('gone');
    expect(out).toContain('`o ${`i ${x');
  });

  it('does not run past the line end on an unterminated string literal', () => {
    // A stray quote must not turn the rest of the file into string content —
    // that would hide every gate and device reference below it.
    const src = ["const broken = 'oops;", 'const keep = canAccessSite(p, s); // note'].join('\n');
    const out = stripComments(src);
    expect(out).toContain('canAccessSite(p, s);');
    expect(out).not.toContain('note');
  });

  it('strips an unterminated block comment through end of file', () => {
    expect(stripComments('const a = 1;\n/* never closed\nmore prose')).toBe('const a = 1;\n\n');
  });
});

describe('analyzeRouteSource — comments cannot change the answer (#4019)', () => {
  it('still sees device-table access that a long comment pushed past the byte budget', () => {
    // The exact regression from #4019: an explanatory comment inside the handler
    // moves the handler's only device-table reference past HANDLER_SLICE_BYTES.
    // Before the fix the route vanished from findRoutesTouchingDeviceData().
    const src = [
      `router.get('/incidents', async (c) => {`,
      commentFiller(4200),
      `    const { deviceId } = c.req.query();`,
      `    return c.json(await db.select().from(deviceMetrics)`,
      `      .where(eq(deviceMetrics.deviceId, deviceId)));`,
      `  });`,
    ].join('\n');
    expect(src.indexOf('deviceMetrics.deviceId')).toBeGreaterThan(4000);

    const route = analyzeRouteSource('routes/x.ts', src, DEVICE_TABLES)[0]!;
    expect(route.touchesDeviceData).toBe(true);
    expect(route.usesSiteScopeGate).toBe(false);
  });

  it('still sees device-table access sitting past the byte budget in real code', () => {
    // Same class, no comments involved: the data detector reads the whole
    // handler, so a genuinely long handler cannot hide its device access either.
    const filler = '    const pad = computeSomething(auth, request, options);\n'.repeat(90);
    const src = [
      `router.post('/bulk', async (c) => {`,
      filler,
      `    return c.json(await db.select().from(deviceMetrics)`,
      `      .where(inArray(deviceMetrics.deviceId, body.deviceIds)));`,
      `  });`,
    ].join('\n');
    expect(src.indexOf('deviceMetrics.deviceId')).toBeGreaterThan(4000);

    const route = analyzeRouteSource('routes/x.ts', src, DEVICE_TABLES)[0]!;
    expect(route.touchesDeviceData).toBe(true);
  });

  it('does NOT accept a gate name that only appears in a comment', () => {
    const src = [
      `router.get('/extensions', async (c) => {`,
      `    // TODO: call canAccessSite(perms, device.siteId) here before shipping.`,
      `    const { deviceId } = c.req.query();`,
      `    return c.json(await db.select().from(browserExtensions)`,
      `      .where(eq(browserExtensions.deviceId, deviceId)));`,
      `  });`,
    ].join('\n');
    const route = analyzeRouteSource('routes/x.ts', src, DEVICE_TABLES)[0]!;
    expect(route.touchesDeviceData).toBe(true);
    expect(route.usesSiteScopeGate).toBe(false);
  });

  it('does NOT promote a helper to a gate wrapper on a comment mention alone', () => {
    const src = [
      `function loadDevice(id) {`,
      `  // Site access is enforced by canAccessSite in the caller, not here.`,
      `  return db.select().from(devices).where(eq(devices.id, id));`,
      `}`,
      `router.get('/thing/:id', async (c) => {`,
      `  const d = await loadDevice(c.req.param('id'));`,
      `  return c.json(await db.select().from(browserExtensions)`,
      `    .where(eq(browserExtensions.deviceId, d.id)));`,
      `});`,
    ].join('\n');
    const route = analyzeRouteSource('routes/x.ts', src, DEVICE_TABLES)[0]!;
    expect(route.usesSiteScopeGate).toBe(false);
  });

  it('does NOT invent a route from a route definition quoted in a comment', () => {
    const src = [
      `// Replaces the inline \`.get('/download/:os/:arch', handler)\` registration.`,
      `router.get('/download', async (c) => c.json({}));`,
    ].join('\n');
    const routes = analyzeRouteSource('routes/x.ts', src, DEVICE_TABLES);
    expect(routes.map((r) => r.id)).toEqual(['routes/x.ts:GET /download']);
  });

  it('reports the real line number of a route below a long comment block', () => {
    const src = [commentFiller(4200), `router.get('/thing', async (c) => c.json({}));`].join('\n');
    const route = analyzeRouteSource('routes/x.ts', src, DEVICE_TABLES)[0]!;
    const expectedLine = src.slice(0, src.indexOf(`router.get('/thing'`)).split('\n').length;
    expect(route.line).toBe(expectedLine);
  });

  it('reports a perms-sourced site gate that falls past the scanned window', () => {
    const filler = '    const pad = computeSomething(auth, request, options);\n'.repeat(90);
    const src = [
      `router.get('/late-gate', async (c) => {`,
      filler,
      `    const perms = c.get('permissions');`,
      `    if (perms?.allowedSiteIds && !perms.allowedSiteIds.includes(row.siteId)) deny();`,
      `    return c.json(row);`,
      `  });`,
    ].join('\n');
    const route = analyzeRouteSource('routes/x.ts', src, DEVICE_TABLES)[0]!;
    expect(route.handlerWindowTruncated).toBe(true);
    expect(route.permsSiteGateBeyondWindow).toBe(true);
    // The detector itself stayed silent — which is exactly why the flag exists.
    expect(route.sitePermsGateDead).toBe(false);
  });

  it('does not raise the truncation alarm when the window already proves the gate is live', () => {
    const filler = '    const pad = computeSomething(auth, request, options);\n'.repeat(90);
    const src = [
      `router.get('/late-gate', requirePermission(P.r, P.a), async (c) => {`,
      filler,
      `    const perms = c.get('permissions');`,
      `    if (perms?.allowedSiteIds && !perms.allowedSiteIds.includes(row.siteId)) deny();`,
      `    return c.json(row);`,
      `  });`,
    ].join('\n');
    const route = analyzeRouteSource('routes/x.ts', src, DEVICE_TABLES)[0]!;
    expect(route.handlerWindowTruncated).toBe(true);
    expect(route.permsSiteGateBeyondWindow).toBe(false);
  });
});
