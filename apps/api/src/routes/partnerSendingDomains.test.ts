import { findProviderImports } from '../services/emailDomains/providerImportScan';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  gateOrder: [] as string[],
  authMiddleware: vi.fn(),
  requireScope: vi.fn((...scopes: string[]) => async (_c: any, next: any) => {
    mocks.gateOrder.push(`scope:${scopes.join(',')}`);
    return next();
  }),
  requirePartner: vi.fn(async (c: any, next: any) => {
    mocks.gateOrder.push('partner');
    return c.get('auth')?.partnerId ? next() : c.json({ error: 'Partner context required' }, 403);
  }),
  permissionAllowed: { value: true },
  mfaAllowed: { value: true },
  capabilityAllowed: { value: true },
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    mocks.gateOrder.push(`permission:${resource}:${action}`);
    return mocks.permissionAllowed.value ? next() : c.json({ error: 'Insufficient permissions' }, 403);
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    mocks.gateOrder.push('mfa');
    return mocks.mfaAllowed.value ? next() : c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403);
  }),
  requireCapability: vi.fn((cap: string) => async (c: any, next: any) => {
    mocks.gateOrder.push(`capability:${cap}`);
    return mocks.capabilityAllowed.value ? next() : c.json({ error: 'capability denied' }, 403);
  }),
  partnerWideAllowed: vi.fn(() => true),
  audit: vi.fn(),
  enqueueTestSend: vi.fn(async () => undefined),
  // Parameters declared, not inferred: a bare `vi.fn(async () => …)` infers a
  // ZERO-argument signature, and `.mock.calls[0]![1]` is then a tsc error on an
  // empty tuple. Vitest transpiles without types, so it only shows in tsc.
  rateLimiter: vi.fn(async (_redis: unknown, _key: string, _limit: number, _window: number) =>
    ({ allowed: true, remaining: 4, resetAt: new Date() })),
  service: {
    listSendingDomains: vi.fn(),
    createSendingDomain: vi.fn(),
    requestDomainCheck: vi.fn(),
    requestDomainRemoval: vi.fn(),
    upsertSenderIdentity: vi.fn(),
    deleteSenderIdentity: vi.fn(),
    getSendingDomainsCapability: vi.fn(),
  },
  laneConfigured: { value: true },
  partnerRow: { value: { id: '', status: 'active', trustState: 'trusted', probationEnrollments: 0 } as Record<string, unknown> | null },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: mocks.authMiddleware,
  requireScope: mocks.requireScope,
  requirePartner: mocks.requirePartner,
  requirePermission: mocks.requirePermission,
  requireMfa: mocks.requireMfa,
}));
vi.mock('../services/partnerTrust', () => ({ requireCapability: mocks.requireCapability }));
vi.mock('../services/partnerWideAccess', () => ({
  canManagePartnerWidePolicies: mocks.partnerWideAllowed,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE: 'Full partner access required',
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: mocks.audit }));
vi.mock('../services/permissions', () => ({
  PERMISSIONS: { ORGS_READ: { resource: 'organizations', action: 'read' }, ORGS_WRITE: { resource: 'organizations', action: 'write' } },
}));
vi.mock('../services/rate-limit', () => ({ rateLimiter: mocks.rateLimiter }));
vi.mock('../services/redis', () => ({ getRedis: () => ({}) }));
vi.mock('../jobs/sendingDomainsWorker', () => ({ enqueueTestSend: mocks.enqueueTestSend }));
vi.mock('../services/emailDomains/config', () => ({ isPartnerLaneConfigured: () => mocks.laneConfigured.value }));
vi.mock('../services/emailDomains/sendingDomainService', async () => {
  class SendingDomainServiceError extends Error {
    constructor(public code: string, message: string, public status: number) { super(message); }
  }
  return { ...mocks.service, SendingDomainServiceError, DOMAIN_UNAVAILABLE_MESSAGE: 'unavailable' };
});
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      const c: Record<string, unknown> = {};
      for (const m of ['from', 'where', 'limit']) c[m] = vi.fn(() => c);
      (c as { then: unknown }).then = (r: (v: unknown) => unknown) =>
        Promise.resolve(mocks.partnerRow.value ? [mocks.partnerRow.value] : []).then(r);
      return c;
    }),
  },
}));

import { SendingDomainServiceError, type SendingDomainErrorCode } from '../services/emailDomains/sendingDomainService';
import { partnerSendingDomainsRoutes } from './partnerSendingDomains';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const DOMAIN_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';

const registeredScopeCalls = mocks.requireScope.mock.calls.map((c) => c.map(String));
const registeredCapabilityCalls = mocks.requireCapability.mock.calls.map((c) => String(c[0]));
const registeredMfaCount = mocks.requireMfa.mock.calls.length;

