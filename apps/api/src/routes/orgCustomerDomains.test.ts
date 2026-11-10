import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * Route tests for the org-scoped customer domain + verification routes
 * (portal registration W5 #11382, Task 7). The verification service and the
 * ticket-config CRUD service are mocked (real-DB behaviour, including the
 * repoint trigger, is proved in portalDomainVerificationRoutes.integration
 * .test.ts); the governance middleware, validators and org lookup are real.
 */
const h = vi.hoisted(() => {
  const store = { orgs: [] as Array<{ id: string; partnerId: string }> };
  const db = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => {
          const rows = store.orgs.map((r) => ({ ...r }));
          return Object.assign(Promise.resolve(rows), { limit: async (n: number) => rows.slice(0, n) });
        },
      }),
    })),
  };
  const ctx = { outsideDepth: 0 };
  return {
    store,
    db,
    ctx,
    authRef: { current: null as any },
    auditSpy: vi.fn(),
    svc: {
      listOrgCustomerDomains: vi.fn(),
      startDnsVerification: vi.fn(),
      removeCustomerDomainVerification: vi.fn(),
      verifyCustomerDomain: vi.fn(),
    },
    crud: {
      createCustomerEmailDomain: vi.fn(),
      updateCustomerEmailDomain: vi.fn(),
      deleteCustomerEmailDomain: vi.fn(),
    },
    rate: vi.fn(),
  };
});

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!h.authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', h.authRef.current);
    c.set('permissions', h.authRef.current.permissions);
    await next();
  }),
  requireScope: (...scopes: string[]) => async (c: any, next: any) => {
    if (!scopes.includes(c.get('auth').scope)) return c.json({ error: 'Insufficient permissions' }, 403);
    await next();
  },
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    const perms: string[] | undefined = c.get('auth').perms;
    if (perms && !perms.includes(`${resource}:${action}`)) return c.json({ error: 'Permission denied' }, 403);
    await next();
  },
}));

vi.mock('../db', () => ({
  db: h.db,
  runOutsideDbContext: (fn: () => unknown) => {
    h.ctx.outsideDepth += 1;
    try {
      return fn();
    } finally {
      h.ctx.outsideDepth -= 1;
    }
  },
}));

vi.mock('../services/auditEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/auditEvents')>()),
  writeRouteAudit: (...args: unknown[]) => h.auditSpy(...args),
}));

vi.mock('../services/portalDomainVerification', () => {
  class DomainVerificationError extends Error {
    constructor(readonly code: string, readonly httpStatus: 404 | 409, message: string) {
      super(message);
      this.name = 'DomainVerificationError';
    }
  }
  return { DomainVerificationError, ...h.svc };
});

vi.mock('../services/ticketConfigService', () => {
  class TicketConfigServiceError extends Error {
    constructor(message: string, readonly status: number, readonly code: string) {
      super(message);
    }
  }
  return { TicketConfigServiceError, ...h.crud };
});

vi.mock('../services/portal/rateLimit', () => ({ checkRateLimit: (...args: unknown[]) => h.rate(...args) }));

import { authMiddleware } from '../middleware/auth';
import { DomainVerificationError } from '../services/portalDomainVerification';
import { TicketConfigServiceError } from '../services/ticketConfigService';
import { registerOrgCustomerDomainRoutes } from './orgCustomerDomains';

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';
const PARTNER_ID = '5d0a1f7e-1111-4222-8333-444455556666';
const USER_ID = '11111111-2222-4333-8444-555566667777';
const DOMAIN_ID = 'aaaaaaaa-1111-4222-8333-444455556666';
const OTHER_DOMAIN_ID = 'bbbbbbbb-1111-4222-8333-444455556666';
const BASE = `/organizations/${ORG_ID}/customer-domains`;

const ADMIN = {
  scope: 'partner',
  user: { id: USER_ID, email: 'tess@msp.example', isPlatformAdmin: false },
  partnerId: PARTNER_ID,
  orgId: null,
  partnerOrgAccess: 'all',
  permissions: { permissions: [{ resource: '*', action: '*' }] },
  canAccessOrg: (_id: string) => true,
};

function view(id: string, over: Record<string, unknown> = {}) {
  return {
    id, orgId: ORG_ID, domain: 'acme.com', isActive: true, autoCreateContact: true,
    state: 'declared', method: null, verifiedAt: null, lastCheckedAt: null, lastPassedAt: null,
    lastCheckStatus: null, clearedAt: null, clearedReason: null, dnsRecord: null, usableForSignIn: false,
    createdAt: '2027-01-01T00:00:00.000Z', updatedAt: '2027-01-01T00:00:00.000Z', ...over,
  };
}

