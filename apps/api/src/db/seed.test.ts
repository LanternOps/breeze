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
  // automations:* lives in the registry but isn't seeded because no system role
  // references it). A registry/seed superset is fine; an unseeded role grant is
  // the bug. time_entries:* used to be the example here; #4251 moved it into
  // DEFAULT_PERMISSIONS when Partner Technician started granting it.
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

describe('agent rollback RBAC', () => {
  const byName = (name: string) => SYSTEM_ROLES.find((role) => role.name === name);

  it('seeds agent_rollback:create and grants it explicitly only to Org Admin', () => {
    expect(DEFAULT_PERMISSIONS).toContainEqual(expect.objectContaining({ resource: 'agent_rollback', action: 'create' }));
    expect(byName('Partner Admin')?.permissions).toContain('*:*');
    expect(byName('Org Admin')?.permissions).toContain('agent_rollback:create');
    for (const role of SYSTEM_ROLES.filter((candidate) => !['Partner Admin', 'Org Admin'].includes(candidate.name))) {
      expect(role.permissions).not.toContain('agent_rollback:create');
    }
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

describe('audit:manage permission (audit retention policy settings, #4633)', () => {
  const byName = (name: string) => SYSTEM_ROLES.find((r) => r.name === name);

  it('defines audit:manage in DEFAULT_PERMISSIONS', () => {
    expect(
      DEFAULT_PERMISSIONS.some(
        (p) => p.resource === 'audit' && p.action === 'manage',
      ),
    ).toBe(true);
  });

  it('registers audit:manage in the shared PERMISSION_GRANTS registry', () => {
    expect(PERMISSION_GRANTS.AUDIT_MANAGE).toEqual({ resource: 'audit', action: 'manage' });
  });

  it('grants audit:manage to Org Admin', () => {
    expect(byName('Org Admin')?.permissions).toContain('audit:manage');
  });

  it('does NOT grant audit:manage to Org Technician or Org Viewer', () => {
    expect(byName('Org Technician')?.permissions).not.toContain('audit:manage');
    expect(byName('Org Viewer')?.permissions).not.toContain('audit:manage');
  });

  it('Partner Admin covers audit:manage via the wildcard grant (does not need a redundant literal entry)', () => {
    const role = byName('Partner Admin');
    expect(role?.permissions).toContain('*:*');
    expect(role?.permissions).not.toContain('audit:manage');
  });
});

describe('backup:cross_site_restore permission', () => {
  const byName = (name: string) => SYSTEM_ROLES.find((role) => role.name === name);

  it('registers and seeds the distinct cross-site restore capability', () => {
    expect(PERMISSION_GRANTS.BACKUP_CROSS_SITE_RESTORE).toEqual({
      resource: 'backup',
      action: 'cross_site_restore',
    });
    expect(DEFAULT_PERMISSIONS).toEqual(expect.arrayContaining([
      expect.objectContaining({ resource: 'backup', action: 'cross_site_restore' }),
    ]));
  });

  it('grants cross-site restore only to recovery administrators by default', () => {
    expect(byName('Partner Admin')?.permissions).toContain('*:*');
    expect(byName('Org Admin')?.permissions).toContain('backup:cross_site_restore');

    for (const role of SYSTEM_ROLES) {
      if (role.name === 'Partner Admin' || role.name === 'Org Admin') continue;
      expect(role.permissions).not.toContain('backup:cross_site_restore');
    }
  });

  it('does not broaden ordinary backup:write into cross-site recovery', () => {
    const technician = byName('Partner Technician');
    expect(technician?.permissions).toContain('backup:write');
    expect(technician?.permissions).not.toContain('backup:cross_site_restore');
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

describe('technician ticket + time-entry RBAC (#4251)', () => {
  // #3206 shipped a mobile start/stop timer whose routes require
  // time_entries:write. The seeded technician roles held tickets:read only, so
  // the only grant path (2026-06-12-a-ticketing-time-parts.sql, which
  // propagates time_entries:* off the matching tickets:* perm) gave them
  // time_entries:read and nothing else: the timesheet renders, start/stop 403s.
  // These assertions pin the fix so a later trim of the role can't silently
  // re-break the timer.
  const byName = (name: string) => SYSTEM_ROLES.find((r) => r.name === name);

  it('Partner Technician can update a ticket and log time against it', () => {
    expect(byName('Partner Technician')?.permissions).toEqual(
      expect.arrayContaining(['tickets:read', 'tickets:write', 'time_entries:read', 'time_entries:write']),
    );
  });

  it('Partner Technician does NOT gain tickets:manage', () => {
    // tickets:manage reassigns ticket organization and edits any author's
    // comment — an admin action, deliberately still withheld.
    expect(byName('Partner Technician')?.permissions).not.toContain('tickets:manage');
  });

  it('Partner Viewer stays read-only on tickets and time entries', () => {
    const perms = byName('Partner Viewer')?.permissions ?? [];
    expect(perms).not.toContain('tickets:write');
    expect(perms).not.toContain('time_entries:write');
  });

  it('time_entries:read/write are seeded, or seedRoles silently drops the grant', () => {
    const seeded = new Set(DEFAULT_PERMISSIONS.map((p) => `${p.resource}:${p.action}`));
    expect(seeded.has('time_entries:read')).toBe(true);
    expect(seeded.has('time_entries:write')).toBe(true);
  });
});

describe('system role MFA posture (RMM-QA-164)', () => {
  // The stored roles.force_mfa flag is what services/mfaPolicy.ts reads; the
  // 2026-05-25-f migration only ever flipped rows that existed when it ran,
  // and on a fresh database autoMigrate applies it BEFORE seed(). The seed
  // definition is therefore the source of truth for a fresh install, and it
  // must state the posture of every role explicitly rather than leave the
  // column to its DEFAULT false.
  it('every system role declares forceMfa as a boolean', () => {
    for (const role of SYSTEM_ROLES) {
      expect(typeof role.forceMfa, `role "${role.name}" must declare forceMfa`).toBe('boolean');
    }
  });

  it('forces MFA for Partner Admin and for no other system role (D9: Org Admin stays MSP opt-in)', () => {
    expect(SYSTEM_ROLES.filter((role) => role.forceMfa).map((role) => role.name)).toEqual(['Partner Admin']);
  });
});
