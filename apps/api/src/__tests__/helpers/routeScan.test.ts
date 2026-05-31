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