function makeApp() {
  const app = new Hono();
  app.use('*', authMiddleware as any);
  registerOrgCustomerDomainRoutes(app as any);
  return app;
}

const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const ALL_ROUTES: Array<[string, string, unknown?]> = [
  ['GET', BASE],
  ['POST', BASE, { domain: 'acme.com' }],
  ['PATCH', `${BASE}/${DOMAIN_ID}`, { isActive: false }],
  ['DELETE', `${BASE}/${DOMAIN_ID}`],
  ['POST', `${BASE}/${DOMAIN_ID}/verification/dns`],
  ['POST', `${BASE}/${DOMAIN_ID}/verification/check`, { method: 'dns_txt' }],
  ['DELETE', `${BASE}/${DOMAIN_ID}/verification`],
];

beforeEach(() => {
  vi.clearAllMocks();
  h.authRef.current = ADMIN;
  h.store.orgs = [{ id: ORG_ID, partnerId: PARTNER_ID }];
  h.ctx.outsideDepth = 0;
  h.svc.listOrgCustomerDomains.mockResolvedValue([view(DOMAIN_ID)]);
  h.svc.startDnsVerification.mockResolvedValue({ recordName: '_breeze-verify.acme.com', recordValue: 'breeze-verify=tok' });
  h.svc.removeCustomerDomainVerification.mockResolvedValue({ removed: true });
  h.svc.verifyCustomerDomain.mockResolvedValue({ result: 'verified', method: 'dns_txt', displacedOrgId: null });
  h.crud.createCustomerEmailDomain.mockResolvedValue(view(DOMAIN_ID));
  h.crud.updateCustomerEmailDomain.mockResolvedValue(view(DOMAIN_ID, { isActive: false }));
  h.crud.deleteCustomerEmailDomain.mockResolvedValue(undefined);
  h.rate.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
});

describe('governance', () => {
  it('every route returns 403 without canManagePartnerWidePolicies and for org-scoped callers', async () => {
    const app = makeApp();
    const callers = [
      { ...ADMIN, partnerOrgAccess: 'selected' },
      { ...ADMIN, partnerOrgAccess: 'none' },
      { ...ADMIN, permissions: { permissions: [{ resource: 'tickets', action: 'write' }] } }, // not an admin role
      { ...ADMIN, scope: 'organization', orgId: ORG_ID, partnerOrgAccess: undefined },
    ];
    for (const caller of callers) {
      h.authRef.current = caller;
      for (const [method, path, body] of ALL_ROUTES) {
        const res = await app.request(path, json(method, body));
        expect(res.status, `${method} ${path} as ${caller.scope}/${caller.partnerOrgAccess}`).toBe(403);
      }
    }
    expect(h.svc.listOrgCustomerDomains).not.toHaveBeenCalled();
    expect(h.svc.verifyCustomerDomain).not.toHaveBeenCalled();
    expect(h.crud.createCustomerEmailDomain).not.toHaveBeenCalled();
  });

  it('an org the caller cannot access, or that does not exist, is a 404 on every route', async () => {
    const app = makeApp();
    h.authRef.current = { ...ADMIN, canAccessOrg: () => false };
    for (const [method, path, body] of ALL_ROUTES) {
      expect((await app.request(path, json(method, body))).status, `${method} ${path}`).toBe(404);
    }
    h.authRef.current = ADMIN;
    h.store.orgs = [];
    for (const [method, path, body] of ALL_ROUTES) {
      expect((await app.request(path, json(method, body))).status, `${method} ${path}`).toBe(404);
    }
    expect(h.svc.verifyCustomerDomain).not.toHaveBeenCalled();
  });
});

