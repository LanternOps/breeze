import { afterEach, describe, expect, it, vi } from 'vitest';

const { emailServiceRef } = vi.hoisted(() => ({ emailServiceRef: { current: null as unknown } }));
vi.mock('../services/email', () => ({ getEmailService: () => emailServiceRef.current }));

import {
  isPortalSelfRegistrationAvailable,
  isPortalSelfRegistrationEnabled,
  parsePortalSelfRegistrationEnabled,
} from './portalSelfRegistration';

afterEach(() => {
  vi.unstubAllEnvs();
  emailServiceRef.current = null;
});

describe('PORTAL_SELF_REGISTRATION_ENABLED (portal registration W6, plan D2)', () => {
  it('unset, true and 1 enable; false and 0 disable; any other value fails validation', () => {
    expect(parsePortalSelfRegistrationEnabled(undefined)).toBe(true);
    expect(parsePortalSelfRegistrationEnabled('')).toBe(true);
    expect(parsePortalSelfRegistrationEnabled('true')).toBe(true);
    expect(parsePortalSelfRegistrationEnabled(' TRUE ')).toBe(true);
    expect(parsePortalSelfRegistrationEnabled('1')).toBe(true);
    expect(parsePortalSelfRegistrationEnabled('false')).toBe(false);
    expect(parsePortalSelfRegistrationEnabled('False')).toBe(false);
    expect(parsePortalSelfRegistrationEnabled('0')).toBe(false);
    for (const bad of ['yes', 'off', 'no', '2', 'enabled']) {
      expect(() => parsePortalSelfRegistrationEnabled(bad)).toThrow(/PORTAL_SELF_REGISTRATION_ENABLED/);
    }
  });

  it('reads the env at call time', () => {
    vi.stubEnv('PORTAL_SELF_REGISTRATION_ENABLED', 'false');
    expect(isPortalSelfRegistrationEnabled()).toBe(false);
    vi.stubEnv('PORTAL_SELF_REGISTRATION_ENABLED', 'true');
    expect(isPortalSelfRegistrationEnabled()).toBe(true);
  });

  it('a malformed value at call time reads as off (boot validation refuses it first)', () => {
    vi.stubEnv('PORTAL_SELF_REGISTRATION_ENABLED', 'maybe');
    expect(isPortalSelfRegistrationEnabled()).toBe(false);
  });

  it('isPortalSelfRegistrationAvailable is false without an email service even when enabled', () => {
    vi.stubEnv('PORTAL_SELF_REGISTRATION_ENABLED', 'true');
    emailServiceRef.current = null;
    expect(isPortalSelfRegistrationAvailable()).toBe(false);
    emailServiceRef.current = {};
    expect(isPortalSelfRegistrationAvailable()).toBe(true);
    vi.stubEnv('PORTAL_SELF_REGISTRATION_ENABLED', '0');
    expect(isPortalSelfRegistrationAvailable()).toBe(false);
  });
});
