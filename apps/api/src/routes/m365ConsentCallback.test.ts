import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { M365_PERMISSION_PROFILES, type RetestResult } from '@breeze/shared/m365';
import {
  buildM365ActionsConsentBindingCookie,
  buildM365ConsentBindingCookie,
} from '../services/m365ControlPlane/browserBinding';
import {
  m365ActionsConsentCallbackRoutes,
  m365ConsentCallbackRoutes,
  createM365ConsentCallbackRoutes,
  parseM365ConsentCallbackQuery,
  type CreateM365ConsentCallbackRoutesOverrides,
} from './m365ConsentCallback';

const { syncMocks } = vi.hoisted(() => ({
  syncMocks: {
    flag: vi.fn(() => true),
    consented: vi.fn(async (_conn: unknown) => {}),
    upgraded: vi.fn(async (_conn: unknown) => {}),
  },
}));
vi.mock('../config/env', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isM365TenantSyncEnabled: syncMocks.flag,
}));
vi.mock('../services/m365Sync/lifecycle', () => ({
  onConnectionConsented: syncMocks.consented,
  onConnectionUpgraded: syncMocks.upgraded,
  onConnectionDisconnected: vi.fn(async () => {}),
}));

const CONNECTION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ATTEMPT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CORRELATION_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '33333333-3333-4333-8333-333333333333';
const HOME = '99999999-9999-4999-8999-999999999999';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const NOW_ISO = '2026-10-03T12:00:00.000Z';

type Profile = 'customer-graph-read' | 'customer-graph-actions';
type Status = 'pending-consent' | 'verifying' | 'active' | 'degraded';

function hashTenant(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function identityBinding(tenantId: string | null, rawState = 'id-state') {
  return { phase: 'identity_verification' as const, rawState, connectionId: CONNECTION_ID, consentAttemptId: ATTEMPT_ID, tenantId };
}

function consentBinding(tenantId: string, rawState = 'consent-state') {
  return { phase: 'admin_consent' as const, rawState, connectionId: CONNECTION_ID, consentAttemptId: ATTEMPT_ID, tenantId };
}

function identitySession(overrides: { tenantHintHash: string | null; purpose?: 'initial' | 'upgrade' }) {
  return {
    userId: USER_ID,
    purpose: overrides.purpose ?? 'initial',
    flowVersion: 2,
    phase: 'identity_verification',
    tenantHintHash: overrides.tenantHintHash,
    nonce: 'identity-nonce',
    codeVerifier: 'v'.repeat(43),
  };
}

function consentSession(overrides: { purpose?: 'initial' | 'upgrade' } = {}) {
  return {
    userId: USER_ID,
    purpose: overrides.purpose ?? 'initial',
    flowVersion: 2,
    phase: 'admin_consent',
    tenantHintHash: null,
    nonce: null,
    codeVerifier: null,
    verifiedTenantId: TENANT_A,
    verifiedAdminObjectId: ADMIN,
    verifiedAdminUsername: null,
    identityVerifiedAt: new Date(NOW_ISO),
  };
}

function verified(tenantId: string) {
  return { tenantId, administratorObjectId: ADMIN, administratorUsername: 'admin@tenant.example', verifiedAt: new Date(NOW_ISO) };
}

function identityOk(tenantId: string) {
  return { success: true as const, tenantId, administratorObjectId: ADMIN, administratorUsername: 'admin@tenant.example', verifiedAt: NOW_ISO };
}

function retestOk(tenantId: string, manifestVersion = 3): RetestResult {
  return {
    success: true, tenantId, applicationId: CLIENT_ID, organizationDisplayName: 'Contoso',
    manifestVersion, verifiedAt: NOW_ISO, grantReconciliation: 'complete',
    observedGrants: [], missingGrants: [], unexpectedGrants: [], grantsVerifiedAt: NOW_ISO,
  };
}

/**
 * Sanitized capture of the real Microsoft error redirect observed in production
 * 2026-10-01: Conditional Access demanded device authentication (AADSTS50097).
 * Note admin_consent=True rides along WITH the error.
 */
const REAL_CA_ERROR_QUERY = (state: string) => 'error=invalid_grant'
  + '&error_description=AADSTS50097%3a+Device+authentication+is+required.+Trace+ID%3a+'
  + '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d+Correlation+ID%3a+5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b'
  + '+Timestamp%3a+2026-10-01+14%3a03%3a11Z'
  + '&error_uri=https%3a%2f%2flogin.microsoftonline.com%2ferror%3fcode%3d50097'
  + `&admin_consent=True&state=${state}`;

const lifecycle = (code: string) => Object.assign(new Error(code), { code });

interface Harness {
  name: string;
  profile: Profile;
  path: string;
  redirectBase: string;
  events: {
    adminIdentityVerified: string;
    adminConsentReturned: string;
    tenantBindingVerified: string;
    verificationFailed: string;
  };
  attempt(status: Status): { id: string; orgId: string; profile: Profile; consentAttemptId: string; status: Status };
  snapshot(overrides?: Record<string, unknown>): Record<string, unknown>;
  app(overrides?: CreateM365ConsentCallbackRoutesOverrides): Hono;
}

function harness(profile: Profile): Harness {
  const segment = profile === 'customer-graph-actions' ? 'actions-consent' : 'consent';
  const path = `/api/v1/m365/${segment}/callback`;
  const eventPrefix = profile === 'customer-graph-actions' ? 'm365.customer_graph_actions' : 'm365.customer_graph_read';
  const attempt = (status: Status) => ({ id: CONNECTION_ID, orgId: ORG_ID, profile, consentAttemptId: ATTEMPT_ID, status });
  const snapshot = (overrides: Record<string, unknown> = {}) => ({
    ...attempt('pending-consent'), tenantId: null, permissionManifestVersion: 3, lastErrorCode: null, ...overrides,
  });
  const unexpected = (name: string) => vi.fn(async () => { throw new Error(`unexpected ${name}`); });
  return {
    name: profile,
    profile,
    path,
    redirectBase: `/integrations#m365/${profile}`,
    events: {
      adminIdentityVerified: `${eventPrefix}.admin_identity_verified`,
      adminConsentReturned: `${eventPrefix}.admin_consent_returned`,
      tenantBindingVerified: `${eventPrefix}.tenant_binding_verified`,
      verificationFailed: `${eventPrefix}.verification_failed`,
    },
    attempt,
    snapshot,
    app: (overrides = {}) => new Hono().route('/api/v1/m365', createM365ConsentCallbackRoutes({
      profile,
      readSessionPurpose: vi.fn(async () => 'initial' as const),
      clearBindingCookie: vi.fn(() => 'binding=; Max-Age=0'),
      buildBindingCookie: vi.fn(() => 'binding=next'),
      loadConfig: vi.fn(() => ({ clientId: CLIENT_ID, callbackUrl: `https://breeze.example${path}` })),
      correlationId: vi.fn(() => CORRELATION_ID),
      audit: vi.fn(),
      metric: vi.fn(),
      loadAttempt: unexpected('loadAttempt'),
      consumeSession: unexpected('consumeSession'),
      verifyIdentity: unexpected('verifyIdentity'),
      transitionIdentityToConsent: unexpected('transitionIdentityToConsent'),
      beginFinalization: unexpected('beginFinalization'),
      finalize: unexpected('finalize'),
      applyFinalization: unexpected('applyFinalization'),
      applyUpgradeFinalization: unexpected('applyUpgradeFinalization'),
      markAttemptFailed: vi.fn(async () => snapshot() as never),
      ...overrides,
    })),
  };
}

const HARNESSES = [
  ['read', harness('customer-graph-read')],
  ['actions', harness('customer-graph-actions')],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  syncMocks.flag.mockReturnValue(true);
  syncMocks.consented.mockResolvedValue(undefined);
  syncMocks.upgraded.mockResolvedValue(undefined);
});

