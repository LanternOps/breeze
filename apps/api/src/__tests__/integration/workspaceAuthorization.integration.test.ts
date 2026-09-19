/**
 * Real-DB regression coverage for the host-owned Workspace authorization
 * decisions used by the built-in Workspace extension. The extension gateway
 * obtains these grants through getUserPermissions; mocked route tests pin
 * every Workspace method/path decision and the MFA requirement.
 */
import './setup';

import { randomUUID } from 'crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { runOutsideDbContext } from '../../db';
import {
  clearPermissionCache,
  getUserPermissions,
  hasPermission,
} from '../../services/permissions';
import {
  assignUserToPartner,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const WORKSPACE_GRANTS = [
  { resource: 'workspace', action: 'read' },
  { resource: 'workspace', action: 'write' },
  { resource: 'workspace', action: 'credentials' },
  { resource: 'workspace', action: 'execute' },
  { resource: 'devices', action: 'read' },
  { resource: 'devices', action: 'execute' },
] as const;

async function createPartnerPrincipal(
  grants: ReadonlyArray<{ resource: string; action: string }>,
) {
  const suffix = randomUUID();
  const partner = await createPartner({
    name: `Workspace authorization ${suffix}`,
    slug: `workspace-authorization-${suffix}`,
  });
  const user = await createUser({
    partnerId: partner.id,
    email: `workspace-authorization-${suffix}@example.test`,
  });
  const role = await createRole({
    name: `Workspace role ${suffix}`,
    scope: 'partner',
    partnerId: partner.id,
  });
  await grantRolePermissions(role.id, [...grants]);
  await assignUserToPartner(user.id, partner.id, role.id, 'all');
  return { partnerId: partner.id, userId: user.id };
}

async function resolve(fixture: { partnerId: string; userId: string }) {
  return runOutsideDbContext(() =>
    getUserPermissions(fixture.userId, { partnerId: fixture.partnerId }),
  );
}

describe('Workspace authorization grants (breeze_app, real DB)', () => {
  beforeEach(async () => {
    await clearPermissionCache();
  });

  runDb('a read-only partner role receives no implicit Workspace capability', async () => {
    const fixture = await createPartnerPrincipal([
      { resource: 'organizations', action: 'read' },
    ]);

    const permissions = await resolve(fixture);

    expect(permissions).not.toBeNull();
    for (const grant of WORKSPACE_GRANTS) {
      expect(hasPermission(permissions!, grant.resource, grant.action)).toBe(false);
    }
  });

  runDb('an explicitly granted role resolves only its assigned Workspace capabilities', async () => {
    const assigned = [
      { resource: 'workspace', action: 'read' },
      { resource: 'workspace', action: 'write' },
      { resource: 'devices', action: 'read' },
    ] as const;
    const fixture = await createPartnerPrincipal(assigned);

    const permissions = await resolve(fixture);

    expect(permissions).not.toBeNull();
    for (const grant of assigned) {
      expect(hasPermission(permissions!, grant.resource, grant.action)).toBe(true);
    }
    expect(hasPermission(permissions!, 'workspace', 'credentials')).toBe(false);
    expect(hasPermission(permissions!, 'workspace', 'execute')).toBe(false);
    expect(hasPermission(permissions!, 'devices', 'execute')).toBe(false);
  });

  runDb('the existing wildcard administrator grant remains compatible', async () => {
    const fixture = await createPartnerPrincipal([{ resource: '*', action: '*' }]);

    const permissions = await resolve(fixture);

    expect(permissions).not.toBeNull();
    for (const grant of WORKSPACE_GRANTS) {
      expect(hasPermission(permissions!, grant.resource, grant.action)).toBe(true);
    }
  });
});
