import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import {
  m365ConsentCallbackRoutes,
  createM365ConsentCallbackRoutes,
  parseM365ConsentCallbackQuery,
} from './m365ConsentCallback';

const CONNECTION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ATTEMPT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function bindingCookie(binding: Record<string, unknown>): string {
  return `binding=${Buffer.from(JSON.stringify(binding)).toString('base64url')}`;
}

function tenantHintHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function attempt(status: 'pending-consent' | 'verifying') {
  return {
    id: CONNECTION_ID,
    orgId: ORG_ID,
    profile: 'customer-graph-read' as const,
    consentAttemptId: ATTEMPT_ID,
    status,
  };
}

describe('M365 consent callback route', () => {
  it('mounts the exact public callback path', async () => {
    const app = new Hono();
    app.route('/api/v1/m365', m365ConsentCallbackRoutes);

    const response = await app.request('/api/v1/m365/consent/callback');

    expect(response.status).not.toBe(404);
  });

  it('accepts only the exact admin and identity success shapes', () => {
    expect(parseM365ConsentCallbackQuery('admin_consent', new URLSearchParams({
      state: 'raw-state',
      tenant: '11111111-1111-1111-1111-111111111111',
      admin_consent: 'true',
    }))).toEqual({
      kind: 'admin_success',
      state: 'raw-state',
      tenantId: '11111111-1111-1111-1111-111111111111',
    });
    expect(parseM365ConsentCallbackQuery('identity_verification', new URLSearchParams({
      state: 'identity-state',
      code: 'authorization-code',
    }))).toEqual({ kind: 'identity_success', state: 'identity-state', code: 'authorization-code' });
  });

  it.each([
    ['duplicate', 'admin_consent', 'state=a&state=b&tenant=11111111-1111-1111-1111-111111111111&admin_consent=true'],
    ['unknown', 'admin_consent', 'state=a&tenant=11111111-1111-1111-1111-111111111111&admin_consent=true&extra=x'],
    ['mixed', 'admin_consent', 'state=a&tenant=11111111-1111-1111-1111-111111111111&admin_consent=true&error=denied'],
    ['missing state', 'identity_verification', 'code=value'],
    ['bad tenant', 'admin_consent', 'state=a&tenant=not-a-guid&admin_consent=true'],
    ['wrong boolean', 'admin_consent', 'state=a&tenant=11111111-1111-1111-1111-111111111111&admin_consent=True'],
    ['extra identity field', 'identity_verification', 'state=a&code=value&tenant=11111111-1111-1111-1111-111111111111'],
  ] as const)('rejects %s callback queries', (_name, phase, raw) => {
    expect(parseM365ConsentCallbackQuery(phase, new URLSearchParams(raw))).toBeNull();
  });

  it('accepts a provider error without exposing its description', () => {
    expect(parseM365ConsentCallbackQuery('identity_verification', new URLSearchParams({
      state: 'state',
      error: 'access_denied',
      error_description: 'sensitive provider text',
    }))).toEqual({ kind: 'provider_error', state: 'state' });
  });

  it('consumes admin state and starts tenant-bound PKCE identity verification', async () => {
    const adminBinding = {
      phase: 'admin_consent' as const,
      rawState: 'admin-state',
      connectionId: CONNECTION_ID,
      consentAttemptId: ATTEMPT_ID,
      tenantHint: null,
    };
    const identityCreated = {
      rawState: 'identity-state',
      codeChallenge: 'pkce-challenge',
      session: { nonce: 'identity-nonce' },
    };
    const consumeSession = vi.fn().mockResolvedValue({ userId: USER_ID });
    const markAdminReturned = vi.fn().mockResolvedValue({ status: 'verifying' });
    const createIdentitySession = vi.fn().mockResolvedValue(identityCreated);
    const buildBindingCookie = vi.fn(() => 'new-binding=identity; Path=/api/v1/m365/consent/callback');
    const routes = createM365ConsentCallbackRoutes({
      verifyBindingCookie: vi.fn(() => adminBinding),
      buildBindingCookie,
      loadAttempt: vi.fn().mockResolvedValue({
        id: CONNECTION_ID,
        orgId: ORG_ID,
        profile: 'customer-graph-read',
        consentAttemptId: ATTEMPT_ID,
        status: 'pending-consent',
      }),
      consumeSession,
      markAdminReturned,
      createIdentitySession,
      loadConfig: vi.fn(() => ({
        clientId: '22222222-2222-2222-2222-222222222222',
        callbackUrl: 'https://breeze.example/api/v1/m365/consent/callback',
      })),
      audit: vi.fn(),
    });
    const app = new Hono().route('/api/v1/m365', routes);

    const response = await app.request(
      `/api/v1/m365/consent/callback?state=admin-state&tenant=${TENANT_ID}&admin_consent=true`,
      { headers: { cookie: bindingCookie(adminBinding) } },
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(
      `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`,
    );
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      state: 'identity-state',
      nonce: 'identity-nonce',
      code_challenge: 'pkce-challenge',
      code_challenge_method: 'S256',
    });
    expect(consumeSession).toHaveBeenCalledWith(expect.objectContaining({
      rawState: 'admin-state',
      phase: 'admin_consent',
      connectionId: CONNECTION_ID,
      orgId: ORG_ID,
      consentAttemptId: ATTEMPT_ID,
    }));
    expect(markAdminReturned).toHaveBeenCalled();
    expect(createIdentitySession).toHaveBeenCalledWith(expect.objectContaining({
      tenantHint: TENANT_ID,
      userId: USER_ID,
    }));
    expect(buildBindingCookie).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'identity_verification',
      rawState: 'identity-state',
      tenantHint: TENANT_ID,
    }));
    expect(response.headers.get('set-cookie')).toContain('new-binding=identity');
  });

  it('completes identity outside state consumption and redirects only to the active fragment', async () => {
    const identityBinding = {
      phase: 'identity_verification' as const,
      rawState: 'identity-state',
      connectionId: CONNECTION_ID,
      consentAttemptId: ATTEMPT_ID,
      tenantHint: TENANT_ID,
    };
    const consumeSession = vi.fn().mockResolvedValue({
      userId: USER_ID,
      tenantHintHash: tenantHintHash(TENANT_ID),
      nonce: 'identity-nonce',
      codeVerifier: 'v'.repeat(43),
    });
    const completeIdentity = vi.fn().mockResolvedValue({
      success: true,
      tenantId: TENANT_ID,
      administratorObjectId: USER_ID,
      applicationId: '22222222-2222-2222-2222-222222222222',
      organizationDisplayName: 'Contoso',
      manifestVersion: 2,
      verifiedAt: '2026-07-14T12:00:00.000Z',
      grantReconciliation: 'complete',
      observedGrants: [],
      missingGrants: [],
      unexpectedGrants: [],
      grantsVerifiedAt: '2026-07-14T12:00:00.000Z',
    });
    const applyIdentityResult = vi.fn().mockResolvedValue({
      status: 'active',
      lastErrorCode: null,
    });
    const audit = vi.fn();
    const routes = createM365ConsentCallbackRoutes({
      verifyBindingCookie: vi.fn(() => identityBinding),
      clearBindingCookie: vi.fn(() => 'binding=; Path=/api/v1/m365/consent/callback; Max-Age=0'),
      loadAttempt: vi.fn().mockResolvedValue(attempt('verifying')),
      consumeSession,
      completeIdentity,
      applyIdentityResult,
      loadConfig: vi.fn(() => ({
        clientId: '22222222-2222-2222-2222-222222222222',
        callbackUrl: 'https://breeze.example/api/v1/m365/consent/callback',
      })),
      correlationId: vi.fn(() => 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
      audit,
    });
    const app = new Hono().route('/api/v1/m365', routes);

    const response = await app.request(
      '/api/v1/m365/consent/callback?state=identity-state&code=secret-authorization-code',
      { headers: { cookie: bindingCookie(identityBinding) } },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/integrations#m365/customer-graph-read/active');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(completeIdentity).toHaveBeenCalledWith({
      correlationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      consentAttemptId: ATTEMPT_ID,
      tenantHint: TENANT_ID,
      authorizationCode: 'secret-authorization-code',
      codeVerifier: 'v'.repeat(43),
      nonce: 'identity-nonce',
      redirectUri: 'https://breeze.example/api/v1/m365/consent/callback',
    });
    expect(applyIdentityResult).toHaveBeenCalledWith(attempt('verifying'), expect.objectContaining({
      success: true,
      tenantId: TENANT_ID,
    }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain('secret-authorization-code');
    expect(JSON.stringify(audit.mock.calls)).not.toContain('identity-nonce');
  });

  it('rejects a tenant-hint hash mismatch after consumption without executor or mutation', async () => {
    const identityBinding = {
      phase: 'identity_verification' as const,
      rawState: 'identity-state',
      connectionId: CONNECTION_ID,
      consentAttemptId: ATTEMPT_ID,
      tenantHint: TENANT_ID,
    };
    const completeIdentity = vi.fn();
    const applyIdentityResult = vi.fn();
    const markAttemptFailed = vi.fn();
    const routes = createM365ConsentCallbackRoutes({
      verifyBindingCookie: vi.fn(() => identityBinding),
      clearBindingCookie: vi.fn(() => 'binding=; Max-Age=0'),
      loadAttempt: vi.fn().mockResolvedValue(attempt('verifying')),
      consumeSession: vi.fn().mockResolvedValue({
        userId: USER_ID,
        tenantHintHash: tenantHintHash('99999999-9999-9999-9999-999999999999'),
        nonce: 'nonce',
        codeVerifier: 'v'.repeat(43),
      }),
      completeIdentity,
      applyIdentityResult,
      markAttemptFailed,
      audit: vi.fn(),
    });
    const app = new Hono().route('/api/v1/m365', routes);

    const response = await app.request(
      '/api/v1/m365/consent/callback?state=identity-state&code=code',
      { headers: { cookie: bindingCookie(identityBinding) } },
    );

    expect(response.headers.get('location')).toBe('/integrations#m365/customer-graph-read/tenant_mismatch');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(completeIdentity).not.toHaveBeenCalled();
    expect(applyIdentityResult).not.toHaveBeenCalled();
    expect(markAttemptFailed).not.toHaveBeenCalled();
  });

  it('validates the browser binding before loading or consuming state', async () => {
    const loadAttempt = vi.fn();
    const consumeSession = vi.fn();
    const routes = createM365ConsentCallbackRoutes({
      verifyBindingCookie: vi.fn(() => null),
      clearBindingCookie: vi.fn(() => 'binding=; Max-Age=0'),
      loadAttempt,
      consumeSession,
    });
    const app = new Hono().route('/api/v1/m365', routes);

    const response = await app.request(
      `/api/v1/m365/consent/callback?state=state&tenant=${TENANT_ID}&admin_consent=true`,
    );

    expect(response.headers.get('location')).toContain('consent_state_mismatch');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(loadAttempt).not.toHaveBeenCalled();
    expect(consumeSession).not.toHaveBeenCalled();
  });

  it('maps a cryptographically valid expired binding to consent_expired before state lookup', async () => {
    const loadAttempt = vi.fn();
    const routes = createM365ConsentCallbackRoutes({
      verifyBindingCookie: vi.fn(() => 'expired'),
      clearBindingCookie: vi.fn(() => 'binding=; Max-Age=0'),
      loadAttempt,
    });
    const app = new Hono().route('/api/v1/m365', routes);

    const response = await app.request('/api/v1/m365/consent/callback?state=expired');

    expect(response.headers.get('location')).toBe('/integrations#m365/customer-graph-read/consent_expired');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(loadAttempt).not.toHaveBeenCalled();
  });

  it('fails replayed or stale attempts closed without executor calls', async () => {
    const adminBinding = {
      phase: 'admin_consent' as const,
      rawState: 'admin-state',
      connectionId: CONNECTION_ID,
      consentAttemptId: ATTEMPT_ID,
      tenantHint: null,
    };
    const completeIdentity = vi.fn();
    const consumeSession = vi.fn().mockResolvedValue(null);
    const routes = createM365ConsentCallbackRoutes({
      verifyBindingCookie: vi.fn(() => adminBinding),
      clearBindingCookie: vi.fn(() => 'binding=; Max-Age=0'),
      loadAttempt: vi.fn().mockResolvedValue(attempt('pending-consent')),
      consumeSession,
      completeIdentity,
      audit: vi.fn(),
    });
    const app = new Hono().route('/api/v1/m365', routes);

    const replay = await app.request(
      `/api/v1/m365/consent/callback?state=admin-state&tenant=${TENANT_ID}&admin_consent=true`,
    );
    expect(replay.headers.get('location')).toContain('consent_state_mismatch');
    expect(completeIdentity).not.toHaveBeenCalled();

    const staleLoad = vi.fn().mockResolvedValue(null);
    const staleRoutes = createM365ConsentCallbackRoutes({
      verifyBindingCookie: vi.fn(() => adminBinding),
      clearBindingCookie: vi.fn(() => 'binding=; Max-Age=0'),
      loadAttempt: staleLoad,
      consumeSession,
    });
    const staleApp = new Hono().route('/api/v1/m365', staleRoutes);
    await staleApp.request(
      `/api/v1/m365/consent/callback?state=admin-state&tenant=${TENANT_ID}&admin_consent=true`,
    );
    expect(consumeSession).toHaveBeenCalledTimes(1);
  });

  it('sanitizes provider errors and clears the cookie on the terminal path', async () => {
    const adminBinding = {
      phase: 'admin_consent' as const,
      rawState: 'admin-state',
      connectionId: CONNECTION_ID,
      consentAttemptId: ATTEMPT_ID,
      tenantHint: null,
    };
    const markAttemptFailed = vi.fn().mockResolvedValue({ status: 'pending-consent' });
    const audit = vi.fn();
    const routes = createM365ConsentCallbackRoutes({
      verifyBindingCookie: vi.fn(() => adminBinding),
      clearBindingCookie: vi.fn(() => 'binding=; Max-Age=0'),
      loadAttempt: vi.fn().mockResolvedValue(attempt('pending-consent')),
      consumeSession: vi.fn().mockResolvedValue({ userId: USER_ID }),
      markAttemptFailed,
      audit,
    });
    const app = new Hono().route('/api/v1/m365', routes);

    const response = await app.request(
      '/api/v1/m365/consent/callback?state=admin-state&error=access_denied&error_description=provider-secret-description',
    );

    expect(response.headers.get('location')).toBe('/integrations#m365/customer-graph-read/consent_cancelled');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(markAttemptFailed).toHaveBeenCalledWith(attempt('pending-consent'), 'consent_cancelled');
    expect(JSON.stringify({ location: response.headers.get('location'), audit: audit.mock.calls }))
      .not.toContain('provider-secret-description');
  });
});
