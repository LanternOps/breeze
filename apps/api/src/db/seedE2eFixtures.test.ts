import { describe, expect, it } from 'vitest';
import {
  resolveSeedE2eGuard,
  E2E_MACOS_DEVICE_ID,
  E2E_WINDOWS_DEVICE_ID,
} from './seedE2eFixtures';

describe('resolveSeedE2eGuard', () => {
  it('allows seeding in development', () => {
    expect(resolveSeedE2eGuard({ NODE_ENV: 'development' })).toEqual({ allowed: true });
  });

  it('allows seeding in test', () => {
    expect(resolveSeedE2eGuard({ NODE_ENV: 'test' })).toEqual({ allowed: true });
  });

  it('allows seeding when NODE_ENV is unset', () => {
    expect(resolveSeedE2eGuard({})).toEqual({ allowed: true });
  });

  it('refuses to seed synthetic fixtures in production by default', () => {
    const result = resolveSeedE2eGuard({ NODE_ENV: 'production' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/production/i);
    expect(result.reason).toMatch(/BREEZE_SEED_E2E_FORCE/);
  });

  it('allows production seeding when explicitly forced via the force argument', () => {
    expect(resolveSeedE2eGuard({ NODE_ENV: 'production' }, true)).toEqual({ allowed: true });
  });

  it('allows production seeding when explicitly forced via BREEZE_SEED_E2E_FORCE env', () => {
    expect(
      resolveSeedE2eGuard({ NODE_ENV: 'production', BREEZE_SEED_E2E_FORCE: 'true' }),
    ).toEqual({ allowed: true });
  });

  it('does not treat a non-"true" BREEZE_SEED_E2E_FORCE value as a force', () => {
    const result = resolveSeedE2eGuard({ NODE_ENV: 'production', BREEZE_SEED_E2E_FORCE: '1' });
    expect(result.allowed).toBe(false);
  });
});

describe('e2e fixture device ids', () => {
  it('exposes stable UUIDs matching the legacy seed-fixtures.sql IDs', () => {
    // These IDs are referenced by the e2e .env (E2E_MACOS_DEVICE_ID /
    // E2E_WINDOWS_DEVICE_ID) and the YAML suite. They must not drift.
    expect(E2E_MACOS_DEVICE_ID).toBe('42fc7de0-48f5-48f2-846b-6dd95924baf9');
    expect(E2E_WINDOWS_DEVICE_ID).toBe('e65460f3-413c-4599-a9a6-90ee71bbc4ff');
  });

  it('uses two distinct device ids', () => {
    expect(E2E_MACOS_DEVICE_ID).not.toBe(E2E_WINDOWS_DEVICE_ID);
  });
});
