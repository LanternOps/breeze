import { describe, expect, it } from 'vitest';
import { PERMISSION_GRANTS } from '@breeze/shared';
import { resolveBootstrapAdminConfig, DEFAULT_PERMISSIONS, SYSTEM_ROLES } from './seed';

describe('resolveBootstrapAdminConfig', () => {
  it('keeps the development convenience admin when no explicit bootstrap env is set', () => {
    expect(resolveBootstrapAdminConfig({ NODE_ENV: 'development' })).toEqual({
      email: 'admin@breeze.local',
      name: 'Breeze Admin',
      password: 'BreezeAdmin123!',
      logPassword: true,
    });
  });

  it('uses explicit development bootstrap credentials without logging the password', () => {
    expect(
      resolveBootstrapAdminConfig({
        NODE_ENV: 'development',
        BREEZE_BOOTSTRAP_ADMIN_EMAIL: 'dev-admin@example.test',
        BREEZE_BOOTSTRAP_ADMIN_PASSWORD: 'local-only-credential',
        BREEZE_BOOTSTRAP_ADMIN_NAME: 'Dev Admin',
      }),
    ).toEqual({
      email: 'dev-admin@example.test',
      name: 'Dev Admin',
      password: 'local-only-credential',
      logPassword: false,
    });
  });

  it('fails production bootstrap without operator-provided admin material', () => {
    expect(() => resolveBootstrapAdminConfig({ NODE_ENV: 'production' })).toThrow(
      'Production bootstrap requires BREEZE_BOOTSTRAP_ADMIN_EMAIL',
    );
  });

  it('rejects the development default admin identity in production', () => {
    expect(() =>
      resolveBootstrapAdminConfig({
        NODE_ENV: 'production',
        BREEZE_BOOTSTRAP_ADMIN_EMAIL: 'admin@breeze.local',
        BREEZE_BOOTSTRAP_ADMIN_PASSWORD: 'a-production-credential-32-chars',
      }),
    ).toThrow('development default admin address');
  });

  it('rejects the development default admin password in production', () => {
    expect(() =>
      resolveBootstrapAdminConfig({
        NODE_ENV: 'production',
        BREEZE_BOOTSTRAP_ADMIN_EMAIL: 'owner@example.test',
        BREEZE_BOOTSTRAP_ADMIN_PASSWORD: 'BreezeAdmin123!',
      }),
    ).toThrow('development default password');
  });

  it('rejects placeholder bootstrap passwords in production', () => {
    expect(() =>
      resolveBootstrapAdminConfig({
        NODE_ENV: 'production',
        BREEZE_BOOTSTRAP_ADMIN_EMAIL: 'owner@example.test',
        BREEZE_BOOTSTRAP_ADMIN_PASSWORD: 'generate-a-one-time-bootstrap-password',
      }),
    ).toThrow('generated one-time secret');
  });

  it('accepts production bootstrap credentials without allowing password logging', () => {
    expect(
      resolveBootstrapAdminConfig({
        NODE_ENV: 'production',
        BREEZE_BOOTSTRAP_ADMIN_EMAIL: 'owner@example.test',
        BREEZE_BOOTSTRAP_ADMIN_PASSWORD: 'operator-generated-credential-32-chars',
        BREEZE_BOOTSTRAP_ADMIN_NAME: 'Owner Admin',
      }),
    ).toEqual({
      email: 'owner@example.test',
      name: 'Owner Admin',
      password: 'operator-generated-credential-32-chars',
      logPassword: false,
    });
  });
});