describe('M365 consent callback parser', () => {
  it('both phases accept {state, code[, session_state]} and reject the old code-less admin-consent shape', () => {
    for (const phase of ['identity_verification', 'admin_consent'] as const) {
      expect(parseM365ConsentCallbackQuery(phase, new URLSearchParams('state=s&code=c'))).toEqual({ kind: 'code_success', state: 's', code: 'c' });
      expect(parseM365ConsentCallbackQuery(phase, new URLSearchParams('state=s&code=c&session_state=x'))).toEqual({ kind: 'code_success', state: 's', code: 'c' });
      expect(parseM365ConsentCallbackQuery(phase, new URLSearchParams(`state=s&tenant=${TENANT_A}&admin_consent=True`))).toBeNull();
      expect(parseM365ConsentCallbackQuery(phase, new URLSearchParams('state=s&code=c&code=d'))).toBeNull();
      expect(parseM365ConsentCallbackQuery(phase, new URLSearchParams('state=a&state=b&code=c'))).toBeNull();
      expect(parseM365ConsentCallbackQuery(phase, new URLSearchParams('code=c'))).toBeNull();
      expect(parseM365ConsentCallbackQuery(phase, new URLSearchParams('state=s&code=c&session_state='))).toBeNull();
      expect(parseM365ConsentCallbackQuery(phase, new URLSearchParams('state=s&code=c&foo=bar'))).toBeNull();
    }
  });

  it('identity phase tolerates nothing beyond session_state', () => {
    for (const extra of ['admin_consent=True', `tenant=${TENANT_A}`, 'client_info=x']) {
      expect(parseM365ConsentCallbackQuery('identity_verification', new URLSearchParams(`state=s&code=c&${extra}`))).toBeNull();
    }
  });

  it('consent phase tolerates bounded admin_consent / tenant / client_info and drops them from the result', () => {
    const ok = { kind: 'code_success', state: 's', code: 'c' };
    const parse = (query: string) => parseM365ConsentCallbackQuery('admin_consent', new URLSearchParams(query));
    expect(parse(`state=s&code=c&session_state=x&admin_consent=True&tenant=${TENANT_B}`)).toEqual(ok);
    expect(parse('state=s&code=c&admin_consent=True')).toEqual(ok);
    expect(parse(`state=s&code=c&tenant=${TENANT_B}`)).toEqual(ok);
    expect(parse(`state=s&code=c&client_info=${'e'.repeat(2_048)}`)).toEqual(ok);
    expect(parse(`state=s&code=c&tenant=${'t'.repeat(512)}`)).toEqual(ok);
    // Bounded: oversize, duplicated, or control characters fail closed.
    expect(parse(`state=s&code=c&tenant=${'t'.repeat(513)}`)).toBeNull();
    expect(parse(`state=s&code=c&admin_consent=${'a'.repeat(513)}`)).toBeNull();
    expect(parse(`state=s&code=c&client_info=${'e'.repeat(2_049)}`)).toBeNull();
    expect(parse(`state=s&code=c&tenant=${TENANT_A}&tenant=${TENANT_B}`)).toBeNull();
    expect(parse('state=s&code=c&admin_consent=True%0A')).toBeNull();
    // Unknown keys still fail closed.
    expect(parse('state=s&code=c&admin_consent=True&foo=bar')).toBeNull();
  });

  it('accepts a provider error without exposing its description', () => {
    expect(parseM365ConsentCallbackQuery('identity_verification', new URLSearchParams({
      state: 'state', error: 'access_denied', error_description: 'sensitive provider text',
    }))).toEqual({
      kind: 'provider_error', state: 'state', error: 'access_denied', reason: 'cancelled', aadstsCode: null, providerCorrelationId: null,
    });
  });

  it.each(['admin_consent', 'identity_verification'] as const)(
    'classifies the real Microsoft Conditional Access error redirect as conditional_access (%s phase)',
    (phase) => {
      expect(parseM365ConsentCallbackQuery(phase, new URLSearchParams(REAL_CA_ERROR_QUERY('s')))).toEqual({
        kind: 'provider_error',
        state: 's',
        error: 'invalid_grant',
        reason: 'conditional_access',
        aadstsCode: 50097,
        providerCorrelationId: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b',
      });
    },
  );

  it.each(['admin_consent', 'identity_verification'] as const)(
    'never treats an error response as success, even with code / admin_consent=True alongside (%s phase)',
    (phase) => {
      expect(parseM365ConsentCallbackQuery(phase, new URLSearchParams(
        `state=a&tenant=${TENANT_A}&admin_consent=True&error=server_error`,
      ))).toMatchObject({ kind: 'provider_error', reason: 'other' });
      expect(parseM365ConsentCallbackQuery(phase, new URLSearchParams('state=a&code=c&error=server_error')))
        .toBeNull();
    },
  );

  it.each([
    ['access_denied', 'state=s&error=access_denied', 'cancelled'],
    ['subcode cancel', 'state=s&error=access_denied&error_subcode=cancel', 'cancelled'],
    ['subcode cancel on another error', 'state=s&error=invalid_request&error_subcode=cancel', 'cancelled'],
    ['CA code list', 'state=s&error=invalid_grant&error_codes=%5B53003%5D', 'conditional_access'],
    // Entra reports a CA block on the authorize endpoint as access_denied + AADSTS53003.
    ['CA block reported as access_denied', 'state=s&error=access_denied&error_description=AADSTS53003%3A+Access+has+been+blocked+by+Conditional+Access+policies', 'conditional_access'],
    ['CA block with subcode cancel', 'state=s&error=access_denied&error_subcode=cancel&error_codes=53001', 'conditional_access'],
    ['CA 53000', 'state=s&error=interaction_required&error_description=AADSTS53000%3A+Device+not+compliant', 'conditional_access'],
    ['CA 50158', 'state=s&error=interaction_required&error_description=AADSTS50158%3A+External+security+challenge', 'conditional_access'],
    ['unrelated code', 'state=s&error=invalid_client&error_description=AADSTS700016%3A+app+not+found', 'other'],
    ['full Microsoft field set', 'state=s&error=server_error&error_description=x&error_uri=u&error_subcode=y&error_codes=%5B1%5D'
      + '&admin_consent=False&tenant=t&timestamp=2026-10-01&trace_id=t1&correlation_id=c1&session_state=ss', 'other'],
  ] as const)('classifies provider error (%s) identically in both phases', (_name, raw, reason) => {
    for (const phase of ['identity_verification', 'admin_consent'] as const) {
      expect(parseM365ConsentCallbackQuery(phase, new URLSearchParams(raw)))
        .toMatchObject({ kind: 'provider_error', state: 's', reason });
    }
  });

  it.each([
    ['unknown key on the error path', 'state=s&error=access_denied&foo=bar'],
    ['duplicate error', 'state=s&error=access_denied&error=server_error'],
    ['duplicate tolerated key', 'state=s&error=access_denied&error_uri=a&error_uri=b'],
    ['overlong error_uri', `state=s&error=access_denied&error_uri=${'u'.repeat(513)}`],
    ['overlong description', `state=s&error=access_denied&error_description=${'d'.repeat(4097)}`],
    ['control char in tolerated key', 'state=s&error=access_denied&trace_id=a%0Ab'],
    ['overlong error', `state=s&error=${'e'.repeat(129)}`],
    ['missing state', 'error=access_denied'],
  ] as const)('rejects provider error with %s in both phases', (_name, raw) => {
    for (const phase of ['identity_verification', 'admin_consent'] as const) {
      expect(parseM365ConsentCallbackQuery(phase, new URLSearchParams(raw))).toBeNull();
    }
  });
});

