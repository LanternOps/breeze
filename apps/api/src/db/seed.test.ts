import { describe, expect, it } from 'vitest';
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
