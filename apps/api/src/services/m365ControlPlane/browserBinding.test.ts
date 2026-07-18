import { describe, expect, it } from 'vitest';
import {
  buildClearM365ConsentBindingCookie,
  buildM365ConsentBindingCookie,
  inspectM365ConsentBindingCookie,
  verifyM365ConsentBindingCookie,
} from './browserBinding';

const ADMIN_BINDING = {
  phase: 'admin_consent' as const,
  rawState: 'raw-state',
  connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  consentAttemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  tenantHint: null,
};

function cookieHeader(setCookie: string): string {
  return setCookie.slice(0, setCookie.indexOf(';'));
}

describe('M365 consent browser binding', () => {
  it('round-trips an admin consent binding through a signed callback cookie', () => {
    const env = { APP_ENCRYPTION_KEY: 'test-app-encryption-key' };
    const cookie = buildM365ConsentBindingCookie(ADMIN_BINDING, env, new Date(1_000));
    const value = /breeze_m365_graph_read_consent=([^;]+)/.exec(cookie)?.[1];

    expect(cookie).toContain('Path=/api/v1/m365/consent/callback');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=600');
    expect(verifyM365ConsentBindingCookie(
      `breeze_m365_graph_read_consent=${value}`,
      env,
      new Date(1_001),
    )).toEqual(ADMIN_BINDING);
  });

  it('uses the first encryption key, never unrelated secrets or defaults', () => {
    const now = new Date('2026-07-14T12:00:00.000Z');
    const appCookie = buildM365ConsentBindingCookie(ADMIN_BINDING, {
      APP_ENCRYPTION_KEY: 'app-key',
      SECRET_ENCRYPTION_KEY: 'secret-key',
    }, now);
    expect(verifyM365ConsentBindingCookie(cookieHeader(appCookie), {
      APP_ENCRYPTION_KEY: 'app-key',
    }, now)).toEqual(ADMIN_BINDING);
    expect(verifyM365ConsentBindingCookie(cookieHeader(appCookie), {
      SECRET_ENCRYPTION_KEY: 'secret-key',
    }, now)).toBeNull();
    expect(() => buildM365ConsentBindingCookie(ADMIN_BINDING, {
      JWT_SECRET: 'jwt',
      AGENT_ENROLLMENT_SECRET: 'enrollment',
    }, now)).toThrow('m365_consent_binding_unavailable');
  });

  it('rejects tampered, duplicated, malformed, and expired cookies', () => {
    const env = { APP_ENCRYPTION_KEY: 'app-key' };
    const issued = new Date('2026-07-14T12:00:00.000Z');
    const header = cookieHeader(buildM365ConsentBindingCookie(ADMIN_BINDING, env, issued));
    const value = header.split('=')[1];
    expect(verifyM365ConsentBindingCookie(`${header.slice(0, -1)}x`, env, issued)).toBeNull();
    expect(verifyM365ConsentBindingCookie(`${header}; ${header}`, env, issued)).toBeNull();
    expect(verifyM365ConsentBindingCookie('breeze_m365_graph_read_consent=bad.payload.extra', env, issued)).toBeNull();
    expect(verifyM365ConsentBindingCookie('breeze_m365_graph_read_consent=e30.AQ', env, issued)).toBeNull();
    expect(verifyM365ConsentBindingCookie(header, env, new Date(issued.getTime() + 600_000))).toBeNull();
    expect(inspectM365ConsentBindingCookie(header, env, new Date(issued.getTime() + 600_000)))
      .toEqual({ status: 'expired' });
    expect(value).not.toContain('raw-state');
  });

  it('binds the identity phase tenant hint and emits secure/clear cookie attributes', () => {
    const env = { APP_ENCRYPTION_KEY: 'app-key', NODE_ENV: 'production' };
    const binding = {
      ...ADMIN_BINDING,
      phase: 'identity_verification' as const,
      tenantHint: '11111111-1111-1111-1111-111111111111',
    };
    const cookie = buildM365ConsentBindingCookie(binding, env);
    expect(cookie).toContain('; Secure');
    expect(verifyM365ConsentBindingCookie(cookieHeader(cookie), env)).toEqual(binding);
    expect(buildClearM365ConsentBindingCookie(env)).toBe(
      'breeze_m365_graph_read_consent=; Path=/api/v1/m365/consent/callback; HttpOnly; SameSite=Lax; Secure; Max-Age=0',
    );
  });
});
