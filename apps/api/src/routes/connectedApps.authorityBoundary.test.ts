import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const routeSource = readFileSync(new URL('./connectedApps.ts', import.meta.url), 'utf8');
const permissionSource = readFileSync(
  new URL('../../../../packages/shared/src/constants/permissions.ts', import.meta.url),
  'utf8',
);

describe('partner connected-app authority boundary', () => {
  it('defines separate read and manage capabilities', () => {
    expect(permissionSource).toContain(
      "CONNECTED_APPS_READ: { resource: 'connected_apps', action: 'read' }",
    );
    expect(permissionSource).toContain(
      "CONNECTED_APPS_MANAGE: { resource: 'connected_apps', action: 'manage' }",
    );
  });

  it('requires partner scope and full-partner authority for the whole router', () => {
    expect(routeSource).toContain("connectedAppsRoutes.use('*', requireScope('partner'))");
    expect(routeSource).toContain(
      "connectedAppsRoutes.use('*', requireFullPartnerConnectedAppAuthority)",
    );
  });

  it('requires connected-app read authority before listing rows', () => {
    expect(routeSource).toMatch(
      /connectedAppsRoutes\.get\(\s*'\/'\s*,\s*requireConnectedAppsRead\s*,/,
    );
  });

  it('requires connected-app management authority and MFA before disconnect effects', () => {
    expect(routeSource).toMatch(
      /connectedAppsRoutes\.delete\(\s*'\/:clientId'\s*,\s*requireConnectedAppsManage\s*,\s*requireMfa\(\)\s*,/,
    );
    const deleteAt = routeSource.indexOf("connectedAppsRoutes.delete(");
    const revokeAt = routeSource.indexOf('revokeClientFamilies(', deleteAt);
    expect(revokeAt).toBeGreaterThan(deleteAt);
  });

  it('retains feature gating and partner-scoped revocation', () => {
    expect(routeSource).toContain('if (MCP_OAUTH_ENABLED)');
    expect(routeSource).toContain(
      "revokeClientFamilies(clientId, { kind: 'partner', partnerId }",
    );
  });
});
