/**
 * The public SCIM router (portal registration W9 #11386, plan Task 6; D8, D9):
 * uniform 401, the failure and per-org budgets, SCIM content type and error
 * bodies, and each endpoint's wiring to the services (mocked here; the real
 * services run on Postgres in portalScim.integration.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const redisState = vi.hoisted(() => ({ zcount: 0, zcountThrows: false, present: true }));
const defaultZcount = vi.hoisted(() => async (_key: string, ..._rest: unknown[]) => {
  if (redisState.zcountThrows) throw new Error('redis down');
  return redisState.zcount;
});
const fakeRedis = vi.hoisted(() => ({ zcount: vi.fn(defaultZcount) }));
const limiter = vi.hoisted(() => ({ orgAllowed: true, calls: [] as string[] }));

vi.mock('../services', () => ({
  getRedis: vi.fn(() => (redisState.present ? fakeRedis : null)),
  rateLimiter: vi.fn(async (_redis: unknown, key: string) => {
    limiter.calls.push(key);
    const allowed = key.startsWith('portal_scim_org:') ? limiter.orgAllowed : true;
    return { allowed, remaining: 0, resetAt: new Date(Date.now() + 30_000) };
  }),
}));
vi.mock('../services/clientIp', () => ({
  getTrustedClientIp: vi.fn(() => '203.0.113.7'),
  rateLimitIpKey: vi.fn((ip: string) => ip),
}));

const verify = vi.hoisted(() => ({ result: null as unknown, unknownId: false }));
vi.mock('../services/portalScim/tokens', async (orig) => {
  const actual = await orig<typeof import('../services/portalScim/tokens')>();
  return { ...actual, authenticatePortalScimToken: vi.fn(async () => (verify.result ? { ok: true, token: verify.result } : { ok: false, unknownId: verify.unknownId })) };
});

const users = vi.hoisted(() => ({
  createScimUser: vi.fn(),
  deleteScimUser: vi.fn(),
  getScimUser: vi.fn(),
  listScimUsers: vi.fn(),
  patchScimUser: vi.fn(),
  replaceScimUser: vi.fn(),
}));
vi.mock('../services/portalScim/users', () => users);

import { ScimError } from '../services/portalScim/protocol';
import { authenticatePortalScimToken as verifyPortalScimToken } from '../services/portalScim/tokens';
import { createPortalScimRoutes } from './portalScim';

const OID = '66666666-7777-4888-9999-000000000000';
const IDENT = '7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b';
const TOKEN = {
  tokenId: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f', orgId: '0b9d6a52-8f43-4c5e-9a1d-2f6c7b8e9d01', partnerId: 'p-1',
  tenantId: '11111111-2222-4333-8444-555555555555', issuer: 'https://login.microsoftonline.com/11111111-2222-4333-8444-555555555555/v2.0',
};
const WIRE = `Bearer brzscim_${'a'.repeat(32)}_${'B'.repeat(43)}`;
/** The row id parseScimBearer reads out of WIRE. */
const TOKEN_ROW_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const RECORD = {
  id: IDENT, externalId: OID, userName: 'jane@acme.example', active: true,
  displayName: 'Jane', givenName: null, familyName: null, created: new Date('2027-02-01T12:00:00.000Z'),
};

const app = createPortalScimRoutes();