describe('CRUD', () => {
  it("GET lists only this org's domains with verification state", async () => {
    const verified = view(DOMAIN_ID, { state: 'verified', method: 'dns_txt', verifiedAt: '2027-01-02T00:00:00.000Z', usableForSignIn: true });
    h.svc.listOrgCustomerDomains.mockResolvedValue([verified]);
    const res = await makeApp().request(BASE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [verified] });
    expect(h.svc.listOrgCustomerDomains).toHaveBeenCalledWith(ORG_ID);
  });

  it('POST takes orgId from the path, never the body', async () => {
    const app = makeApp();
    const res = await app.request(BASE, json('POST', { domain: 'ACME.com' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: view(DOMAIN_ID) });
    expect(h.crud.createCustomerEmailDomain).toHaveBeenCalledWith(
      PARTNER_ID,
      { domain: 'acme.com', autoCreateContact: true, orgId: ORG_ID },
      { userId: USER_ID },
    );
    expect(h.auditSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG_ID, action: 'ticket_customer_email_domain.create', resourceId: DOMAIN_ID,
    }));

    h.crud.createCustomerEmailDomain.mockClear();
    const smuggled = await app.request(BASE, json('POST', { domain: 'acme.com', orgId: '99999999-1111-4222-8333-444455556666' }));
    expect(smuggled.status).toBe(400);
    expect(h.crud.createCustomerEmailDomain).not.toHaveBeenCalled();
  });

  it('POST maps DOMAIN_ALREADY_MAPPED to 409', async () => {
    h.crud.createCustomerEmailDomain.mockRejectedValue(new TicketConfigServiceError('That domain is already mapped', 409, 'DOMAIN_ALREADY_MAPPED'));
    const res = await makeApp().request(BASE, json('POST', { domain: 'acme.com' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'DOMAIN_ALREADY_MAPPED' });
    expect(h.auditSpy).not.toHaveBeenCalled();
  });

  it('PATCH updates this org\'s row and audits against the path org', async () => {
    const res = await makeApp().request(`${BASE}/${DOMAIN_ID}`, json('PATCH', { isActive: false }));
    expect(res.status).toBe(200);
    expect(h.crud.updateCustomerEmailDomain).toHaveBeenCalledWith(PARTNER_ID, DOMAIN_ID, { isActive: false });
    expect(h.auditSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG_ID, action: 'ticket_customer_email_domain.update',
    }));
  });

  it('a PATCH body carrying verifiedAt, verifiedMethod or verificationToken writes none of them', async () => {
    const res = await makeApp().request(`${BASE}/${DOMAIN_ID}`, json('PATCH', {
      isActive: false, verifiedAt: '2027-01-01T00:00:00Z', verifiedMethod: 'dns_txt', verificationToken: 'x',
    }));
    expect(res.status).toBe(200);
    expect(h.crud.updateCustomerEmailDomain).toHaveBeenCalledWith(PARTNER_ID, DOMAIN_ID, { isActive: false });
  });

  it('DELETE returns 204 for this org\'s row', async () => {
    const res = await makeApp().request(`${BASE}/${DOMAIN_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(h.crud.deleteCustomerEmailDomain).toHaveBeenCalledWith(PARTNER_ID, DOMAIN_ID);
    expect(h.auditSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG_ID, action: 'ticket_customer_email_domain.delete', resourceId: DOMAIN_ID,
    }));
  });

  it('a domain id from another org of the same partner is 404 CUSTOMER_DOMAIN_NOT_FOUND', async () => {
    const app = makeApp();
    // listOrgCustomerDomains(ORG_ID) holds only DOMAIN_ID; OTHER_DOMAIN_ID belongs to a sibling org.
    const path = `${BASE}/${OTHER_DOMAIN_ID}`;
    for (const res of [
      await app.request(path, json('PATCH', { isActive: false })),
      await app.request(path, { method: 'DELETE' }),
      await app.request(`${path}/verification/check`, json('POST', { method: 'dns_txt' })),
    ]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'CUSTOMER_DOMAIN_NOT_FOUND' });
    }
    expect(h.crud.updateCustomerEmailDomain).not.toHaveBeenCalled();
    expect(h.crud.deleteCustomerEmailDomain).not.toHaveBeenCalled();
    expect(h.svc.verifyCustomerDomain).not.toHaveBeenCalled();
  });
});

describe('verification', () => {
  it('POST verification/dns returns the record to publish', async () => {
    const res = await makeApp().request(`${BASE}/${DOMAIN_ID}/verification/dns`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { recordName: '_breeze-verify.acme.com', recordValue: 'breeze-verify=tok' } });
    expect(h.svc.startDnsVerification).toHaveBeenCalledWith(ORG_ID, DOMAIN_ID);
  });

  it('verification/dns maps a missing row to 404 CUSTOMER_DOMAIN_NOT_FOUND', async () => {
    h.svc.startDnsVerification.mockRejectedValue(new DomainVerificationError('CUSTOMER_DOMAIN_NOT_FOUND', 404, 'Domain not found'));
    const res = await makeApp().request(`${BASE}/${OTHER_DOMAIN_ID}/verification/dns`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'CUSTOMER_DOMAIN_NOT_FOUND' });
  });

  it('verification/check runs the service outside the request context and returns its outcome', async () => {
    let outside = false;
    h.svc.verifyCustomerDomain.mockImplementation(async () => {
      outside = h.ctx.outsideDepth > 0;
      return { result: 'verified', method: 'dns_txt', displacedOrgId: null };
    });
    const res = await makeApp().request(`${BASE}/${DOMAIN_ID}/verification/check`, json('POST', { method: 'dns_txt' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { result: 'verified', method: 'dns_txt', displacedOrgId: null } });
    expect(outside).toBe(true);
    expect(h.svc.verifyCustomerDomain).toHaveBeenCalledWith({
      orgId: ORG_ID, partnerId: PARTNER_ID, domainId: DOMAIN_ID, method: 'dns_txt', actorUserId: USER_ID,
    });
  });

  it('verification/check returns 200 result failed/unavailable without a 4xx', async () => {
    const app = makeApp();
    h.svc.verifyCustomerDomain.mockResolvedValueOnce({ result: 'failed', reason: 'record_missing' });
    let res = await app.request(`${BASE}/${DOMAIN_ID}/verification/check`, json('POST', { method: 'dns_txt' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { result: 'failed', reason: 'record_missing' } });
    h.svc.verifyCustomerDomain.mockResolvedValueOnce({ result: 'unavailable', reason: 'dns_error' });
    res = await app.request(`${BASE}/${DOMAIN_ID}/verification/check`, json('POST', { method: 'dns_txt' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { result: 'unavailable', reason: 'dns_error' } });
  });

  it('verification/check maps DomainVerificationError to its status and code, never a 500', async () => {
    const app = makeApp();
    for (const [code, status] of [
      ['DOMAIN_VERIFIED_ELSEWHERE', 409], ['DOMAIN_INACTIVE', 409], ['DOMAIN_DNS_NOT_STARTED', 409],
      ['DOMAIN_ALREADY_VERIFIED', 409], ['DOMAIN_VERIFICATION_CONFLICT_RETRY', 409], ['CUSTOMER_DOMAIN_NOT_FOUND', 404],
    ] as const) {
      h.svc.verifyCustomerDomain.mockRejectedValueOnce(new DomainVerificationError(code, status, `msg ${code}`));
      const res = await app.request(`${BASE}/${DOMAIN_ID}/verification/check`, json('POST', { method: 'dns_txt' }));
      expect(res.status, code).toBe(status);
      expect(await res.json()).toEqual({ error: `msg ${code}`, code });
    }
  });

  it('verification/check rejects an unknown method with 400 before any service call', async () => {
    const res = await makeApp().request(`${BASE}/${DOMAIN_ID}/verification/check`, json('POST', { method: 'smoke_signal' }));
    expect(res.status).toBe(400);
    expect(h.svc.verifyCustomerDomain).not.toHaveBeenCalled();
  });

  it('verification/check is rate limited per org and domain', async () => {
    const app = makeApp();
    await app.request(`${BASE}/${DOMAIN_ID}/verification/check`, json('POST', { method: 'dns_txt' }));
    await app.request(`${BASE}/${DOMAIN_ID}/verification/dns`, { method: 'POST' });
    for (const call of h.rate.mock.calls) {
      expect(call[0]).toBe(`portal-domain-verify:${ORG_ID}:${DOMAIN_ID}`);
      expect(call[1]).toEqual({ windowMs: 3_600_000, maxAttempts: 10, blockMs: 3_600_000 });
    }
    expect(h.rate).toHaveBeenCalledTimes(2);

    h.svc.verifyCustomerDomain.mockClear();
    h.svc.startDnsVerification.mockClear();
    h.rate.mockResolvedValue({ allowed: false, retryAfterSeconds: 1234 });
    for (const [path, body] of [
      [`${BASE}/${DOMAIN_ID}/verification/check`, { method: 'dns_txt' }],
      [`${BASE}/${DOMAIN_ID}/verification/dns`, undefined],
    ] as const) {
      const res = await app.request(path, json('POST', body));
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBe('1234');
      expect(await res.json()).toMatchObject({ code: 'RATE_LIMITED' });
    }
    expect(h.svc.verifyCustomerDomain).not.toHaveBeenCalled();
    expect(h.svc.startDnsVerification).not.toHaveBeenCalled();
  });

  it('DELETE verification returns { removed } and leaves auditing to the service', async () => {
    const res = await makeApp().request(`${BASE}/${DOMAIN_ID}/verification`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { removed: true } });
    expect(h.svc.removeCustomerDomainVerification).toHaveBeenCalledWith(ORG_ID, DOMAIN_ID, USER_ID);
    expect(h.auditSpy).not.toHaveBeenCalled();
  });

  it('no response contains verification_token or verified_evidence', async () => {
    const app = makeApp();
    const bodies: string[] = [];
    for (const [method, path, body] of ALL_ROUTES) {
      bodies.push(await (await app.request(path, json(method, body))).text());
    }
    for (const text of bodies) {
      expect(text).not.toMatch(/verification_?token|verified_?evidence/i);
    }
  });
});
