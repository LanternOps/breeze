import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Portal registration W6, plan Task 6 (D3, D4, D8–D10, D12; Review Focus 1
// and 4). The routes are mounted exactly as routes/portal/index.ts mounts
// them (authRoutes first, so its /auth/* audit wrapper covers the submit).
// The DB, the W5 read API and the host resolver are wired to throw/record so
// the submit's "no DB read, no domain lookup" rule is checked, not assumed.

const h = vi.hoisted(() => ({
  dbCalls: [] as string[],
  domainCalls: [] as string[],
  hostCalls: [] as string[],
  enqueue: vi.fn(),
  consume: vi.fn(),
  complete: vi.fn(),
  audit: vi.fn(),
  redisRef: { current: {} as unknown },
}));

vi.mock('../../db', () => {
  const record = (name: string) => () => { h.dbCalls.push(name); throw new Error(`unexpected db.${name}`); };
  return {
    db: { select: record('select'), insert: record('insert'), update: record('update'), delete: record('delete'), execute: record('execute') },
    withDbAccessContext: (_ctx: unknown, fn: () => unknown) => { h.dbCalls.push('withDbAccessContext'); return fn(); },
    withSystemDbAccessContext: (fn: () => unknown) => { h.dbCalls.push('withSystemDbAccessContext'); return fn(); },
    withDbTransaction: (fn: () => unknown) => { h.dbCalls.push('withDbTransaction'); return fn(); },
    runOutsideDbContext: <T,>(fn: () => T) => fn(),
  };
});
vi.mock('../../services/portalDomainVerification', () => {
  const record = (name: string) => vi.fn(async () => { h.domainCalls.push(name); return null; });
  return {
    findOrgByVerifiedDomain: record('findOrgByVerifiedDomain'),
    isDomainVerifiedForOrg: record('isDomainVerifiedForOrg'),
    listVerifiedDomainsForOrg: record('listVerifiedDomainsForOrg'),
  };
});
vi.mock('./branding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./branding')>()),
  resolvePortalHostOrgId: vi.fn(async (host: string) => { h.hostCalls.push(host); return null; }),
}));
vi.mock('../../services/portalSelfRegistration/queue', () => ({ enqueuePortalSelfRegistration: h.enqueue }));
vi.mock('../../services/portalSelfRegistration/complete', () => ({ completePortalSelfRegistration: h.complete }));
vi.mock('./capabilityTokens', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./capabilityTokens')>()),
  consumePortalSelfRegistrationToken: h.consume,
}));
vi.mock('../../services/auditEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/auditEvents')>()),
  writeAuditEventAsync: h.audit,
}));
vi.mock('./helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./helpers')>()),
  // The test sets the client IP directly (no proxy trust in a unit test).
  getClientIp: (c: { req: { header: (n: string) => string | undefined } }) => c.req.header('x-test-ip') ?? '198.51.100.1',
}));
vi.mock('../../services/redis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/redis')>()),
  getRedis: () => h.redisRef.current,
}));

import { Hono } from 'hono';
import { authRoutes } from './auth';
import {
  SELF_REGISTER_ACCEPTED_MESSAGE,
  SELF_REGISTER_ACCOUNT_PENDING_SETUP,
  SELF_REGISTER_INVALID_LINK,
  SELF_REGISTER_REQUEST_AGAIN,
  selfRegistrationRoutes,
} from './selfRegistration';
import { portalRateLimitBuckets } from './helpers';
import { __testOnly as policyTestOnly } from '../../services/portalAccessPolicy';

const ORG = '7c0a1f7e-1111-4222-8333-444455556666';
const PAYLOAD = {
  v: 2 as const, purpose: 'self_register' as const, orgId: ORG, email: 'pat@contoso.example.com', name: 'Pat Doe',
  domain: 'contoso.example.com', policyFingerprint: 'f'.repeat(64),
};

function app() {
  // Mounted at the same relative paths as routes/portal/index.ts (the audit
  // wrapper strips an `/api/v1/portal` prefix, absent here).
  return new Hono().route('/', authRoutes).route('/', selfRegistrationRoutes);
}

let ipCounter = 0;
const freshIp = () => `203.0.113.${(ipCounter += 1) % 250}`;

function submit(body: unknown, opts: { ip?: string; host?: string } = {}) {
  return app().request('/auth/self-register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-ip': opts.ip ?? freshIp(), ...(opts.host ? { Host: opts.host } : {}) },
    body: JSON.stringify(body),
  });
}

function verify(token: unknown, ip?: string) {
  return app().request('/auth/self-register/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-ip': ip ?? freshIp() },
    body: JSON.stringify({ token }),
  });
}