function auth(partnerId: string | null = PARTNER_ID, scope = 'partner') {
  mocks.authMiddleware.mockImplementation((c: any, next: any) => {
    mocks.gateOrder.push('auth');
    c.set('auth', { scope, partnerId, partnerOrgAccess: 'all', user: { id: USER_ID, email: 'tech@acme.test' }, token: { mfa: true } });
    c.set('permissions', { permissions: [{ resource: '*', action: '*' }] });
    return next();
  });
}

function buildApp(): Hono {
  const app = new Hono();
  app.route('/partner/sending-domains', partnerSendingDomainsRoutes);
  return app;
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.gateOrder.length = 0;
  mocks.permissionAllowed.value = true;
  mocks.mfaAllowed.value = true;
  mocks.capabilityAllowed.value = true;
  mocks.partnerWideAllowed.mockReturnValue(true);
  mocks.laneConfigured.value = true;
  mocks.partnerRow.value = { id: PARTNER_ID, status: 'active', trustState: 'trusted', probationEnrollments: 0 };
  mocks.rateLimiter.mockResolvedValue({ allowed: true, remaining: 4, resetAt: new Date() });
  mocks.service.listSendingDomains.mockResolvedValue({ capability: { supported: true }, domains: [], identities: [] });
  auth();
});

describe('gate registration (spec §7)', () => {
  it('reads require partner scope; writes additionally require MFA and the custom_sending_domain capability', () => {
    expect(registeredScopeCalls.some((c) => c.includes('partner'))).toBe(true);
    expect(registeredMfaCount).toBeGreaterThan(0);
    expect(registeredCapabilityCalls).toContain('custom_sending_domain');
  });

  it('mentions canManagePartnerWidePolicies, which partner-wide-write-coverage requires of this surface', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(__dirname, 'partnerSendingDomains.ts'), 'utf8');
    expect(src).toContain('canManagePartnerWidePolicies');
  });
});