describe('M365 consent callback mounts', () => {
  it('mounts the exact public read and actions callback paths', async () => {
    const read = new Hono().route('/api/v1/m365', m365ConsentCallbackRoutes);
    const actions = new Hono().route('/api/v1/m365', m365ActionsConsentCallbackRoutes);
    expect((await read.request('/api/v1/m365/consent/callback')).status).not.toBe(404);
    expect((await actions.request('/api/v1/m365/actions-consent/callback')).status).not.toBe(404);
    expect((await read.request('/api/v1/m365/actions-consent/callback')).status).toBe(404);
  });
});

describe.each(HARNESSES)('%s identity-first callback', (_name, h) => {
  it('identity phase verifies via executor, rotates state, and redirects to the v1 consent URL for the VERIFIED tenant', async () => {
    const verifyIdentity = vi.fn().mockResolvedValue(identityOk(TENANT_A));
    const transitionIdentityToConsent = vi.fn().mockResolvedValue({ rawState: 'consent-state', verifiedTenantId: TENANT_A });
    const buildBindingCookie = vi.fn(() => 'binding=consent');
    const audit = vi.fn();
    const consumeSession = vi.fn().mockResolvedValue(identitySession({ tenantHintHash: null }));
    const app = h.app({
      verifyBindingCookie: () => identityBinding(null),
      consumeSession, verifyIdentity, transitionIdentityToConsent, buildBindingCookie, audit,
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
    });

    const res = await app.request(`${h.path}?state=id-state&code=id-code&session_state=ss`, { headers: { cookie: 'x' } });

    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(`https://login.microsoftonline.com/${TENANT_A}/oauth2/authorize`);
    expect(Object.fromEntries(loc.searchParams)).toEqual({
      client_id: CLIENT_ID, response_type: 'code', redirect_uri: `https://breeze.example${h.path}`,
      resource: 'https://graph.microsoft.com', prompt: 'admin_consent', state: 'consent-state',
    });
    expect(consumeSession).toHaveBeenCalledWith(expect.objectContaining({ phase: 'identity_verification', rawState: 'id-state', profile: h.profile }));
    expect(verifyIdentity).toHaveBeenCalledWith({
      correlationId: CORRELATION_ID,
      consentAttemptId: ATTEMPT_ID,
      expectedTenantId: null,
      authorizationCode: 'id-code',
      codeVerifier: 'v'.repeat(43),
      nonce: 'identity-nonce',
      redirectUri: `https://breeze.example${h.path}`,
    });
    expect(transitionIdentityToConsent).toHaveBeenCalledWith({
      attempt: h.attempt('pending-consent'), purpose: 'initial', actorId: USER_ID,
      verified: verified(TENANT_A), nextPhase: 'admin_consent',
    });
    expect(buildBindingCookie).toHaveBeenCalledWith({
      phase: 'admin_consent', rawState: 'consent-state', connectionId: CONNECTION_ID, consentAttemptId: ATTEMPT_ID, tenantId: TENANT_A,
    });
    expect(res.headers.get('set-cookie')).toContain('binding=consent');
    expect(res.headers.get('set-cookie')).not.toContain('Max-Age=0');
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: h.events.adminIdentityVerified, outcome: 'identity_verified', verifiedTenantId: TENANT_A,
      verifiedAdministratorObjectId: ADMIN, actorId: USER_ID, correlationId: CORRELATION_ID,
    }));
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/id-code|identity-nonce|admin@tenant\.example/);
  });

  it('identity phase on a bound reconnect pins the executor to the bound tenant', async () => {
    const verifyIdentity = vi.fn().mockResolvedValue(identityOk(TENANT_A));
    const app = h.app({
      verifyBindingCookie: () => identityBinding(TENANT_A),
      consumeSession: vi.fn().mockResolvedValue(identitySession({ tenantHintHash: hashTenant(TENANT_A) })),
      verifyIdentity,
      transitionIdentityToConsent: vi.fn().mockResolvedValue({ rawState: 'consent-state', verifiedTenantId: TENANT_A }),
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
    });

    const res = await app.request(`${h.path}?state=id-state&code=c`, { headers: { cookie: 'x' } });

    expect(new URL(res.headers.get('location')!).pathname).toBe(`/${TENANT_A}/oauth2/authorize`);
    expect(verifyIdentity).toHaveBeenCalledWith(expect.objectContaining({ expectedTenantId: TENANT_A }));
  });

  it('consent phase never forwards the Microsoft code and binds only after application proof', async () => {
    const finalize = vi.fn().mockResolvedValue(retestOk(TENANT_A));
    const applyFinalization = vi.fn().mockResolvedValue(h.snapshot({ status: 'active', tenantId: TENANT_A }));
    const beginFinalization = vi.fn().mockResolvedValue({ attempt: h.attempt('verifying'), purpose: 'initial', verified: verified(TENANT_A), actorId: USER_ID });
    const audit = vi.fn();
    const markAttemptFailed = vi.fn();
    const app = h.app({
      verifyBindingCookie: () => consentBinding(TENANT_A),
      beginFinalization, finalize, applyFinalization, audit, markAttemptFailed,
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
    });

    const res = await app.request(`${h.path}?state=consent-state&code=SECRET-CONSENT-CODE&session_state=ss`, { headers: { cookie: 'x' } });

    expect(res.headers.get('location')).toBe(`${h.redirectBase}/active`);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(beginFinalization).toHaveBeenCalledWith({ attempt: h.attempt('pending-consent'), rawConsentState: 'consent-state' });
    expect(finalize).toHaveBeenCalledWith({ correlationId: CORRELATION_ID, tenantId: TENANT_A });
    expect(applyFinalization).toHaveBeenCalledWith(h.attempt('verifying'), { verifiedTenantId: TENANT_A, result: retestOk(TENANT_A) });
    expect(markAttemptFailed).not.toHaveBeenCalled();
    expect(JSON.stringify([
      beginFinalization.mock.calls, finalize.mock.calls, applyFinalization.mock.calls, audit.mock.calls,
    ])).not.toContain('SECRET-CONSENT-CODE');
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: h.events.adminConsentReturned, outcome: 'application_verification_started', actorId: USER_ID,
    }));
    // The consent-returned event never names the verified administrator: Breeze
    // cannot see who clicked Accept on Microsoft's consent screen.
    expect(audit.mock.calls.find(([, input]) => input.event === h.events.adminConsentReturned)![1])
      .not.toHaveProperty('verifiedAdministratorObjectId');
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: h.events.tenantBindingVerified, outcome: 'active', verifiedTenantId: TENANT_A,
      verifiedAdministratorObjectId: ADMIN, actorId: USER_ID,
    }));
  });

  it('consent phase: a query `tenant` naming a DIFFERENT tenant is ignored — binding uses only the verified tenant', async () => {
    const finalize = vi.fn().mockResolvedValue(retestOk(TENANT_A));
    const applyFinalization = vi.fn().mockResolvedValue(h.snapshot({ status: 'active', tenantId: TENANT_A }));
    const beginFinalization = vi.fn().mockResolvedValue({ attempt: h.attempt('verifying'), purpose: 'initial', verified: verified(TENANT_A), actorId: USER_ID });
    const audit = vi.fn();
    const app = h.app({
      verifyBindingCookie: () => consentBinding(TENANT_A),
      beginFinalization, finalize, applyFinalization, audit,
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
    });

    const res = await app.request(
      `${h.path}?state=consent-state&code=c&admin_consent=True&tenant=${TENANT_B}&session_state=ss`,
      { headers: { cookie: 'x' } },
    );

    expect(res.headers.get('location')).toBe(`${h.redirectBase}/active`);
    expect(finalize).toHaveBeenCalledWith({ correlationId: CORRELATION_ID, tenantId: TENANT_A });
    expect(applyFinalization).toHaveBeenCalledWith(h.attempt('verifying'), { verifiedTenantId: TENANT_A, result: retestOk(TENANT_A) });
    expect(JSON.stringify([
      beginFinalization.mock.calls, finalize.mock.calls, applyFinalization.mock.calls, audit.mock.calls,
    ])).not.toContain(TENANT_B);
  });

  it('consent phase: an unknown query key fails closed before any state lookup', async () => {
    const loadAttempt = vi.fn();
    const res = await h.app({ verifyBindingCookie: () => consentBinding(TENANT_A), loadAttempt })
      .request(`${h.path}?state=consent-state&code=c&admin_consent=True&foo=bar`, { headers: { cookie: 'x' } });
    expect(res.headers.get('location')).toBe(`${h.redirectBase}/consent_state_mismatch`);
    expect(loadAttempt).not.toHaveBeenCalled();
  });

  it('a binding cookie naming tenant A cannot finalize a session verified for tenant B', async () => {
    const finalize = vi.fn();
    const markAttemptFailed = vi.fn().mockResolvedValue(h.snapshot());
    const app = h.app({
      verifyBindingCookie: () => consentBinding(TENANT_A, 's'),
      beginFinalization: vi.fn().mockResolvedValue({ attempt: h.attempt('verifying'), purpose: 'initial', verified: verified(TENANT_B), actorId: USER_ID }),
      finalize, markAttemptFailed,
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
    });

    const res = await app.request(`${h.path}?state=s&code=c`, { headers: { cookie: 'x' } });

    expect(res.headers.get('location')).toBe(`${h.redirectBase}/tenant_mismatch`);
    expect(finalize).not.toHaveBeenCalled();
    expect(markAttemptFailed).toHaveBeenCalledWith(h.attempt('verifying'), 'tenant_mismatch');
  });

  it('forged tenant hint: an identity cookie whose tenant does not hash to the session hint fails before the executor', async () => {
    const verifyIdentity = vi.fn();
    const markAttemptFailed = vi.fn().mockResolvedValue(h.snapshot());
    const app = h.app({
      verifyBindingCookie: () => identityBinding(TENANT_B, 'id'),
      consumeSession: vi.fn().mockResolvedValue(identitySession({ tenantHintHash: hashTenant(TENANT_A) })),
      verifyIdentity, markAttemptFailed,
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
    });

    const res = await app.request(`${h.path}?state=id&code=c`, { headers: { cookie: 'x' } });

    expect(res.headers.get('location')).toBe(`${h.redirectBase}/tenant_mismatch`);
    expect(verifyIdentity).not.toHaveBeenCalled();
    expect(markAttemptFailed).toHaveBeenCalledWith(h.attempt('pending-consent'), 'tenant_mismatch');
  });

  it.each([
    ['organizations cookie, pinned session', null, hashTenant(TENANT_A)],
    ['pinned cookie, organizations session', TENANT_A, null],
  ] as const)('forged authority (%s) fails before the executor', async (_label, cookieTenant, sessionHash) => {
    const verifyIdentity = vi.fn();
    const app = h.app({
      verifyBindingCookie: () => identityBinding(cookieTenant),
      consumeSession: vi.fn().mockResolvedValue(identitySession({ tenantHintHash: sessionHash })),
      verifyIdentity,
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
    });

    const res = await app.request(`${h.path}?state=id-state&code=c`, { headers: { cookie: 'x' } });

    expect(res.headers.get('location')).toBe(`${h.redirectBase}/tenant_mismatch`);
    expect(verifyIdentity).not.toHaveBeenCalled();
  });

  it('forged tenant hint: a query `tenant` parameter is rejected outright', async () => {
    const loadAttempt = vi.fn();
    const res = await h.app({ verifyBindingCookie: () => identityBinding(null), loadAttempt })
      .request(`${h.path}?state=id-state&code=c&tenant=${TENANT_B}`, { headers: { cookie: 'x' } });
    expect(res.headers.get('location')).toBe(`${h.redirectBase}/consent_state_mismatch`);
    expect(loadAttempt).not.toHaveBeenCalled();
  });

  it.each([
    ['identity_token_invalid'], ['admin_role_required'], ['tenant_mismatch'], ['credential_unavailable'],
  ] as const)('identity failure %s marks an initial attempt failed and never reaches consent', async (code) => {
    const markAttemptFailed = vi.fn().mockResolvedValue(h.snapshot());
    const transitionIdentityToConsent = vi.fn();
    const res = await h.app({
      verifyBindingCookie: () => identityBinding(null),
      consumeSession: vi.fn().mockResolvedValue(identitySession({ tenantHintHash: null })),
      verifyIdentity: vi.fn().mockResolvedValue({ success: false, errorCode: code }),
      markAttemptFailed, transitionIdentityToConsent,
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
    }).request(`${h.path}?state=id-state&code=c`, { headers: { cookie: 'x' } });

    expect(res.headers.get('location')).toBe(`${h.redirectBase}/${code}`);
    expect(markAttemptFailed).toHaveBeenCalledWith(h.attempt('pending-consent'), code);
    expect(transitionIdentityToConsent).not.toHaveBeenCalled();
  });

  it('a verified tenant different from the pinned one never continues, even if the executor claimed success', async () => {
    const transitionIdentityToConsent = vi.fn();
    const res = await h.app({
      verifyBindingCookie: () => identityBinding(TENANT_A),
      consumeSession: vi.fn().mockResolvedValue(identitySession({ tenantHintHash: hashTenant(TENANT_A) })),
      verifyIdentity: vi.fn().mockResolvedValue(identityOk(TENANT_B)),
      transitionIdentityToConsent,
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
    }).request(`${h.path}?state=id-state&code=c`, { headers: { cookie: 'x' } });

    expect(res.headers.get('location')).toBe(`${h.redirectBase}/tenant_mismatch`);
    expect(transitionIdentityToConsent).not.toHaveBeenCalled();
  });

  it('replayed identity state: consumed session ⇒ mismatch, executor not called', async () => {
    const verifyIdentity = vi.fn();
    const res = await h.app({
      verifyBindingCookie: () => identityBinding(null), consumeSession: vi.fn().mockResolvedValue(null), verifyIdentity,
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
    }).request(`${h.path}?state=id-state&code=c`, { headers: { cookie: 'x' } });

    expect(res.headers.get('location')).toBe(`${h.redirectBase}/consent_state_mismatch`);
    expect(verifyIdentity).not.toHaveBeenCalled();
  });

  it('an attempt that is no longer pending-consent cannot run either phase of a first-time consent', async () => {
    const consumeSession = vi.fn();
    const beginFinalization = vi.fn();
    for (const binding of [identityBinding(null), consentBinding(TENANT_A)]) {
      const res = await h.app({
        verifyBindingCookie: () => binding, consumeSession, beginFinalization,
        loadAttempt: vi.fn().mockResolvedValue(h.attempt('verifying')),
      }).request(`${h.path}?state=${binding.rawState}&code=c`, { headers: { cookie: 'x' } });
      expect(res.headers.get('location')).toBe(`${h.redirectBase}/consent_state_mismatch`);
    }
    expect(consumeSession).not.toHaveBeenCalled();
    expect(beginFinalization).not.toHaveBeenCalled();
  });

  it('a consumed identity session whose purpose disagrees with the routed purpose fails closed', async () => {
    const verifyIdentity = vi.fn();
    const res = await h.app({
      verifyBindingCookie: () => identityBinding(null),
      consumeSession: vi.fn().mockResolvedValue(identitySession({ tenantHintHash: null, purpose: 'upgrade' })),
      verifyIdentity,
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
    }).request(`${h.path}?state=id-state&code=c`, { headers: { cookie: 'x' } });

    expect(res.headers.get('location')).toBe(`${h.redirectBase}/consent_state_mismatch`);
    expect(verifyIdentity).not.toHaveBeenCalled();
  });

  it.each([
    ['tenant_mismatch', 'tenant_mismatch', true],
    ['stale_attempt', 'consent_state_mismatch', false],
  ] as const)('a %s lifecycle error at the identity → consent transition redirects %s', async (code, outcome, marks) => {
    const markAttemptFailed = vi.fn().mockResolvedValue(h.snapshot());
    const res = await h.app({
      verifyBindingCookie: () => identityBinding(null),
      consumeSession: vi.fn().mockResolvedValue(identitySession({ tenantHintHash: null })),
      verifyIdentity: vi.fn().mockResolvedValue(identityOk(TENANT_B)),
      transitionIdentityToConsent: vi.fn().mockRejectedValue(lifecycle(code)),
      markAttemptFailed,
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
    }).request(`${h.path}?state=id-state&code=c`, { headers: { cookie: 'x' } });

    expect(res.headers.get('location')).toBe(`${h.redirectBase}/${outcome}`);
    if (marks) expect(markAttemptFailed).toHaveBeenCalledWith(h.attempt('pending-consent'), 'tenant_mismatch');
    else expect(markAttemptFailed).not.toHaveBeenCalled();
  });

  it('concurrent duplicate consent callbacks: only one finalizes', async () => {
    let consumed = false;
    const beginFinalization = vi.fn(async () => {
      if (consumed) throw lifecycle('stale_attempt');
      consumed = true;
      return { attempt: h.attempt('verifying'), purpose: 'initial' as const, verified: verified(TENANT_A), actorId: USER_ID };
    });
    const finalize = vi.fn().mockResolvedValue(retestOk(TENANT_A));
    const app = h.app({
      verifyBindingCookie: () => consentBinding(TENANT_A), beginFinalization, finalize,
      applyFinalization: vi.fn().mockResolvedValue(h.snapshot({ status: 'active', tenantId: TENANT_A })),
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
    });

    const [a, b] = await Promise.all([1, 2].map(() => app.request(`${h.path}?state=consent-state&code=c`, { headers: { cookie: 'x' } })));

    expect([a!.headers.get('location'), b!.headers.get('location')].sort())
      .toEqual([`${h.redirectBase}/active`, `${h.redirectBase}/consent_state_mismatch`].sort());
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it('a non-lifecycle failure while starting finalization is retryable (503, cookie kept)', async () => {
    const res = await h.app({
      verifyBindingCookie: () => consentBinding(TENANT_A),
      beginFinalization: vi.fn().mockRejectedValue(new Error('db down')),
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
    }).request(`${h.path}?state=consent-state&code=c`, { headers: { cookie: 'x' } });

    expect(res.status).toBe(503);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('upgrade: identity pinned to the bound tenant uses the upgrade transition and writes no failure', async () => {
    const transitionIdentityToConsent = vi.fn().mockResolvedValue({ rawState: 'consent-state', verifiedTenantId: TENANT_A });
    const verifyIdentity = vi.fn().mockResolvedValue(identityOk(TENANT_A));
    const res = await h.app({
      readSessionPurpose: vi.fn(async () => 'upgrade' as const),
      verifyBindingCookie: () => identityBinding(TENANT_A),
      consumeSession: vi.fn().mockResolvedValue(identitySession({ tenantHintHash: hashTenant(TENANT_A), purpose: 'upgrade' })),
      verifyIdentity, transitionIdentityToConsent,
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('active')),
    }).request(`${h.path}?state=id-state&code=c`, { headers: { cookie: 'x' } });

    expect(new URL(res.headers.get('location')!).pathname).toBe(`/${TENANT_A}/oauth2/authorize`);
    expect(verifyIdentity).toHaveBeenCalledWith(expect.objectContaining({ expectedTenantId: TENANT_A }));
    expect(transitionIdentityToConsent).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'upgrade', attempt: h.attempt('active') }));
  });

  it('upgrade: an identity failure never marks the live connection failed', async () => {
    const markAttemptFailed = vi.fn();
    const res = await h.app({
      readSessionPurpose: vi.fn(async () => 'upgrade' as const),
      verifyBindingCookie: () => identityBinding(TENANT_A),
      consumeSession: vi.fn().mockResolvedValue(identitySession({ tenantHintHash: hashTenant(TENANT_A), purpose: 'upgrade' })),
      verifyIdentity: vi.fn().mockResolvedValue({ success: false, errorCode: 'admin_role_required' }),
      markAttemptFailed,
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('active')),
    }).request(`${h.path}?state=id-state&code=c`, { headers: { cookie: 'x' } });

    expect(res.headers.get('location')).toBe(`${h.redirectBase}/admin_role_required`);
    expect(markAttemptFailed).not.toHaveBeenCalled();
  });

  it('upgrade: cancel at consent leaves the row untouched', async () => {
    const markAttemptFailed = vi.fn();
    const res = await h.app({
      readSessionPurpose: vi.fn(async () => 'upgrade' as const),
      verifyBindingCookie: () => consentBinding(TENANT_A),
      consumeSession: vi.fn().mockResolvedValue(consentSession({ purpose: 'upgrade' })), markAttemptFailed,
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('active')),
    }).request(`${h.path}?state=consent-state&error=access_denied&error_description=AADSTS65004`, { headers: { cookie: 'x' } });

    expect(res.headers.get('location')).toBe(`${h.redirectBase}/consent_cancelled`);
    expect(markAttemptFailed).not.toHaveBeenCalled();
  });

  it('upgrade: finalization applies in place and reports the in-band failure', async () => {
    const current = M365_PERMISSION_PROFILES[h.profile].version;
    const applyUpgradeFinalization = vi.fn()
      .mockResolvedValueOnce({ connection: h.snapshot({ status: 'active', tenantId: TENANT_A, permissionManifestVersion: current }), failureCode: null })
      .mockResolvedValueOnce({ connection: h.snapshot({ status: 'active', tenantId: TENANT_A, permissionManifestVersion: current - 1 }), failureCode: 'tenant_mismatch' });
    const app = h.app({
      readSessionPurpose: vi.fn(async () => 'upgrade' as const),
      verifyBindingCookie: () => consentBinding(TENANT_A),
      beginFinalization: vi.fn().mockResolvedValue({ attempt: h.attempt('active'), purpose: 'upgrade', verified: verified(TENANT_A), actorId: USER_ID }),
      finalize: vi.fn().mockResolvedValue(retestOk(TENANT_A)),
      applyUpgradeFinalization,
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('active')),
    });

    const promoted = await app.request(`${h.path}?state=consent-state&code=c`, { headers: { cookie: 'x' } });
    const refused = await app.request(`${h.path}?state=consent-state&code=c`, { headers: { cookie: 'x' } });

    expect(applyUpgradeFinalization).toHaveBeenCalledWith(h.attempt('active'), { verifiedTenantId: TENANT_A, result: retestOk(TENANT_A) });
    expect(promoted.headers.get('location')).toBe(`${h.redirectBase}/active`);
    expect(refused.headers.get('location')).toBe(`${h.redirectBase}/tenant_mismatch`);
  });

  it("guest admin home tenant: identity verified in the admin's home tenant targets consent at THAT tenant, never the org's intended one, and the audit records it", async () => {
    // /organizations resolved the admin's home tenant HOME; Breeze cannot know the intent.
    const audit = vi.fn();
    const res = await h.app({
      verifyBindingCookie: () => identityBinding(null),
      consumeSession: vi.fn().mockResolvedValue(identitySession({ tenantHintHash: null })),
      verifyIdentity: vi.fn().mockResolvedValue({ ...identityOk(HOME), administratorUsername: 'tech@msp.example' }),
      transitionIdentityToConsent: vi.fn().mockResolvedValue({ rawState: 'cs', verifiedTenantId: HOME }), audit,
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
    }).request(`${h.path}?state=id-state&code=c`, { headers: { cookie: 'x' } });

    expect(new URL(res.headers.get('location')!).pathname).toBe(`/${HOME}/oauth2/authorize`);
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ event: h.events.adminIdentityVerified, verifiedTenantId: HOME }));
    // W3 Task 14 replaces this redirect with the confirm-tenant interstitial for organizations sign-ins.
  });

  it.each(['identity', 'consent'] as const)('a provider error in the %s phase is consent_cancelled and marks the initial attempt failed', async (phase) => {
    const markAttemptFailed = vi.fn().mockResolvedValue(h.snapshot());
    const verifyIdentity = vi.fn();
    const binding = phase === 'identity' ? identityBinding(null) : consentBinding(TENANT_A);
    const session = phase === 'identity' ? identitySession({ tenantHintHash: null }) : consentSession();
    const consumeSession = vi.fn().mockResolvedValue(session);
    const res = await h.app({
      verifyBindingCookie: () => binding, consumeSession, markAttemptFailed, verifyIdentity,
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
    }).request(`${h.path}?state=${binding.rawState}&error=access_denied&error_description=AADSTS65004`, { headers: { cookie: 'x' } });

    expect(res.headers.get('location')).toBe(`${h.redirectBase}/consent_cancelled`);
    expect(consumeSession).toHaveBeenCalledWith(expect.objectContaining({ phase: binding.phase }));
    expect(markAttemptFailed).toHaveBeenCalledWith(h.attempt('pending-consent'), 'consent_cancelled');
    expect(verifyIdentity).not.toHaveBeenCalled();
  });

  const PHASES = [
    ['identity', () => identityBinding(null), () => identitySession({ tenantHintHash: null })],
    ['consent', () => consentBinding(TENANT_A), () => consentSession()],
  ] as const;

  it.each(PHASES)('production AADSTS50097 redirect in the %s phase is conditional_access_blocked, marks the attempt failed, binds nothing', async (_phase, makeBinding, makeSession) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const binding = makeBinding();
    const markAttemptFailed = vi.fn().mockResolvedValue(h.snapshot());
    const verifyIdentity = vi.fn();
    const finalize = vi.fn();
    const transitionIdentityToConsent = vi.fn();
    const beginFinalization = vi.fn();
    const consumeSession = vi.fn().mockResolvedValue(makeSession());
    const audit = vi.fn();
    const res = await h.app({
      verifyBindingCookie: () => binding, consumeSession, markAttemptFailed, audit,
      verifyIdentity, finalize, transitionIdentityToConsent, beginFinalization,
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
    }).request(`${h.path}?${REAL_CA_ERROR_QUERY(binding.rawState)}`, { headers: { cookie: 'x' } });

    expect(res.headers.get('location')).toBe(`${h.redirectBase}/conditional_access_blocked`);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(consumeSession).toHaveBeenCalledWith(expect.objectContaining({ phase: binding.phase }));
    expect(markAttemptFailed).toHaveBeenCalledWith(h.attempt('pending-consent'), 'conditional_access_blocked');
    expect(verifyIdentity).not.toHaveBeenCalled();
    expect(transitionIdentityToConsent).not.toHaveBeenCalled();
    expect(beginFinalization).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: h.events.verificationFailed, outcome: 'conditional_access_blocked', actorId: USER_ID,
    }));
    // Support identifiers are logged; Microsoft's free text never is.
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('50097');
    expect(logged).toContain('5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b');
    expect(logged).not.toContain('Device authentication');
    expect(JSON.stringify(audit.mock.calls)).not.toContain('Device authentication');
    warn.mockRestore();
  });

  it.each(PHASES)('access_denied + error_subcode=cancel in the %s phase is consent_cancelled', async (_phase, makeBinding, makeSession) => {
    const binding = makeBinding();
    const markAttemptFailed = vi.fn().mockResolvedValue(h.snapshot());
    const res = await h.app({
      verifyBindingCookie: () => binding, markAttemptFailed,
      consumeSession: vi.fn().mockResolvedValue(makeSession()),
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
    }).request(`${h.path}?state=${binding.rawState}&error=access_denied&error_subcode=cancel`, { headers: { cookie: 'x' } });

    expect(res.headers.get('location')).toBe(`${h.redirectBase}/consent_cancelled`);
    expect(markAttemptFailed).toHaveBeenCalledWith(h.attempt('pending-consent'), 'consent_cancelled');
  });

  it.each(PHASES)('any other provider error in the %s phase is consent_provider_error', async (_phase, makeBinding, makeSession) => {
    const binding = makeBinding();
    const markAttemptFailed = vi.fn().mockResolvedValue(h.snapshot());
    const res = await h.app({
      verifyBindingCookie: () => binding, markAttemptFailed,
      consumeSession: vi.fn().mockResolvedValue(makeSession()),
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
    }).request(`${h.path}?state=${binding.rawState}&error=server_error&error_description=AADSTS700016%3A+x`, { headers: { cookie: 'x' } });

    expect(res.headers.get('location')).toBe(`${h.redirectBase}/consent_provider_error`);
    expect(markAttemptFailed).toHaveBeenCalledWith(h.attempt('pending-consent'), 'consent_provider_error');
  });

  it.each(PHASES)('upgrade: a Conditional Access error in the %s phase leaves the live row untouched', async (_phase, makeBinding) => {
    const binding = makeBinding();
    const markAttemptFailed = vi.fn();
    const session = binding.phase === 'identity_verification'
      ? identitySession({ tenantHintHash: hashTenant(TENANT_A), purpose: 'upgrade' })
      : consentSession({ purpose: 'upgrade' });
    const res = await h.app({
      readSessionPurpose: vi.fn(async () => 'upgrade' as const),
      verifyBindingCookie: () => binding, markAttemptFailed,
      consumeSession: vi.fn().mockResolvedValue(session),
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('active')),
    }).request(`${h.path}?${REAL_CA_ERROR_QUERY(binding.rawState)}`, { headers: { cookie: 'x' } });

    expect(res.headers.get('location')).toBe(`${h.redirectBase}/conditional_access_blocked`);
    expect(markAttemptFailed).not.toHaveBeenCalled();
  });

  it.each(PHASES)('a provider error with the wrong state in the %s phase is consent_state_mismatch and consumes nothing', async (_phase, makeBinding) => {
    const consumeSession = vi.fn();
    const loadAttempt = vi.fn();
    const markAttemptFailed = vi.fn();
    const res = await h.app({ verifyBindingCookie: () => makeBinding(), consumeSession, loadAttempt, markAttemptFailed })
      .request(`${h.path}?${REAL_CA_ERROR_QUERY('other-state')}`, { headers: { cookie: 'x' } });

    expect(res.headers.get('location')).toBe(`${h.redirectBase}/consent_state_mismatch`);
    expect(consumeSession).not.toHaveBeenCalled();
    expect(markAttemptFailed).not.toHaveBeenCalled();
  });

  it.each(PHASES)('a provider error with an unknown key in the %s phase is consent_state_mismatch', async (_phase, makeBinding) => {
    const binding = makeBinding();
    const consumeSession = vi.fn();
    const markAttemptFailed = vi.fn();
    const res = await h.app({ verifyBindingCookie: () => binding, consumeSession, markAttemptFailed, loadAttempt: vi.fn() })
      .request(`${h.path}?state=${binding.rawState}&error=access_denied&foo=bar`, { headers: { cookie: 'x' } });

    expect(res.headers.get('location')).toBe(`${h.redirectBase}/consent_state_mismatch`);
    expect(consumeSession).not.toHaveBeenCalled();
    expect(markAttemptFailed).not.toHaveBeenCalled();
  });

  it.each(['legacy', 'expired'] as const)('a %s browser binding restarts with consent_expired and touches nothing', async (state) => {
    const loadAttempt = vi.fn();
    const res = await h.app({ verifyBindingCookie: () => state, loadAttempt })
      .request(`${h.path}?state=old&tenant=${TENANT_A}&admin_consent=True`, { headers: { cookie: 'x' } });
    expect(res.headers.get('location')).toBe(`${h.redirectBase}/consent_expired`);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(loadAttempt).not.toHaveBeenCalled();
  });

  it('a missing or invalid binding is consent_state_mismatch before any state lookup', async () => {
    const loadAttempt = vi.fn();
    const readSessionPurpose = vi.fn();
    const res = await h.app({ verifyBindingCookie: () => null, loadAttempt, readSessionPurpose })
      .request(`${h.path}?state=s&code=c`);
    expect(res.headers.get('location')).toBe(`${h.redirectBase}/consent_state_mismatch`);
    expect(loadAttempt).not.toHaveBeenCalled();
    expect(readSessionPurpose).not.toHaveBeenCalled();
  });

  it('a pre-W1 executor (verify-identity 404 → client throws) is executor_unavailable and marks the attempt failed', async () => {
    const markAttemptFailed = vi.fn().mockResolvedValue(h.snapshot());
    const transitionIdentityToConsent = vi.fn();
    const res = await h.app({
      verifyBindingCookie: () => identityBinding(null),
      consumeSession: vi.fn().mockResolvedValue(identitySession({ tenantHintHash: null })),
      verifyIdentity: vi.fn().mockRejectedValue(new Error('m365_executor_http_404')), markAttemptFailed, transitionIdentityToConsent,
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
    }).request(`${h.path}?state=id-state&code=c`, { headers: { cookie: 'x' } });

    expect(res.headers.get('location')).toBe(`${h.redirectBase}/executor_unavailable`);
    expect(markAttemptFailed).toHaveBeenCalledWith(h.attempt('pending-consent'), 'executor_unavailable');
    expect(transitionIdentityToConsent).not.toHaveBeenCalled();
  });

  it('an executor failure during finalization marks the verifying attempt failed and binds nothing', async () => {
    const markAttemptFailed = vi.fn().mockResolvedValue(h.snapshot());
    const applyFinalization = vi.fn();
    const res = await h.app({
      verifyBindingCookie: () => consentBinding(TENANT_A),
      beginFinalization: vi.fn().mockResolvedValue({ attempt: h.attempt('verifying'), purpose: 'initial', verified: verified(TENANT_A), actorId: USER_ID }),
      finalize: vi.fn().mockRejectedValue(new Error('executor down')), markAttemptFailed, applyFinalization,
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
    }).request(`${h.path}?state=consent-state&code=c`, { headers: { cookie: 'x' } });

    expect(res.headers.get('location')).toBe(`${h.redirectBase}/executor_unavailable`);
    expect(markAttemptFailed).toHaveBeenCalledWith(h.attempt('verifying'), 'executor_unavailable');
    expect(applyFinalization).not.toHaveBeenCalled();
  });

  it('a failed application proof redirects its specific outcome and audits verification_failed', async () => {
    const audit = vi.fn();
    const res = await h.app({
      verifyBindingCookie: () => consentBinding(TENANT_A),
      beginFinalization: vi.fn().mockResolvedValue({ attempt: h.attempt('verifying'), purpose: 'initial', verified: verified(TENANT_A), actorId: USER_ID }),
      finalize: vi.fn().mockResolvedValue({ success: false, errorCode: 'application_token_invalid' }),
      applyFinalization: vi.fn().mockResolvedValue(h.snapshot({ status: 'pending-consent', lastErrorCode: 'application_token_invalid' })),
      audit,
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
    }).request(`${h.path}?state=consent-state&code=c`, { headers: { cookie: 'x' } });

    expect(res.headers.get('location')).toBe(`${h.redirectBase}/application_token_invalid`);
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: h.events.verificationFailed, outcome: 'application_token_invalid', actorId: USER_ID,
    }));
    expect(audit).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ event: h.events.tenantBindingVerified }));
  });

  it('maps a tenant_already_bound binding conflict to its own outcome', async () => {
    const res = await h.app({
      verifyBindingCookie: () => consentBinding(TENANT_A),
      beginFinalization: vi.fn().mockResolvedValue({ attempt: h.attempt('verifying'), purpose: 'initial', verified: verified(TENANT_A), actorId: USER_ID }),
      finalize: vi.fn().mockResolvedValue(retestOk(TENANT_A)),
      applyFinalization: vi.fn().mockRejectedValue(lifecycle('tenant_already_bound')),
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
    }).request(`${h.path}?state=consent-state&code=c`, { headers: { cookie: 'x' } });

    expect(res.headers.get('location')).toBe(`${h.redirectBase}/tenant_already_bound`);
  });
});