/** Status, body and every header except the per-response Date. */
async function snapshot(res: Response) {
  const headers = [...res.headers.entries()].filter(([k]) => k !== 'date').sort();
  return { status: res.status, body: await res.text(), headers };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.dbCalls.length = 0;
  h.domainCalls.length = 0;
  h.hostCalls.length = 0;
  h.redisRef.current = {};
  ipCounter = 0;
  h.enqueue.mockResolvedValue(true);
  h.audit.mockResolvedValue(undefined);
  portalRateLimitBuckets.clear();
  policyTestOnly.setCapabilities({ entra: false, google: false, selfRegistration: true });
});
afterEach(() => policyTestOnly.setCapabilities(null));

describe('POST /auth/self-register (D3, Review Focus 1)', () => {
  // Eligible, ineligible (mode off), existing, unknown and declared-only:
  // the handler cannot tell them apart, because it never looks.
  const CLASSES = [
    'pat@contoso.example.com',
    'pat@off-org.example.com',
    'existing@contoso.example.com',
    'nobody@unknown.example.com',
    'pat@declared-only.example.com',
  ];

  it('submit responses are identical for eligible, ineligible, existing, unknown and declared-only addresses', async () => {
    const snaps = [];
    for (const email of CLASSES) snaps.push(await snapshot(await submit({ email, name: 'Pat Doe' })));
    for (const s of snaps) expect(s).toEqual(snaps[0]);
    expect(snaps[0]!.status).toBe(200);
    expect(JSON.parse(snaps[0]!.body)).toEqual({ success: true, message: SELF_REGISTER_ACCEPTED_MESSAGE });
    expect(SELF_REGISTER_ACCEPTED_MESSAGE).toBe("If this address can request access, we've emailed you.");
  });

  it('the submit handler performs no DB read and no domain lookup', async () => {
    for (const email of CLASSES) await submit({ email, name: 'Pat Doe' }, { host: 'portal.contoso.example.com' });
    expect(h.dbCalls).toEqual([]);
    expect(h.domainCalls).toEqual([]);
    // The host is resolved by the worker, not here.
    expect(h.hostCalls).toEqual([]);
    expect(h.enqueue).toHaveBeenCalledTimes(CLASSES.length);
  });

  it('throttling is identical for eligible and ineligible addresses: IP, email and domain limits, same 429 body', async () => {
    // Per IP: 5 / 15 min, then the 6th is refused — for every class.
    const ipSnaps = [];
    for (const [i, email] of ['pat@contoso.example.com', 'nobody@unknown.example.com'].entries()) {
      const ip = `192.0.2.${10 + i}`;
      for (let n = 0; n < 5; n += 1) expect((await submit({ email: `u${n}-${email}`, name: 'P' }, { ip })).status).toBe(200);
      const res = await submit({ email, name: 'P' }, { ip });
      ipSnaps.push({ ...(await snapshot(res)), retryAfter: res.headers.get('retry-after') });
    }
    expect(ipSnaps[0]!.status).toBe(429);
    expect(ipSnaps[1]).toEqual(ipSnaps[0]);
    expect(JSON.parse(ipSnaps[0]!.body)).toEqual({ error: 'Too many requests. Please try again later.' });
    expect(Number(ipSnaps[0]!.retryAfter)).toBeGreaterThan(0);
    // A throttled submit enqueues nothing: 5 accepted per IP, twice.
    expect(h.enqueue).toHaveBeenCalledTimes(10);

    // Per email: 3 / day, from different IPs.
    const emailSnaps = [];
    for (const email of ['pat@contoso.example.com', 'nobody@unknown.example.com']) {
      for (let n = 0; n < 3; n += 1) expect((await submit({ email, name: 'P' })).status).toBe(200);
      emailSnaps.push(await snapshot(await submit({ email, name: 'P' })));
    }
    expect(h.enqueue).toHaveBeenCalledTimes(16);
    expect(emailSnaps[0]!.status).toBe(429);
    expect(emailSnaps[1]).toEqual(emailSnaps[0]);

    // Per domain: 50 / day, from different IPs and addresses.
    const domainSnaps = [];
    for (const domain of ['contoso2.example.com', 'unknown2.example.com']) {
      for (let n = 0; n < 50; n += 1) expect((await submit({ email: `p${n}@${domain}`, name: 'P' })).status).toBe(200);
      domainSnaps.push(await snapshot(await submit({ email: `late@${domain}`, name: 'P' })));
    }
    expect(domainSnaps[0]!.status).toBe(429);
    expect(domainSnaps[1]).toEqual(domainSnaps[0]);
  });

  it('the email bucket is keyed by a hash, never the address', async () => {
    await submit({ email: 'pat@contoso.example.com', name: 'P' });
    const keys = [...portalRateLimitBuckets.keys()].join('\n');
    expect(keys).toContain('portal:selfreg:email:');
    expect(keys).not.toContain('pat@contoso.example.com');
    expect(keys).toContain('portal:selfreg:domain:contoso.example.com');
  });

  it('submit enqueues email, name and the normalized host; an enqueue failure still returns the uniform 200', async () => {
    const ok = await snapshot(await submit({ email: 'Pat@Contoso.Example.com', name: '  Pat Doe ' }, { host: 'Portal.Contoso.Example.com:8443' }));
    expect(h.enqueue).toHaveBeenCalledWith({ email: 'pat@contoso.example.com', name: 'Pat Doe', host: 'portal.contoso.example.com' });

    h.enqueue.mockResolvedValue(false);
    const failed = await snapshot(await submit({ email: 'pat2@contoso.example.com', name: 'Pat Doe' }));
    expect(failed).toEqual(ok);

    await submit({ email: 'pat3@contoso.example.com', name: 'Pat Doe' });
    expect(h.enqueue).toHaveBeenLastCalledWith({ email: 'pat3@contoso.example.com', name: 'Pat Doe', host: null });
  });

  it('submit refuses orgId in the body (400) and returns 404 when the capability is off', async () => {
    const res = await submit({ email: 'pat@contoso.example.com', name: 'Pat', orgId: ORG });
    expect(res.status).toBe(400);
    expect(h.enqueue).not.toHaveBeenCalled();

    policyTestOnly.setCapabilities({ entra: false, google: false, selfRegistration: false });
    const off = await submit({ email: 'pat@contoso.example.com', name: 'Pat' });
    expect(off.status).toBe(404);
    expect(h.enqueue).not.toHaveBeenCalled();
    // The real capability (W06b): the kill switch off is a 404 whatever the
    // email configuration, for submit and verify alike.
    policyTestOnly.setCapabilities(null);
    vi.stubEnv('PORTAL_SELF_REGISTRATION_ENABLED', 'false');
    try {
      expect((await submit({ email: 'pat@contoso.example.com', name: 'Pat' })).status).toBe(404);
      expect((await verify('any-token')).status).toBe(404);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('on the in-memory backend a missing Redis client changes nothing (the Redis-backend 503 is address-independent by construction)', async () => {
    // PORTAL_USE_REDIS is false under NODE_ENV=test, so this pins the in-memory
    // path: a null client does not matter there.
    h.redisRef.current = null;
    expect((await submit({ email: 'pat@contoso.example.com', name: 'Pat' })).status).toBe(200);
  });

  it('submit writes one anonymous portal.auth.self_register.request audit row', async () => {
    await submit({ email: 'pat@contoso.example.com', name: 'Pat Doe' });
    const rows = h.audit.mock.calls.map((c) => c[1]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: undefined, actorType: 'system', actorId: '00000000-0000-0000-0000-000000000000', actorEmail: undefined,
      action: 'portal.auth.self_register.request', resourceType: 'portal_auth', result: 'success', details: { httpStatus: 200 },
    });
  });
});

describe('POST /auth/self-register/verify (D8–D10, Review Focus 4)', () => {
  it('verify: unknown, expired and reused tokens get the same 400', async () => {
    h.consume.mockResolvedValue(null);
    const snaps = [];
    for (const token of ['unknown', 'expired', 'reused']) snaps.push(await snapshot(await verify(token)));
    for (const s of snaps) expect(s).toEqual(snaps[0]);
    expect(snaps[0]!.status).toBe(400);
    expect(JSON.parse(snaps[0]!.body)).toEqual({ error: SELF_REGISTER_INVALID_LINK });
    expect(SELF_REGISTER_INVALID_LINK).toBe('This link is invalid or has expired. Request access again.');
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.audit.mock.calls[0]![1]).toMatchObject({ orgId: null, action: 'portal.auth.self_register.verify', result: 'denied' });
  });

  it('verify: a refused completion returns the same 400 body as an unknown token', async () => {
    h.consume.mockResolvedValue(null);
    const unknown = await snapshot(await verify('unknown'));
    for (const reason of ['org_inactive', 'domain_not_verified', 'policy_changed', 'mode_off'] as const) {
      h.consume.mockResolvedValue(PAYLOAD);
      h.complete.mockResolvedValue({ outcome: 'refused', reason });
      expect(await snapshot(await verify('t'))).toEqual(unknown);
    }
    const refusedAudit = h.audit.mock.calls.map((c) => c[1]).find((r) => r.details?.outcome === 'refused');
    expect(refusedAudit).toMatchObject({ orgId: ORG, action: 'portal.auth.self_register.verify', result: 'denied' });
  });

  it('verify maps request_sent, request_unavailable, existing_account and account_created to their responses', async () => {
    h.consume.mockResolvedValue(PAYLOAD);
    const cases: Array<[unknown, number, unknown]> = [
      [{ outcome: 'request_sent', orgId: ORG, requestId: 'req-1', created: true }, 200, { outcome: 'request_sent' }],
      [{ outcome: 'request_unavailable', orgId: ORG }, 200, { outcome: 'request_unavailable' }],
      [{ outcome: 'existing_account', orgId: ORG }, 200, { outcome: 'existing_account' }],
      [{ outcome: 'account_created', orgId: ORG, portalUserId: 'u-1', inviteToken: 'inv+/=' }, 200, { outcome: 'account_created', next: '/accept-invite?token=inv%2B%2F%3D' }],
    ];
    for (const [outcome, status, body] of cases) {
      h.complete.mockResolvedValue(outcome);
      const res = await verify('t');
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual(body);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(h.consume).toHaveBeenCalledWith('t');
    expect(h.complete).toHaveBeenCalledWith(PAYLOAD);
  });

  it('verify: account_created returns next=/accept-invite?token=… and audits portal.auth.self_register.verify', async () => {
    h.consume.mockResolvedValue(PAYLOAD);
    h.complete.mockResolvedValue({ outcome: 'account_created', orgId: ORG, portalUserId: 'u-1', inviteToken: 'inv' });
    expect(await (await verify('t')).json()).toEqual({ outcome: 'account_created', next: '/accept-invite?token=inv' });
    expect(h.audit.mock.calls.at(-1)![1]).toMatchObject({
      orgId: ORG, action: 'portal.auth.self_register.verify', resourceType: 'portal_user', resourceId: 'u-1', result: 'success',
      details: { outcome: 'account_created', mode: 'instant' },
    });
  });

  it('verify: an account with no minted invite token answers 503 (D10 residual)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.consume.mockResolvedValue(PAYLOAD);
    h.complete.mockResolvedValue({ outcome: 'account_created', orgId: ORG, portalUserId: 'u-1', inviteToken: null });
    const res = await verify('t');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: SELF_REGISTER_ACCOUNT_PENDING_SETUP });
  });

  it('verify: a completion failure after the token is burned answers 503 "request again" and never surfaces the raw error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.consume.mockResolvedValue(PAYLOAD);
    h.complete.mockRejectedValue(Object.assign(new Error(`Failed query: insert ... params: ${PAYLOAD.email},${PAYLOAD.name}`), { name: 'DrizzleQueryError' }));
    const res = await verify('t');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: SELF_REGISTER_REQUEST_AGAIN });
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain('DrizzleQueryError');
    expect(logged).not.toContain(PAYLOAD.email);
    expect(logged).not.toContain(PAYLOAD.name);
    expect(h.audit.mock.calls.at(-1)![1]).toMatchObject({ orgId: ORG, action: 'portal.auth.self_register.verify', result: 'failure', details: { outcome: 'error' } });
  });

  it('verify: request_sent audits against the access request', async () => {
    h.consume.mockResolvedValue(PAYLOAD);
    h.complete.mockResolvedValue({ outcome: 'request_sent', orgId: ORG, requestId: 'req-9', created: false });
    await verify('t');
    expect(h.audit.mock.calls.at(-1)![1]).toMatchObject({ orgId: ORG, resourceType: 'portal_access_request', resourceId: 'req-9', result: 'success' });
  });

  it('verify is rate limited per IP (10 / 15 min) and 404 while the capability is off', async () => {
    h.consume.mockResolvedValue(null);
    for (let n = 0; n < 10; n += 1) expect((await verify('x', '192.0.2.77')).status).toBe(400);
    expect((await verify('x', '192.0.2.77')).status).toBe(429);

    policyTestOnly.setCapabilities({ entra: false, google: false, selfRegistration: false });
    expect((await verify('x')).status).toBe(404);
  });

  it('verify refuses a malformed body before consuming anything', async () => {
    expect((await verify('')).status).toBe(400);
    expect((await verify('x'.repeat(513))).status).toBe(400);
    expect(h.consume).not.toHaveBeenCalled();
  });

  it('the verify route writes no row through the /auth/* wrapper (it audits itself)', async () => {
    h.consume.mockResolvedValue(null);
    await verify('x');
    expect(h.audit).toHaveBeenCalledTimes(1);
  });
});