describe('unsupported instance', () => {
  it('404s every route with sending_domains_unsupported when no provider is configured', async () => {
    mocks.laneConfigured.value = false;
    const app = buildApp();
    const calls: Array<[string, RequestInit | undefined]> = [
      ['/partner/sending-domains', undefined],
      ['/partner/sending-domains', json({ domain: 'mail.acme.test' })],
      [`/partner/sending-domains/${DOMAIN_ID}/check`, { method: 'POST' }],
      [`/partner/sending-domains/${DOMAIN_ID}`, { method: 'DELETE' }],
      ['/partner/sending-domains/identities/support', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' }],
      ['/partner/sending-domains/identities/support', { method: 'DELETE' }],
      [`/partner/sending-domains/${DOMAIN_ID}/test`, { method: 'POST' }],
    ];
    for (const [path, init] of calls) {
      const res = await app.request(path, init);
      expect(res.status, path).toBe(404);
      expect((await res.json()).error, path).toBe('sending_domains_unsupported');
    }
  });
});

describe('authz matrix', () => {
  it('403s a request with no partner context', async () => {
    auth(null);
    const res = await buildApp().request('/partner/sending-domains');
    expect(res.status).toBe(403);
  });

  it('403s a write without MFA and never touches the service', async () => {
    mocks.mfaAllowed.value = false;
    const res = await buildApp().request('/partner/sending-domains', json({ domain: 'mail.acme.test' }));
    expect(res.status).toBe(403);
    expect(mocks.service.createSendingDomain).not.toHaveBeenCalled();
  });

  it('403s a write for a partner without the capability', async () => {
    mocks.capabilityAllowed.value = false;
    const res = await buildApp().request('/partner/sending-domains', json({ domain: 'mail.acme.test' }));
    expect(res.status).toBe(403);
    expect(mocks.service.createSendingDomain).not.toHaveBeenCalled();
  });

  it('403s a write without organizations:write', async () => {
    mocks.permissionAllowed.value = false;
    const res = await buildApp().request(`/partner/sending-domains/${DOMAIN_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('403s EVERY write for a partner user without full partner access (epic #2135)', async () => {
    mocks.partnerWideAllowed.mockReturnValue(false);
    const app = buildApp();
    const writes: Array<[string, RequestInit]> = [
      ['/partner/sending-domains', json({ domain: 'mail.acme.test' })],
      [`/partner/sending-domains/${DOMAIN_ID}/check`, { method: 'POST' }],
      [`/partner/sending-domains/${DOMAIN_ID}`, { method: 'DELETE' }],
      ['/partner/sending-domains/identities/support', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sendingDomainId: DOMAIN_ID, localPart: 'support' }),
      }],
      ['/partner/sending-domains/identities/support', { method: 'DELETE' }],
      [`/partner/sending-domains/${DOMAIN_ID}/test`, { method: 'POST' }],
    ];
    for (const [path, init] of writes) {
      const res = await app.request(path, init);
      expect(res.status, path).toBe(403);
      expect((await res.json()).error, path).toBe('Full partner access required');
    }
    expect(mocks.service.createSendingDomain).not.toHaveBeenCalled();
    expect(mocks.service.upsertSenderIdentity).not.toHaveBeenCalled();
    expect(mocks.enqueueTestSend).not.toHaveBeenCalled();
  });

  it('does NOT gate the read on full partner access — an org-limited tech may still see the state', async () => {
    mocks.partnerWideAllowed.mockReturnValue(false);
    const res = await buildApp().request('/partner/sending-domains');
    expect(res.status).toBe(200);
  });

  it('does NOT gate the read on MFA or the capability — a locked-out partner must still see why', async () => {
    mocks.mfaAllowed.value = false;
    mocks.capabilityAllowed.value = false;
    const res = await buildApp().request('/partner/sending-domains');
    expect(res.status).toBe(200);
  });
});

describe('routes', () => {
  it('GET / returns the capability, domains and identities', async () => {
    mocks.service.listSendingDomains.mockResolvedValue({
      capability: { supported: true, provider: 'fake', eligible: true, maxDomains: 3, verifiesByDns: true },
      domains: [{ id: DOMAIN_ID }], identities: [],
    });
    const res = await buildApp().request('/partner/sending-domains');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ capability: { provider: 'fake' }, domains: [{ id: DOMAIN_ID }] });
  });

  it('POST / creates, audits and returns 201', async () => {
    mocks.service.createSendingDomain.mockResolvedValue({ id: DOMAIN_ID, domain: 'mail.acme.test', status: 'provisioning' });
    const res = await buildApp().request('/partner/sending-domains', json({ domain: 'mail.acme.test' }));
    expect(res.status).toBe(201);
    expect(mocks.service.createSendingDomain).toHaveBeenCalledWith({ partnerId: PARTNER_ID, domain: 'mail.acme.test', userId: USER_ID });
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'partner_sending_domain.create', resourceType: 'partner_sending_domain', resourceId: DOMAIN_ID,
    }));
  });

  it('maps every service error code to its status and never writes an audit row on failure', async () => {
    // The real SendingDomainServiceError narrows its first argument to
    // SendingDomainErrorCode, so this list is typed as that union rather than
    // as `string`.
    const cases: Array<[SendingDomainErrorCode, 400 | 404 | 409 | 429]> = [
      ['domain_invalid', 400], ['domain_unavailable', 409], ['domain_limit_reached', 409],
      ['rate_limited', 429], ['not_found', 404], ['domain_not_sendable', 409],
    ];
    for (const [code, status] of cases) {
      vi.clearAllMocks();
      auth();
      mocks.service.createSendingDomain.mockRejectedValue(new SendingDomainServiceError(code, 'nope', status));
      const res = await buildApp().request('/partner/sending-domains', json({ domain: 'mail.acme.test' }));
      expect(res.status, code).toBe(status);
      expect((await res.json()).error, code).toBe(code);
      expect(mocks.audit, code).not.toHaveBeenCalled();
    }
  });

  it('422s an invalid body before the service is reached', async () => {
    const res = await buildApp().request('/partner/sending-domains', json({}));
    expect([400, 422]).toContain(res.status);
    expect(mocks.service.createSendingDomain).not.toHaveBeenCalled();
  });

  it('POST /:id/check returns 202 and audits', async () => {
    mocks.service.requestDomainCheck.mockResolvedValue({ id: DOMAIN_ID, status: 'pending' });
    const res = await buildApp().request(`/partner/sending-domains/${DOMAIN_ID}/check`, { method: 'POST' });
    expect(res.status).toBe(202);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'partner_sending_domain.check' }));
  });

  it('DELETE /:id returns 202 and audits', async () => {
    mocks.service.requestDomainRemoval.mockResolvedValue(undefined);
    const res = await buildApp().request(`/partner/sending-domains/${DOMAIN_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(202);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'partner_sending_domain.remove' }));
  });

  it('PUT /identities/:stream upserts and audits', async () => {
    mocks.service.upsertSenderIdentity.mockResolvedValue({ id: 'i1', stream: 'support', localPart: 'support' });
    const res = await buildApp().request('/partner/sending-domains/identities/support', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sendingDomainId: DOMAIN_ID, localPart: 'support' }),
    });
    expect(res.status).toBe(200);
    expect(mocks.service.upsertSenderIdentity).toHaveBeenCalledWith(expect.objectContaining({ partnerId: PARTNER_ID, stream: 'support', userId: USER_ID }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'partner_sender_identity.upsert' }));
  });

  // HEADER INJECTION (spec §4.4). The From is built as `localPart@domain`, and
  // `fromWithDisplayName` sanitises only the DISPLAY NAME — the address passes
  // through verbatim — so a CRLF in the local part would forge headers. The
  // shared `senderLocalPartSchema` is the one definition the web form and the
  // API both use; the route applies it at the boundary so the payload never
  // reaches the service at all.
  it.each([
    ['crlf-bcc', 'a\r\nBcc: x@y'],
    ['bare newline', 'a\nBcc: x@y'],
    ['space', 'a b'],
    ['at-sign', 'a@b'],
    ['angle bracket', 'a<b'],
    ['consecutive dots', 'a..b'],
    ['reserved', 'postmaster'],
  ])('PUT /identities/:stream rejects a %s local part without reaching the service', async (_label, localPart) => {
    const res = await buildApp().request('/partner/sending-domains/identities/support', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sendingDomainId: DOMAIN_ID, localPart }),
    });
    expect([400, 422]).toContain(res.status);
    expect(mocks.service.upsertSenderIdentity).not.toHaveBeenCalled();
  });

  it('PUT /identities/:stream rejects a display name carrying an address', async () => {
    const res = await buildApp().request('/partner/sending-domains/identities/support', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sendingDomainId: DOMAIN_ID, localPart: 'support', displayName: 'Acme <billing@evil.test>' }),
    });
    expect([400, 422]).toContain(res.status);
    expect(mocks.service.upsertSenderIdentity).not.toHaveBeenCalled();
  });

  it('rejects an unknown stream', async () => {
    const res = await buildApp().request('/partner/sending-domains/identities/marketing', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sendingDomainId: DOMAIN_ID, localPart: 'news' }),
    });
    expect([400, 422]).toContain(res.status);
    expect(mocks.service.upsertSenderIdentity).not.toHaveBeenCalled();
  });

  it('DELETE /identities/:stream returns 204 and audits', async () => {
    const res = await buildApp().request('/partner/sending-domains/identities/billing', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'partner_sender_identity.delete' }));
  });

  it('POST /:id/test enqueues the job with the CALLING user, never a typed address', async () => {
    const res = await buildApp().request(`/partner/sending-domains/${DOMAIN_ID}/test`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'attacker@evil.test' }),
    });
    expect(res.status).toBe(202);
    expect(mocks.enqueueTestSend).toHaveBeenCalledWith(DOMAIN_ID, USER_ID);
    expect(JSON.stringify(mocks.enqueueTestSend.mock.calls)).not.toContain('attacker@evil.test');
  });

  it('limits test sends to 5 an hour per partner', async () => {
    mocks.rateLimiter.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + 60_000) });
    const res = await buildApp().request(`/partner/sending-domains/${DOMAIN_ID}/test`, { method: 'POST' });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(mocks.enqueueTestSend).not.toHaveBeenCalled();
    const [, key, limit, window] = mocks.rateLimiter.mock.calls[0]!;
    expect(String(key)).toContain(PARTNER_ID);
    expect(limit).toBe(5);
    expect(window).toBe(3600);
  });
});