describe('cross-profile isolation', () => {
  it('a binding whose connection belongs to the other profile resolves no attempt', async () => {
    const store = new Map<string, Profile>([[CONNECTION_ID, 'customer-graph-read']]);
    function loadAttemptScopedTo(profile: Profile) {
      return vi.fn(async (binding: { connectionId: string }) => (store.get(binding.connectionId) === profile
        ? { id: binding.connectionId, orgId: ORG_ID, profile, consentAttemptId: ATTEMPT_ID, status: 'pending-consent' as const }
        : null));
    }
    const actions = harness('customer-graph-actions');
    const actionsLoad = loadAttemptScopedTo('customer-graph-actions');
    const consumeSession = vi.fn();
    const crossed = await actions.app({ verifyBindingCookie: () => identityBinding(null), loadAttempt: actionsLoad, consumeSession })
      .request(`${actions.path}?state=id-state&code=c`, { headers: { cookie: 'x' } });
    expect(crossed.headers.get('location')).toBe(`${actions.redirectBase}/consent_state_mismatch`);
    expect(actionsLoad).toHaveBeenCalledOnce();
    expect(consumeSession).not.toHaveBeenCalled();

    store.set(CONNECTION_ID, 'customer-graph-actions');
    const read = harness('customer-graph-read');
    const readLoad = loadAttemptScopedTo('customer-graph-read');
    const readCrossed = await read.app({ verifyBindingCookie: () => identityBinding(null), loadAttempt: readLoad, consumeSession })
      .request(`${read.path}?state=id-state&code=c`, { headers: { cookie: 'x' } });
    expect(readCrossed.headers.get('location')).toBe(`${read.redirectBase}/consent_state_mismatch`);
    expect(consumeSession).not.toHaveBeenCalled();
  });

  describe('cookie layer with the real (unmocked) binding functions', () => {
    const ORIGINAL_KEY = process.env.APP_ENCRYPTION_KEY;
    const KEY = 'test-cross-profile-binding-key';

    beforeEach(() => { process.env.APP_ENCRYPTION_KEY = KEY; });
    afterEach(() => {
      if (ORIGINAL_KEY === undefined) delete process.env.APP_ENCRYPTION_KEY;
      else process.env.APP_ENCRYPTION_KEY = ORIGINAL_KEY;
    });

    function cookieHeaderOnly(setCookie: string): string {
      return setCookie.slice(0, setCookie.indexOf(';'));
    }

    it('rejects a real read-issued binding cookie presented to the actions callback', async () => {
      const readCookie = buildM365ConsentBindingCookie(identityBinding(null));
      const renamed = cookieHeaderOnly(readCookie).replace('breeze_m365_graph_read_consent=', 'breeze_m365_graph_actions_consent=');
      const app = new Hono().route('/api/v1/m365', m365ActionsConsentCallbackRoutes);
      for (const cookie of [cookieHeaderOnly(readCookie), renamed]) {
        const response = await app.request('/api/v1/m365/actions-consent/callback?state=id-state&code=code', { headers: { cookie } });
        expect(response.headers.get('location')).toBe('/integrations#m365/customer-graph-actions/consent_state_mismatch');
      }
    });

    it('rejects a real actions-issued binding cookie presented to the read callback', async () => {
      const actionsCookie = buildM365ActionsConsentBindingCookie(consentBinding(TENANT_A));
      const app = new Hono().route('/api/v1/m365', m365ConsentCallbackRoutes);
      const response = await app.request('/api/v1/m365/consent/callback?state=consent-state&code=code', {
        headers: { cookie: cookieHeaderOnly(actionsCookie) },
      });
      expect(response.headers.get('location')).toBe('/integrations#m365/customer-graph-read/consent_state_mismatch');
    });

    it.each([
      ['read', 'breeze_m365_graph_read_consent', 'breeze:m365-customer-graph-read:browser-binding:v1', m365ConsentCallbackRoutes, '/api/v1/m365/consent/callback', 'customer-graph-read'],
      ['actions', 'breeze_m365_graph_actions_consent', 'breeze:m365-customer-graph-actions:browser-binding:v1', m365ActionsConsentCallbackRoutes, '/api/v1/m365/actions-consent/callback', 'customer-graph-actions'],
    ] as const)('a real in-flight v1 (%s) cookie from before the deploy restarts with consent_expired', async (_n, name, context, routes, path, profile) => {
      const payload = Buffer.from(JSON.stringify({
        phase: 'admin_consent', rawState: 'old', connectionId: CONNECTION_ID, consentAttemptId: ATTEMPT_ID,
        tenantHint: null, expiresAt: Math.floor(Date.now() / 1000) + 300,
      })).toString('base64url');
      const mac = createHmac('sha256', KEY).update(`${context}.${payload}`).digest('base64url');
      const app = new Hono().route('/api/v1/m365', routes);
      const response = await app.request(`${path}?state=old&tenant=${TENANT_A}&admin_consent=True`, {
        headers: { cookie: `${name}=${payload}.${mac}` },
      });
      expect(response.headers.get('location')).toBe(`/integrations#m365/${profile}/consent_expired`);
    });
  });
});