function req(method: string, path: string, init: { auth?: string | null; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/scim+json' };
  if (init.auth !== null) headers.Authorization = init.auth ?? WIRE;
  return app.request(path, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeRedis.zcount.mockImplementation(defaultZcount);
  redisState.zcount = 0;
  redisState.zcountThrows = false;
  redisState.present = true;
  limiter.orgAllowed = true;
  limiter.calls.length = 0;
  verify.result = TOKEN;
  verify.unknownId = false;
});

describe('authentication (D9, Review Focus 2)', () => {
  const cases: Array<[string, () => void, string | null]> = [
    ['no Authorization header', () => undefined, null],
    ['a staff JWT', () => undefined, 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig'],
    ['a malformed SCIM token', () => undefined, 'Bearer brzscim_short'],
    ['a well-formed token the service refuses (wrong secret, revoked, proof moved, org inactive)', () => { verify.result = null; }, WIRE],
  ];

  it.each(cases)('%s → the one uniform 401 SCIM body', async (_label, arrange, auth) => {
    arrange();
    const res = await req('GET', '/Users', { auth });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toMatch(/^application\/scim\+json/);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(await res.json()).toEqual({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '401', detail: 'Authentication failed.',
    });
    expect(users.listScimUsers).not.toHaveBeenCalled();
  });

  it('a malformed token never reaches Redis or the token lookup, and spends no budget', async () => {
    await req('GET', '/Users', { auth: 'Bearer nope' });
    expect(verifyPortalScimToken).not.toHaveBeenCalled();
    expect(fakeRedis.zcount).not.toHaveBeenCalled();
    expect(limiter.calls).toEqual([]);
  });

  it('a refused well-formed token is counted against (token id, client address)', async () => {
    verify.result = null;
    await req('GET', '/Users');
    expect(limiter.calls).toEqual([`portal_scim_auth_fail:${TOKEN_ROW_ID}:203.0.113.7`]);
  });

  it('a spent (token id, address) budget gets 429 before any lookup', async () => {
    redisState.zcount = 300;
    const res = await req('GET', '/Users');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('300');
    expect(verifyPortalScimToken).not.toHaveBeenCalled();
    expect(fakeRedis.zcount).toHaveBeenCalledWith(`portal_scim_auth_fail:${TOKEN_ROW_ID}:203.0.113.7`, expect.any(Number), '+inf');
  });

  it('an unknown token id is counted against the address (id guessing), not against a token', async () => {
    verify.result = null;
    verify.unknownId = true;
    await req('GET', '/Users');
    expect(limiter.calls).toEqual(['portal_scim_unknown_id:203.0.113.7']);
  });

  it('an address that spent its unknown-id budget gets 429 before any lookup, whatever id it sends next', async () => {
    fakeRedis.zcount.mockImplementation(async (key: string) => (key.startsWith('portal_scim_unknown_id:') ? 600 : 0));
    const fresh = `Bearer brzscim_${'d'.repeat(32)}_${'B'.repeat(43)}`;
    expect((await req('GET', '/Users', { auth: fresh })).status).toBe(429);
    expect(verifyPortalScimToken).not.toHaveBeenCalled();
  });

  it('failures against one token id never block another token from the same address (shared egress)', async () => {
    // Only the guessed id's bucket is full.
    const byKey = async (key: string) => (key.includes(TOKEN_ROW_ID) ? 300 : 0);
    fakeRedis.zcount.mockImplementation(byKey);
    users.listScimUsers.mockResolvedValue({ total: 0, records: [] });
    const other = `Bearer brzscim_${'c'.repeat(32)}_${'B'.repeat(43)}`;
    expect((await req('GET', '/Users', { auth: other })).status).toBe(200);
    expect((await req('GET', '/Users')).status).toBe(429);
  });

  it('Redis unavailable fails closed (429) for a well-formed token', async () => {
    redisState.zcountThrows = true;
    expect((await req('GET', '/Users')).status).toBe(429);
    redisState.zcountThrows = false;
    redisState.present = false;
    expect((await req('GET', '/Users')).status).toBe(429);
  });

  it('a valid token never spends the failure budget, and is metered per org', async () => {
    users.listScimUsers.mockResolvedValue({ total: 0, records: [] });
    await req('GET', '/Users');
    expect(limiter.calls).toEqual([`portal_scim_org:${TOKEN.orgId}`]);
  });

  it('over the per-org budget: 429 with Retry-After', async () => {
    limiter.orgAllowed = false;
    const res = await req('GET', '/Users');
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(users.listScimUsers).not.toHaveBeenCalled();
  });

  it('a 401 thrown by a service (token revoked mid-request) is the same uniform body', async () => {
    users.getScimUser.mockRejectedValue(new ScimError(401, 'token_no_longer_valid'));
    const res = await req('GET', `/Users/${IDENT}`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ detail: 'Authentication failed.' });
  });
});

describe('endpoints (D8)', () => {
  it('GET /Users: Test Connection\'s GUID filter → 200 empty ListResponse', async () => {
    users.listScimUsers.mockResolvedValue({ total: 0, records: [] });
    const res = await req('GET', `/Users?filter=${encodeURIComponent(`userName eq "${OID}"`)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [],
    });
    expect(users.listScimUsers).toHaveBeenCalledWith(TOKEN, { attribute: 'userName', value: OID }, { startIndex: 1, count: 100 });
  });

  it('GET /Users: an unsupported filter is 400 invalidFilter', async () => {
    const res = await req('GET', `/Users?filter=${encodeURIComponent('title eq "x"')}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ scimType: 'invalidFilter' });
  });

  it('GET /Users/:id renders the resource; a 404 from the service is a SCIM 404', async () => {
    users.getScimUser.mockResolvedValueOnce(RECORD);
    const ok = await req('GET', `/Users/${IDENT}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: IDENT, externalId: OID, active: true });
    users.getScimUser.mockRejectedValueOnce(new ScimError(404, 'Resource not found.'));
    const missing = await req('GET', `/Users/${IDENT}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ status: '404' });
  });

  it('POST /Users → 201 with the created resource; a uniqueness refusal is 409', async () => {
    users.createScimUser.mockResolvedValueOnce({ record: RECORD, adopted: false });
    const body = { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], externalId: OID, userName: 'jane@acme.example', active: true };
    const created = await req('POST', '/Users', { body });
    expect(created.status).toBe(201);
    expect(users.createScimUser).toHaveBeenCalledWith(TOKEN, expect.objectContaining({ externalId: OID, userName: 'jane@acme.example', active: true }));
    users.createScimUser.mockRejectedValueOnce(new ScimError(409, 'taken', 'uniqueness'));
    const conflict = await req('POST', '/Users', { body });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ scimType: 'uniqueness', detail: 'taken' });
  });

  it('POST /Users with a bad externalId is 400 and never reaches the service', async () => {
    const res = await req('POST', '/Users', { body: { externalId: 'jdoe', userName: 'jane@acme.example' } });
    expect(res.status).toBe(400);
    expect(users.createScimUser).not.toHaveBeenCalled();
  });

  it('PATCH /Users/:id parses the operations and returns the resource', async () => {
    users.patchScimUser.mockResolvedValueOnce({ ...RECORD, active: false });
    const res = await req('PATCH', `/Users/${IDENT}`, {
      body: { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'Replace', path: 'active', value: 'False' }] },
    });
    expect(res.status).toBe(200);
    expect(users.patchScimUser).toHaveBeenCalledWith(TOKEN, IDENT, { active: false });
    expect(await res.json()).toMatchObject({ active: false });
  });

  it('PUT /Users/:id replaces; DELETE /Users/:id is 204', async () => {
    users.replaceScimUser.mockResolvedValueOnce(RECORD);
    const put = await req('PUT', `/Users/${IDENT}`, { body: { externalId: OID, userName: 'jane@acme.example' } });
    expect(put.status).toBe(200);
    users.deleteScimUser.mockResolvedValueOnce(undefined);
    const del = await req('DELETE', `/Users/${IDENT}`);
    expect(del.status).toBe(204);
    expect(users.deleteScimUser).toHaveBeenCalledWith(TOKEN, IDENT);
  });

  it('a non-JSON body is 400 invalidSyntax', async () => {
    const res = await app.request('/Users', {
      method: 'POST', headers: { Authorization: WIRE, 'Content-Type': 'application/scim+json' }, body: '{nope',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ scimType: 'invalidSyntax' });
  });

  it('Groups and anything else are a SCIM 404 (Users only)', async () => {
    expect((await req('GET', '/Groups')).status).toBe(404);
    expect((await req('POST', '/Bulk', { body: {} })).status).toBe(404);
  });

  it('discovery documents are served behind the token', async () => {
    const res = await req('GET', '/ServiceProviderConfig');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ patch: { supported: true }, bulk: { supported: false } });
    expect((await req('GET', '/ServiceProviderConfig', { auth: null })).status).toBe(401);
  });

  it('an unexpected service error is a generic 500 that leaks nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    users.listScimUsers.mockRejectedValueOnce(new Error('select * from portal_users where email = jane@acme.example'));
    const res = await req('GET', '/Users');
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('jane');
    errors.mockRestore();
  });
});
