import { describe, expect, it } from 'vitest';
import {
  UNSAFE_DB_ROLE_OPT_OUT_ENV,
  formatUnsafeRequestDatabaseRoleMessage,
  isUnsafeDbRoleOptOutEnabled,
  unsafeRequestDatabaseRoleCapabilities,
} from './requestDatabaseRoleSafety';

describe('unsafeRequestDatabaseRoleCapabilities', () => {
  it('reports nothing for an unprivileged role', () => {
    expect(
      unsafeRequestDatabaseRoleCapabilities({
        currentUser: 'breeze_app',
        isSuperuser: false,
        bypassesRls: false,
      }),
    ).toEqual([]);
  });

  it('reports both capabilities when the role has both', () => {
    expect(
      unsafeRequestDatabaseRoleCapabilities({
        currentUser: 'breeze',
        isSuperuser: true,
        bypassesRls: true,
      }),
    ).toEqual(['SUPERUSER', 'BYPASSRLS']);
  });

  it('reports BYPASSRLS alone for a NOSUPERUSER BYPASSRLS role', () => {
    expect(
      unsafeRequestDatabaseRoleCapabilities({
        currentUser: 'breeze_reporting',
        isSuperuser: false,
        bypassesRls: true,
      }),
    ).toEqual(['BYPASSRLS']);
  });
});

describe('isUnsafeDbRoleOptOutEnabled', () => {
  it('is disabled when unset, empty, or falsey-looking', () => {
    for (const value of [undefined, '', '   ', 'false', '0', 'no', 'off', 'maybe']) {
      const env = value === undefined ? {} : { [UNSAFE_DB_ROLE_OPT_OUT_ENV]: value };
      expect(isUnsafeDbRoleOptOutEnabled(env)).toBe(false);
    }
  });

  it('is enabled for the explicit truthy spellings', () => {
    for (const value of ['true', 'TRUE', ' True ', '1', 'yes', 'on']) {
      expect(isUnsafeDbRoleOptOutEnabled({ [UNSAFE_DB_ROLE_OPT_OUT_ENV]: value })).toBe(true);
    }
  });
});

describe('formatUnsafeRequestDatabaseRoleMessage', () => {
  const role = { currentUser: 'breeze', isSuperuser: true, bypassesRls: true };

  it('names the role, both capabilities and the remediation', () => {
    const message = formatUnsafeRequestDatabaseRoleMessage(role, ['SUPERUSER', 'BYPASSRLS']);
    expect(message).toContain('"breeze"');
    expect(message).toContain('SUPERUSER and BYPASSRLS');
    expect(message).toContain('DATABASE_URL_APP');
  });

  it('names the opt-out env var when asked to advertise it', () => {
    const message = formatUnsafeRequestDatabaseRoleMessage(role, ['SUPERUSER'], {
      advertiseOptOut: true,
    });
    expect(message).toContain(UNSAFE_DB_ROLE_OPT_OUT_ENV);
  });

  it('omits the opt-out by default so the thrown assertion stays a hard no', () => {
    expect(formatUnsafeRequestDatabaseRoleMessage(role, ['SUPERUSER'])).not.toContain(
      UNSAFE_DB_ROLE_OPT_OUT_ENV,
    );
  });
});