describe('tenant sync lifecycle from the consent callback (W05, spec §5.8/§10.1)', () => {
  function initialConsent(applied: { status: 'active' | 'degraded' | 'pending-consent'; lastErrorCode: string | null }, profile: Profile = 'customer-graph-read') {
    const h = harness(profile);
    return {
      h,
      app: h.app({
        verifyBindingCookie: () => consentBinding(TENANT_A),
        beginFinalization: vi.fn().mockResolvedValue({ attempt: h.attempt('verifying'), purpose: 'initial', verified: verified(TENANT_A), actorId: USER_ID }),
        finalize: vi.fn().mockResolvedValue(retestOk(TENANT_A)),
        applyFinalization: vi.fn().mockResolvedValue(h.snapshot({
          tenantId: applied.status === 'pending-consent' ? null : TENANT_A, status: applied.status, lastErrorCode: applied.lastErrorCode,
        })),
        // Lifecycle hooks stay the real defaults (the module is mocked above).
        loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
      }),
    };
  }

  function upgradeConsent(manifestVersion: number, failureCode: string | null = null) {
    const h = harness('customer-graph-read');
    return {
      h,
      app: h.app({
        readSessionPurpose: vi.fn(async () => 'upgrade' as const),
        verifyBindingCookie: () => consentBinding(TENANT_A),
        beginFinalization: vi.fn().mockResolvedValue({ attempt: h.attempt('active'), purpose: 'upgrade', verified: verified(TENANT_A), actorId: USER_ID }),
        finalize: vi.fn().mockResolvedValue(retestOk(TENANT_A, manifestVersion)),
        applyUpgradeFinalization: vi.fn().mockResolvedValue({
          connection: h.snapshot({ tenantId: TENANT_A, status: 'active', permissionManifestVersion: manifestVersion }),
          failureCode,
        }),
        loadAttempt: vi.fn().mockResolvedValue(h.attempt('active')),
      }),
    };
  }

  async function run({ h, app }: { h: Harness; app: Hono }) {
    return app.request(`${h.path}?state=consent-state&code=c`, { headers: { cookie: 'x' } });
  }

  it('seeds the sync when a first-time consent verifies ACTIVE', async () => {
    const response = await run(initialConsent({ status: 'active', lastErrorCode: null }));
    expect(response.headers.get('location')).toContain('/active');
    expect(syncMocks.consented).toHaveBeenCalledWith({ id: CONNECTION_ID, orgId: ORG_ID, tenantId: TENANT_A, status: 'active' });
    expect(syncMocks.upgraded).not.toHaveBeenCalled();
  });

  it('seeds a DEGRADED connection too', async () => {
    await run(initialConsent({ status: 'degraded', lastErrorCode: 'grant_missing' }));
    expect(syncMocks.consented).toHaveBeenCalledWith(expect.objectContaining({ status: 'degraded' }));
  });

  it('does not seed when verification did not leave the connection executable', async () => {
    await run(initialConsent({ status: 'pending-consent', lastErrorCode: 'tenant_mismatch' }));
    expect(syncMocks.consented).not.toHaveBeenCalled();
  });

  it('does not seed when the tenant-sync flag is off', async () => {
    syncMocks.flag.mockReturnValue(false);
    await run(initialConsent({ status: 'active', lastErrorCode: null }));
    expect(syncMocks.consented).not.toHaveBeenCalled();
  });

  it('never seeds from the ACTIONS profile callback — the sync reads only through the read connection', async () => {
    const response = await run(initialConsent({ status: 'active', lastErrorCode: null }, 'customer-graph-actions'));
    expect(response.headers.get('location')).toContain('/active');
    expect(syncMocks.consented).not.toHaveBeenCalled();
  });

  it('still redirects successfully when the seeding hook throws', async () => {
    syncMocks.consented.mockRejectedValueOnce(new Error('seed boom'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await run(initialConsent({ status: 'active', lastErrorCode: null }));
      expect(response.headers.get('location')).toContain('/active');
    } finally { spy.mockRestore(); }
  });

  it('re-arms needs_consent domains after an upgrade PROMOTED the manifest, and does not re-seed', async () => {
    const response = await run(upgradeConsent(3));
    expect(response.headers.get('location')).toContain('/active');
    expect(syncMocks.upgraded).toHaveBeenCalledWith({ id: CONNECTION_ID, orgId: ORG_ID });
    expect(syncMocks.consented).not.toHaveBeenCalled();
  });

  it('does not re-arm when the upgrade failed in band (a deliberate no-op on the row)', async () => {
    await run(upgradeConsent(2, 'tenant_mismatch'));
    expect(syncMocks.upgraded).not.toHaveBeenCalled();
  });

  it('does not re-arm when the flag is off', async () => {
    syncMocks.flag.mockReturnValue(false);
    await run(upgradeConsent(3));
    expect(syncMocks.upgraded).not.toHaveBeenCalled();
  });

  it('redirects degraded-with-cause when the upgrade did not move the manifest', async () => {
    const response = await run(upgradeConsent(2, 'grant_missing'));
    expect(response.headers.get('location')).toContain('/grant_missing');
  });
});
