import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildClearM365ActionsConsentBindingCookie,
  buildClearM365ConsentBindingCookie,
  buildM365ActionsConsentBindingCookie,
  buildM365ConsentBindingCookie,
  inspectM365ActionsConsentBindingCookie,
  inspectM365ConsentBindingCookie,
  verifyM365ActionsConsentBindingCookie,
  verifyM365ConsentBindingCookie,
} from './browserBinding';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ADMIN_BINDING = {
  phase: 'admin_consent' as const,
  rawState: 'raw-state',
  connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  consentAttemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  tenantId: TENANT,
};
const IDENTITY_BINDING = {
  ...ADMIN_BINDING,
  phase: 'identity_verification' as const,
  tenantId: null,
};

/**
 * Mints a cookie exactly as the pre-identity-first (v1) code did: same
 * base64url payload + HMAC construction, v1 HMAC context, `tenantHint` key.
 */
function signWithContext(
  cookieName: string,
  context: string,
  payload: Record<string, unknown>,
  key: string,
): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = createHmac('sha256', key).update(`${context}.${encoded}`).digest('base64url');
  return `${cookieName}=${encodeURIComponent(`${encoded}.${mac}`)}`;
}

const V1_PAYLOAD = {
  phase: 'admin_consent',
  rawState: 'old-state',
  connectionId: ADMIN_BINDING.connectionId,
  consentAttemptId: ADMIN_BINDING.consentAttemptId,
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

  it('binds the identity phase expected tenant and emits secure/clear cookie attributes', () => {
    const env = { APP_ENCRYPTION_KEY: 'app-key', NODE_ENV: 'production' };
    const binding = { ...IDENTITY_BINDING, tenantId: TENANT };
    const cookie = buildM365ConsentBindingCookie(binding, env);
    expect(cookie).toContain('; Secure');
    expect(verifyM365ConsentBindingCookie(cookieHeader(cookie), env)).toEqual(binding);
    expect(buildClearM365ConsentBindingCookie(env)).toBe(
      'breeze_m365_graph_read_consent=; Path=/api/v1/m365/consent/callback; HttpOnly; SameSite=None; Secure; Max-Age=0',
    );
  });
});

describe('identity-first binding v2', () => {
  const env = { APP_ENCRYPTION_KEY: 'app-key' };

  it('requires a verified tenant on the admin_consent phase and allows null on identity', () => {
    expect(() => buildM365ConsentBindingCookie({ ...ADMIN_BINDING, tenantId: null }, env))
      .toThrow('m365_consent_binding_invalid');
    expect(() => buildM365ConsentBindingCookie({ ...ADMIN_BINDING, tenantId: 'organizations' }, env))
      .toThrow('m365_consent_binding_invalid');
    expect(() => buildM365ConsentBindingCookie(IDENTITY_BINDING, env)).not.toThrow();
    expect(() => buildM365ConsentBindingCookie({ ...IDENTITY_BINDING, tenantId: TENANT }, env)).not.toThrow();
    expect(() => buildM365ConsentBindingCookie({ ...IDENTITY_BINDING, tenantId: 'common' }, env))
      .toThrow('m365_consent_binding_invalid');
  });

  it('round-trips an identity binding pinned to /organizations (null tenant)', () => {
    const cookie = buildM365ConsentBindingCookie(IDENTITY_BINDING, env, new Date(1_000));
    expect(inspectM365ConsentBindingCookie(cookieHeader(cookie), env, new Date(1_001)))
      .toEqual({ status: 'valid', binding: IDENTITY_BINDING });
  });

  it('reports a v1-signed cookie as legacy, not valid', () => {
    const v1 = signWithContext(
      'breeze_m365_graph_read_consent',
      'breeze:m365-customer-graph-read:browser-binding:v1',
      { ...V1_PAYLOAD, expiresAt: 10_000 },
      env.APP_ENCRYPTION_KEY,
    );
    expect(inspectM365ConsentBindingCookie(v1, env, new Date(1_000))).toEqual({ status: 'legacy' });
    expect(verifyM365ConsentBindingCookie(v1, env, new Date(1_000))).toBeNull();
  });

  it('reports an expired v1 cookie as legacy too (restart is the only remedy either way)', () => {
    const v1 = signWithContext(
      'breeze_m365_graph_read_consent',
      'breeze:m365-customer-graph-read:browser-binding:v1',
      { ...V1_PAYLOAD, phase: 'identity_verification', tenantHint: TENANT, expiresAt: 1 },
      env.APP_ENCRYPTION_KEY,
    );
    expect(inspectM365ConsentBindingCookie(v1, env, new Date(1_000_000))).toEqual({ status: 'legacy' });
  });

  it('reports a v1 actions cookie as legacy on the actions instance only', () => {
    const v1Actions = signWithContext(
      'breeze_m365_graph_actions_consent',
      'breeze:m365-customer-graph-actions:browser-binding:v1',
      { ...V1_PAYLOAD, expiresAt: 10_000 },
      env.APP_ENCRYPTION_KEY,
    );
    expect(inspectM365ActionsConsentBindingCookie(v1Actions, env, new Date(1_000))).toEqual({ status: 'legacy' });
    // The READ v1 context signed under the actions cookie name is not legacy for actions.
    const crossProfile = signWithContext(
      'breeze_m365_graph_actions_consent',
      'breeze:m365-customer-graph-read:browser-binding:v1',
      { ...V1_PAYLOAD, expiresAt: 10_000 },
      env.APP_ENCRYPTION_KEY,
    );
    expect(inspectM365ActionsConsentBindingCookie(crossProfile, env, new Date(1_000))).toEqual({ status: 'invalid' });
  });

  it('a v1-context signature under a different key is invalid, not legacy', () => {
    const v1 = signWithContext(
      'breeze_m365_graph_read_consent',
      'breeze:m365-customer-graph-read:browser-binding:v1',
      { ...V1_PAYLOAD, expiresAt: 10_000 },
      'some-other-key',
    );
    expect(inspectM365ConsentBindingCookie(v1, env, new Date(1_000))).toEqual({ status: 'invalid' });
  });

  it('never accepts a v2 read cookie on the actions instance', () => {
    const read = cookieHeader(buildM365ConsentBindingCookie(IDENTITY_BINDING, env, new Date(1_000)));
    const renamed = read.replace('breeze_m365_graph_read_consent=', 'breeze_m365_graph_actions_consent=');
    expect(inspectM365ActionsConsentBindingCookie(renamed, env, new Date(1_001))).toEqual({ status: 'invalid' });
  });
});

