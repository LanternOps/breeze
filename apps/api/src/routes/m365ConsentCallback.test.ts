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
      nonce: 'identity-nonce',
      codeVerifier: 'v'.repeat(43),
      tenantHintHash: tenantHintHash(TENANT_ID),
      expiresAt: new Date('2026-07-14T12:10:00.000Z'),
    };
    const consumeSession = vi.fn();
    const transitionAdminPhase = vi.fn().mockResolvedValue({
      connection: { status: 'verifying' },
      identity: { rawState: 'identity-state', codeChallenge: 'pkce-challenge' },
      actorId: USER_ID,
    });
    const audit = vi.fn();
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
      prepareIdentitySession: vi.fn(() => identityCreated),
      transitionAdminPhase,
      loadConfig: vi.fn(() => ({
        clientId: '22222222-2222-2222-2222-222222222222',
        callbackUrl: 'https://breeze.example/api/v1/m365/consent/callback',
      })),
      audit,
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
    expect(consumeSession).not.toHaveBeenCalled();
    expect(transitionAdminPhase).toHaveBeenCalledWith(expect.objectContaining({
      attempt: attempt('pending-consent'),
      rawAdminState: 'admin-state',
      prepared: identityCreated,
    }));
    expect(buildBindingCookie).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'identity_verification',
      rawState: 'identity-state',
      tenantHint: TENANT_ID,
    }));
    expect(response.headers.get('set-cookie')).toContain('new-binding=identity');
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'm365.customer_graph_read.admin_consent_returned',
      orgId: ORG_ID,
      connectionId: CONNECTION_ID,
      profile: 'customer-graph-read',
      consentAttemptId: ATTEMPT_ID,
      outcome: 'identity_verification_started',
      actorId: USER_ID,
    }));
  });

  it.each(['config', 'prepare', 'cookie', 'url'] as const)(
    'preflights %s before any admin state lookup or mutation',
    async (failure) => {
      const adminBinding = {
        phase: 'admin_consent' as const,
        rawState: 'admin-state',
        connectionId: CONNECTION_ID,
        consentAttemptId: ATTEMPT_ID,
        tenantHint: null,
      };
      const loadAttempt = vi.fn();
      const transitionAdminPhase = vi.fn();
      const loadConfig = vi.fn(() => ({
        clientId: '22222222-2222-2222-2222-222222222222',
        callbackUrl: 'https://breeze.example/api/v1/m365/consent/callback',
      }));
      const prepareIdentitySession = vi.fn(() => ({
        rawState: 'identity-state', tenantHintHash: tenantHintHash(TENANT_ID),
        nonce: 'nonce', codeVerifier: 'v'.repeat(43), codeChallenge: 'challenge',
        expiresAt: new Date('2026-07-14T12:10:00.000Z'),
      }));
      const buildBindingCookie = vi.fn(() => 'new-binding=identity');
      const buildIdentityUrl = vi.fn(() => 'https://login.microsoftonline.com/tenant/authorize');
      if (failure === 'config') loadConfig.mockImplementation(() => { throw new Error('config failed'); });
      if (failure === 'prepare') prepareIdentitySession.mockImplementation(() => { throw new Error('prepare failed'); });
      if (failure === 'cookie') buildBindingCookie.mockImplementation(() => { throw new Error('cookie failed'); });
      if (failure === 'url') buildIdentityUrl.mockImplementation(() => { throw new Error('url failed'); });
      const routes = createM365ConsentCallbackRoutes({
        verifyBindingCookie: vi.fn(() => adminBinding),
        loadAttempt,
        transitionAdminPhase,
        loadConfig,
        prepareIdentitySession,
        buildBindingCookie,
        buildIdentityUrl,
      });
      const app = new Hono().route('/api/v1/m365', routes);

      const response = await app.request(
        `/api/v1/m365/consent/callback?state=admin-state&tenant=${TENANT_ID}&admin_consent=true`,
      );

      expect(response.status).toBe(503);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(loadAttempt).not.toHaveBeenCalled();
      expect(transitionAdminPhase).not.toHaveBeenCalled();
    },
  );

  it('preserves the retry cookie when the atomic admin transition rolls back', async () => {
    const adminBinding = {
      phase: 'admin_consent' as const,
      rawState: 'admin-state',
      connectionId: CONNECTION_ID,
      consentAttemptId: ATTEMPT_ID,
      tenantHint: null,
    };
    const transitionAdminPhase = vi.fn().mockRejectedValue(new Error('identity insert failed'));
    const routes = createM365ConsentCallbackRoutes({
      verifyBindingCookie: vi.fn(() => adminBinding),
      loadAttempt: vi.fn().mockResolvedValue(attempt('pending-consent')),
      loadConfig: vi.fn(() => ({
        clientId: '22222222-2222-2222-2222-222222222222',
        callbackUrl: 'https://breeze.example/api/v1/m365/consent/callback',
      })),
      prepareIdentitySession: vi.fn(() => ({
        rawState: 'identity-state', tenantHintHash: tenantHintHash(TENANT_ID),
        nonce: 'nonce', codeVerifier: 'v'.repeat(43), codeChallenge: 'challenge',
        expiresAt: new Date('2026-07-14T12:10:00.000Z'),
      })),
      buildBindingCookie: vi.fn(() => 'new-binding=identity'),
      buildIdentityUrl: vi.fn(() => 'https://login.microsoftonline.com/tenant/authorize'),
      transitionAdminPhase,
    });
    const app = new Hono().route('/api/v1/m365', routes);

    const response = await app.request(
      `/api/v1/m365/consent/callback?state=admin-state&tenant=${TENANT_ID}&admin_consent=true`,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(transitionAdminPhase).toHaveBeenCalledOnce();
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
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'm365.customer_graph_read.tenant_binding_verified',
      orgId: ORG_ID,
      connectionId: CONNECTION_ID,
      consentAttemptId: ATTEMPT_ID,
      manifestVersion: 2,
      outcome: 'active',
      correlationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      verifiedTenantId: TENANT_ID,
      actorId: USER_ID,
    }));
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
    const audit = vi.fn();
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
      audit,
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
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'm365.customer_graph_read.verification_failed',
      outcome: 'tenant_mismatch',
      actorId: USER_ID,
    }));
  });

  it('validates the browser binding before loading or consuming state', async () => {
    const loadAttempt = vi.fn();
    const consumeSession = vi.fn();
    const audit = vi.fn();
    const routes = createM365ConsentCallbackRoutes({
      verifyBindingCookie: vi.fn(() => null),
      clearBindingCookie: vi.fn(() => 'binding=; Max-Age=0'),
      loadAttempt,
      consumeSession,
      audit,
    });
    const app = new Hono().route('/api/v1/m365', routes);

    const response = await app.request(
      `/api/v1/m365/consent/callback?state=state&tenant=${TENANT_ID}&admin_consent=true`,
    );

    expect(response.headers.get('location')).toContain('consent_state_mismatch');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(loadAttempt).not.toHaveBeenCalled();
    expect(consumeSession).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('maps a cryptographically valid expired binding to consent_expired before state lookup', async () => {
    const loadAttempt = vi.fn();
    const routes = createM365ConsentCallbackRoutes({
      verifyBindingCookie: vi.fn(() => 'expired' as const),
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
    const consumeSession = vi.fn();
    const transitionAdminPhase = vi.fn().mockRejectedValue(
      Object.assign(new Error('stale_attempt'), { code: 'stale_attempt' }),
    );
    const adminPreflight = {
      loadConfig: vi.fn(() => ({
        clientId: '22222222-2222-2222-2222-222222222222',
        callbackUrl: 'https://breeze.example/api/v1/m365/consent/callback',
      })),
      prepareIdentitySession: vi.fn(() => ({
        rawState: 'identity-state', tenantHintHash: tenantHintHash(TENANT_ID),
        nonce: 'nonce', codeVerifier: 'v'.repeat(43), codeChallenge: 'challenge',
        expiresAt: new Date('2026-07-14T12:10:00.000Z'),
      })),
      buildBindingCookie: vi.fn(() => 'new-binding=identity'),
      buildIdentityUrl: vi.fn(() => 'https://login.microsoftonline.com/tenant/authorize'),
    };
    const routes = createM365ConsentCallbackRoutes({
      verifyBindingCookie: vi.fn(() => adminBinding),
      clearBindingCookie: vi.fn(() => 'binding=; Max-Age=0'),
      loadAttempt: vi.fn().mockResolvedValue(attempt('pending-consent')),
      consumeSession,
      completeIdentity,
      audit: vi.fn(),
      transitionAdminPhase,
      ...adminPreflight,
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
      transitionAdminPhase,
      ...adminPreflight,
    });
    const staleApp = new Hono().route('/api/v1/m365', staleRoutes);
    await staleApp.request(
      `/api/v1/m365/consent/callback?state=admin-state&tenant=${TENANT_ID}&admin_consent=true`,
    );
    expect(consumeSession).not.toHaveBeenCalled();
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
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'm365.customer_graph_read.verification_failed',
      outcome: 'consent_cancelled',
      actorId: USER_ID,
    }));
    expect(JSON.stringify({ location: response.headers.get('location'), audit: audit.mock.calls }))
      .not.toContain('provider-secret-description');
  });

  it('emits verified binding and grant drift once each after signed proof', async () => {
    const identityBinding = {
      phase: 'identity_verification' as const,
      rawState: 'identity-state',
      connectionId: CONNECTION_ID,
      consentAttemptId: ATTEMPT_ID,
      tenantHint: TENANT_ID,
    };
    const audit = vi.fn();
    const result = {
      success: true as const,
      tenantId: TENANT_ID,
      administratorObjectId: 'must-not-audit-admin',
      applicationId: '22222222-2222-2222-2222-222222222222',
      organizationDisplayName: 'Contoso',
      manifestVersion: 2,
      verifiedAt: '2026-07-14T12:00:00.000Z',
      grantReconciliation: 'complete' as const,
      observedGrants: [], missingGrants: [], unexpectedGrants: [],
      grantsVerifiedAt: '2026-07-14T12:00:00.000Z',
    };
    const routes = createM365ConsentCallbackRoutes({
      verifyBindingCookie: vi.fn(() => identityBinding),
      clearBindingCookie: vi.fn(() => 'binding=; Max-Age=0'),
      loadAttempt: vi.fn().mockResolvedValue(attempt('verifying')),
      consumeSession: vi.fn().mockResolvedValue({
        userId: USER_ID, tenantHintHash: tenantHintHash(TENANT_ID),
        nonce: 'must-not-audit-nonce', codeVerifier: 'must-not-audit-verifier',
      }),
      completeIdentity: vi.fn().mockResolvedValue(result),
      applyIdentityResult: vi.fn().mockResolvedValue({
        ...attempt('verifying'), tenantId: TENANT_ID, permissionManifestVersion: 2,
        status: 'degraded', lastErrorCode: 'grant_missing',
      }),
      loadConfig: vi.fn(() => ({
        clientId: result.applicationId,
        callbackUrl: 'https://breeze.example/api/v1/m365/consent/callback',
      })),
      correlationId: vi.fn(() => 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
      audit,
    });
    const response = await new Hono().route('/api/v1/m365', routes).request(
      '/api/v1/m365/consent/callback?state=identity-state&code=must-not-audit-code',
    );

    expect(response.headers.get('location')).toContain('/degraded');
    expect(audit.mock.calls.map((call) => call[1].event)).toEqual([
      'm365.customer_graph_read.tenant_binding_verified',
      'm365.customer_graph_read.grant_drift_detected',
    ]);
    expect(audit.mock.calls[0]?.[1]).toMatchObject({ actorId: USER_ID });
    expect(audit.mock.calls[1]?.[1]).toMatchObject({
      outcome: 'grant_missing',
      actorId: USER_ID,
    });
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(
      /must-not-audit-admin|must-not-audit-nonce|must-not-audit-verifier|must-not-audit-code/,
    );
  });

  it('attributes an executor failure to the verified identity session user', async () => {
    const identityBinding = {
      phase: 'identity_verification' as const,
      rawState: 'identity-state',
      connectionId: CONNECTION_ID,
      consentAttemptId: ATTEMPT_ID,
      tenantHint: TENANT_ID,
    };
    const audit = vi.fn();
    const routes = createM365ConsentCallbackRoutes({
      verifyBindingCookie: vi.fn(() => identityBinding),
      clearBindingCookie: vi.fn(() => 'binding=; Max-Age=0'),
      loadAttempt: vi.fn().mockResolvedValue(attempt('verifying')),
      consumeSession: vi.fn().mockResolvedValue({
        userId: USER_ID,
        tenantHintHash: tenantHintHash(TENANT_ID),
        nonce: 'identity-nonce',
        codeVerifier: 'v'.repeat(43),
      }),
      completeIdentity: vi.fn().mockRejectedValue(new Error('executor unavailable')),
      markAttemptFailed: vi.fn().mockResolvedValue({ status: 'pending-consent' }),
      loadConfig: vi.fn(() => ({
        clientId: '22222222-2222-2222-2222-222222222222',
        callbackUrl: 'https://breeze.example/api/v1/m365/consent/callback',
      })),
      audit,
    });

    const response = await new Hono().route('/api/v1/m365', routes).request(
      '/api/v1/m365/consent/callback?state=identity-state&code=secret-code',
    );

    expect(response.headers.get('location')).toContain('/executor_unavailable');
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'm365.customer_graph_read.verification_failed',
      outcome: 'executor_unavailable',
      actorId: USER_ID,
    }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain('secret-code');
  });
});