describe('no route calls the provider', () => {
  it('does not import providerRegistry or any adapter, in any import form', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const routePath = path.join(__dirname, 'partnerSendingDomains.ts');
    const source = fs.readFileSync(routePath, 'utf8');
    expect(findProviderImports({ path: routePath, source })).toEqual([]);
  });

  const PLANTED = {
    'single-line static': `import { getEmailDomainProvider } from '../services/emailDomains/providerRegistry';`,
    // The form the old single-line `^import .* from` anchor silently missed.
    'multi-line static': [
      'import {',
      '  getEmailDomainProvider,',
      "} from '../services/emailDomains/providerRegistry';",
    ].join('\n'),
    'adapter import': `import { createResendDomainProvider } from '../services/emailDomains/adapters/resend';`,
    'dynamic import': `const p = await import('../services/emailDomains/providerRegistry');`,
    'require': `const p = require('../services/emailDomains/providerRegistry');`,
  };

  // CONTROL. A scan whose matcher never fires reads exactly like a clean file,
  // and that is how the old single-line anchor sat green while a wrapped import
  // would have walked straight past it.
  it.each(Object.entries(PLANTED))('flags a planted violation: %s', (_label, snippet) => {
    const source = `import { Hono } from 'hono';\n${snippet}\nexport const routes = new Hono();\n`;
    expect(findProviderImports({ path: 'planted.ts', source })).not.toEqual([]);
  });

  it('allows a type-only import of the same module', () => {
    const source = `import type { EmailDomainProvider } from '../services/emailDomains/providerRegistry';\n`
      + `import { type Foo } from '../services/emailDomains/adapters/resend';\n`;
    expect(findProviderImports({ path: 'types.ts', source })).toEqual([]);
  });
});
