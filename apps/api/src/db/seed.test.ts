import { describe, expect, it } from 'vitest';
import { resolveBootstrapAdminConfig } from './seed';

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