describe('SYSTEM_ROLES ⊆ DEFAULT_PERMISSIONS', () => {
  // seedRoles() looks each role permission up in a Map built from the rows
  // seedPermissions() inserted from DEFAULT_PERMISSIONS. A permission a role
  // references but DEFAULT_PERMISSIONS omits is silently dropped at seed time
  // (a console.warn + continue), producing a partial grant set with no surfaced
  // error. This pure-data invariant converts that silent runtime partial-grant
  // into a failing test.
  //
  // Scope note: this asserts the SECURITY-relevant direction only — every
  // permission a system role grants must be seeded. The reverse is NOT asserted:
  // DEFAULT_PERMISSIONS (and the shared PERMISSION_GRANTS registry) may legitimately
  // be a superset, defining permissions no system role grants yet (e.g.
  // time_entries:*, automations:* live in the registry but aren't seeded because
  // no system role references them). A registry/seed superset is fine; an
  // unseeded role grant is the bug.
  const seededKeys = new Set(
    DEFAULT_PERMISSIONS.map((p) => `${p.resource}:${p.action}`),
  );

  for (const role of SYSTEM_ROLES) {
    for (const permKey of role.permissions) {
      // The wildcard grant is matched at authorization time (resource '*',
      // action '*'), not looked up as a literal in DEFAULT_PERMISSIONS — but it
      // IS seeded as the '*:*' row, so it's present anyway. Skip it explicitly
      // to keep intent clear.
      if (permKey === '*:*') continue;

      it(`role "${role.name}" grant "${permKey}" exists in DEFAULT_PERMISSIONS`, () => {
        expect(seededKeys.has(permKey)).toBe(true);
      });
    }
  }

  it('every DEFAULT_PERMISSIONS entry is a unique resource:action', () => {
    const keys = DEFAULT_PERMISSIONS.map((p) => `${p.resource}:${p.action}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('ticket mailbox permissions', () => {
  it('registers and seeds the ticket mailbox permissions', () => {
    expect(PERMISSION_GRANTS.TICKET_MAILBOX_READ).toEqual({ resource: 'ticket_mailbox', action: 'read' });
    expect(PERMISSION_GRANTS.TICKET_MAILBOX_ADMIN).toEqual({ resource: 'ticket_mailbox', action: 'admin' });
    expect(DEFAULT_PERMISSIONS).toEqual(expect.arrayContaining([
      expect.objectContaining({ resource: 'ticket_mailbox', action: 'read' }),
      expect.objectContaining({ resource: 'ticket_mailbox', action: 'admin' }),
    ]));
  });

  it('grants mailbox read to partner technicians/viewers but not mailbox admin', () => {
    for (const roleName of ['Partner Technician', 'Partner Viewer']) {
      const role = SYSTEM_ROLES.find((candidate) => candidate.name === roleName)!;
      expect(role.permissions).toContain('ticket_mailbox:read');
      expect(role.permissions).not.toContain('ticket_mailbox:admin');
    }
  });
});

describe('vulnerability risk-acceptance RBAC', () => {
  const byName = (name: string) => SYSTEM_ROLES.find((r) => r.name === name);

  it('defines vulnerabilities:accept_risk in DEFAULT_PERMISSIONS', () => {
    expect(
      DEFAULT_PERMISSIONS.some(
        (p) => p.resource === 'vulnerabilities' && p.action === 'accept_risk',
      ),
    ).toBe(true);
  });

  it('grants vulnerabilities:accept_risk to Org Admin', () => {
    expect(byName('Org Admin')?.permissions).toContain('vulnerabilities:accept_risk');
  });

  it('does NOT grant vulnerabilities:accept_risk to Org Technician', () => {
    expect(byName('Org Technician')?.permissions).not.toContain('vulnerabilities:accept_risk');
  });

  it('does NOT grant vulnerabilities:accept_risk to Org Viewer', () => {
    expect(byName('Org Viewer')?.permissions).not.toContain('vulnerabilities:accept_risk');
  });

  it('seeds an org-scope Security Approver role with minimal perms', () => {
    const role = byName('Security Approver');
    expect(role?.scope).toBe('organization');
    expect(role?.permissions).toEqual(['devices:read', 'vulnerabilities:accept_risk']);
  });

  it('seeds a partner-scope Partner Security Approver role with minimal perms', () => {
    const role = byName('Partner Security Approver');
    expect(role?.scope).toBe('partner');
    expect(role?.permissions).toEqual([
      'devices:read',
      'organizations:read',
      'vulnerabilities:accept_risk',
    ]);
  });
});

describe('approvals:decide permission (action intents approval layer, §4)', () => {
  const byName = (name: string) => SYSTEM_ROLES.find((r) => r.name === name);

  it('defines approvals:decide in DEFAULT_PERMISSIONS', () => {
    expect(
      DEFAULT_PERMISSIONS.some(
        (p) => p.resource === 'approvals' && p.action === 'decide',
      ),
    ).toBe(true);
  });

  it('registers approvals:decide in the shared PERMISSION_GRANTS registry', () => {
    expect(PERMISSION_GRANTS.APPROVALS_DECIDE).toEqual({ resource: 'approvals', action: 'decide' });
  });

  it('grants approvals:decide to Org Admin', () => {
    expect(byName('Org Admin')?.permissions).toContain('approvals:decide');
  });

  it('does NOT grant approvals:decide to Org Technician', () => {
    expect(byName('Org Technician')?.permissions).not.toContain('approvals:decide');
  });

  it('does NOT grant approvals:decide to Org Viewer', () => {
    expect(byName('Org Viewer')?.permissions).not.toContain('approvals:decide');
  });

  it('Partner Admin covers approvals:decide via the wildcard grant (does not need a redundant literal entry)', () => {
    const role = byName('Partner Admin');
    expect(role?.permissions).toContain('*:*');
    expect(role?.permissions).not.toContain('approvals:decide');
  });
});

describe('topology:write permission (issue #1728)', () => {
  it('topology:write is a seeded permission', () => {
    const keys = DEFAULT_PERMISSIONS.map((p) => `${p.resource}:${p.action}`);
    expect(keys).toContain('topology:write');
  });

  it('topology:read is a seeded permission', () => {
    const keys = DEFAULT_PERMISSIONS.map((p) => `${p.resource}:${p.action}`);
    expect(keys).toContain('topology:read');
  });

  // SYSTEM_ROLES must grant the SAME topology permissions as the role-grant
  // migration 2026-06-29-b-topology-write-permission.sql so fresh-seeded and
  // migrated DBs converge. Reconciled set: read+write to Org Admin / Org
  // Technician / Partner Admin; read to Org Viewer / Partner Technician.
  it('Org Admin carries topology read+write', () => {
    const role = SYSTEM_ROLES.find((r) => r.name === 'Org Admin');
    expect(role?.permissions).toEqual(expect.arrayContaining(['topology:read', 'topology:write']));
  });

  it('Org Technician carries topology read+write (matches the migration)', () => {
    const role = SYSTEM_ROLES.find((r) => r.name === 'Org Technician');
    expect(role?.permissions).toEqual(expect.arrayContaining(['topology:read', 'topology:write']));
  });

  it('Org Viewer carries topology:read only (matches the migration)', () => {
    const role = SYSTEM_ROLES.find((r) => r.name === 'Org Viewer');
    expect(role?.permissions).toContain('topology:read');
    expect(role?.permissions).not.toContain('topology:write');
  });

  it('Partner Technician carries topology:read only (matches the migration)', () => {
    const role = SYSTEM_ROLES.find((r) => r.name === 'Partner Technician');
    expect(role?.permissions).toContain('topology:read');
    expect(role?.permissions).not.toContain('topology:write');
  });

  it('Partner Admin covers topology via the wildcard grant', () => {
    const role = SYSTEM_ROLES.find((r) => r.name === 'Partner Admin');
    expect(role?.permissions).toContain('*:*');
  });
});