describe('M365 actions-profile browser binding', () => {
  it('mints a cookie with the actions cookie name and Path, distinct from the read profile', () => {
    const env = { APP_ENCRYPTION_KEY: 'test-app-encryption-key' };
    const cookie = buildM365ActionsConsentBindingCookie(ADMIN_BINDING, env, new Date(1_000));
    const value = /breeze_m365_graph_actions_consent=([^;]+)/.exec(cookie)?.[1];

    expect(cookie).toContain('breeze_m365_graph_actions_consent=');
    expect(cookie).toContain('Path=/api/v1/m365/actions-consent/callback');
    expect(cookie).not.toContain('Path=/api/v1/m365/consent/callback');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Max-Age=600');
    expect(verifyM365ActionsConsentBindingCookie(
      `breeze_m365_graph_actions_consent=${value}`,
      env,
      new Date(1_001),
    )).toEqual(ADMIN_BINDING);
    expect(buildClearM365ActionsConsentBindingCookie(env)).toBe(
      'breeze_m365_graph_actions_consent=; Path=/api/v1/m365/actions-consent/callback; HttpOnly; SameSite=Lax; Max-Age=0',
    );
  });

  it('never verifies with the read cookie name, even under the correct key', () => {
    const env = { APP_ENCRYPTION_KEY: 'shared-key' };
    // A cookie header using the actions cookie name but built by the READ
    // instance (wrong HMAC context baked into its signature) must not verify
    // against the actions instance, and the actions cookie renamed to the
    // read cookie name must not verify against the read instance either —
    // proving isolation holds on both the cookie name AND the HMAC context,
    // not just Path scoping (which a forged header, unlike a real browser,
    // does not enforce).
    const readCookie = buildM365ConsentBindingCookie(ADMIN_BINDING, env, new Date(1_000));
    const readValue = /breeze_m365_graph_read_consent=([^;]+)/.exec(readCookie)?.[1];
    const actionsCookie = buildM365ActionsConsentBindingCookie(ADMIN_BINDING, env, new Date(1_000));
    const actionsValue = /breeze_m365_graph_actions_consent=([^;]+)/.exec(actionsCookie)?.[1];

    expect(verifyM365ActionsConsentBindingCookie(
      `breeze_m365_graph_actions_consent=${readValue}`,
      env,
      new Date(1_001),
    )).toBeNull();
    expect(verifyM365ConsentBindingCookie(
      `breeze_m365_graph_read_consent=${actionsValue}`,
      env,
      new Date(1_001),
    )).toBeNull();
  });
});
