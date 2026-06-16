import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ── Mocks (vi.mock factories are hoisted — literals only) ────────────────────

const {
  verifyMock,
  dbSelectMock,
  dbInsertMock,
  dbUpdateMock,
  redisMock,
  getRedisMock,
  rateLimiterMock,
  writeAuditEventMock,
  getOrgPolicyMock,
} = vi.hoisted(() => {
  const redis = {
    setex: vi.fn(() => Promise.resolve('OK')),
    sadd: vi.fn(() => Promise.resolve(1)),
    expire: vi.fn(() => Promise.resolve(1)),
  };
  return {
    verifyMock: vi.fn(),
    dbSelectMock: vi.fn(),
    dbInsertMock: vi.fn(),
    dbUpdateMock: vi.fn(),
    redisMock: redis,
    getRedisMock: vi.fn(() => redis),
    rateLimiterMock: vi.fn(() =>
      Promise.resolve({ allowed: true, remaining: 19, resetAt: new Date() })
    ),
    writeAuditEventMock: vi.fn(),
    getOrgPolicyMock: vi.fn(),
  };
});

vi.mock('../../config/env', () => ({
  CLIENT_AI_ENTRA_CLIENT_ID: '00000000-aaaa-bbbb-cccc-000000000001',
}));

vi.mock('../../services/clientAiEntraJwt', () => {
  class ClientAiEntraInvalidTokenError extends Error {}
  class ClientAiEntraJwksUnavailableError extends Error {}
  return {
    verifyEntraIdToken: verifyMock,
    ClientAiEntraInvalidTokenError,
    ClientAiEntraJwksUnavailableError,
  };
});

vi.mock('../../db', () => ({
  db: { select: dbSelectMock, insert: dbInsertMock, update: dbUpdateMock },
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../../services/redis', () => ({ getRedis: getRedisMock }));
vi.mock('../../services/rate-limit', () => ({ rateLimiter: rateLimiterMock }));
vi.mock('../../services/clientIp', () => ({ getTrustedClientIp: vi.fn(() => '203.0.113.7') }));
vi.mock('../../services/auditEvents', () => ({ writeAuditEvent: writeAuditEventMock }));
vi.mock('../../services/clientAiPolicy', () => ({
  getOrgPolicy: getOrgPolicyMock,
  isClientUserPermitted: (
    policy: { userAccess: string; selectedUserIds: string[] },
    id: string
  ) => policy.userAccess === 'all' || policy.selectedUserIds.includes(id),
}));

import { clientAiAuthRoutes } from './auth';
import {
  ClientAiEntraInvalidTokenError,
  ClientAiEntraJwksUnavailableError,
} from '../../services/clientAiEntraJwt';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const PORTAL_USER_ID = 'beefbeef-1111-4222-8333-444455556666';
const TID = '6f4f4f4f-1111-4222-8333-444455556666';
const OID = '7a7a7a7a-2222-4333-8444-555566667777';

const CLAIMS = {
  tid: TID,
  oid: OID,
  email: 'finance.user@contoso.com',
  name: 'Finance User',
  aud: '00000000-aaaa-bbbb-cccc-000000000001',
  iss: `https://login.microsoftonline.com/${TID}/v2.0`,
  exp: Math.floor(Date.now() / 1000) + 600,
  iat: Math.floor(Date.now() / 1000),
};

const MAPPING_ROW = { id: 'a1a1a1a1-1111-4222-8333-444455556666', orgId: ORG_ID, entraTenantId: TID, partnerEnabled: true };
const USER_ROW = {
  id: PORTAL_USER_ID,
  orgId: ORG_ID,
  email: 'finance.user@contoso.com',
  name: 'Finance User',
  status: 'active',
};

const ENABLED_POLICY = {
  orgId: ORG_ID,
  enabled: true,
  userAccess: 'all',
  selectedUserIds: [] as string[],
};

function selectChain(rows: unknown[]) {
  const terminus = { limit: vi.fn(() => Promise.resolve(rows)) };
  const withJoin = {
    innerJoin: vi.fn(() => withJoin),
    where: vi.fn(() => terminus),
  };
  return {
    from: vi.fn(() => withJoin),
  };
}

/** call 1 = tenant mapping lookup, call 2 = portal user lookup. */
function setupDb({ mapping, user }: { mapping: object | null; user: object | null }) {
  let call = 0;
  dbSelectMock.mockImplementation(() => {
    call++;
    if (call === 1) return selectChain(mapping ? [mapping] : []);
    return selectChain(user ? [user] : []);
  });
  dbInsertMock.mockImplementation(() => ({
    values: vi.fn(() => ({
      returning: vi.fn(() => Promise.resolve([{ ...USER_ROW }])),
    })),
  }));
  dbUpdateMock.mockImplementation(() => ({
    set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
  }));
}

function buildApp() {
  const app = new Hono();
  app.route('/client-ai', clientAiAuthRoutes);
  return app;
}

function postExchange(app: Hono, accessToken = 'entra-token') {
  return app.request('/client-ai/auth/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getRedisMock.mockReturnValue(redisMock);
  rateLimiterMock.mockResolvedValue({ allowed: true, remaining: 19, resetAt: new Date() });
  verifyMock.mockResolvedValue(CLAIMS);
  getOrgPolicyMock.mockResolvedValue({ ...ENABLED_POLICY });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /client-ai/auth/exchange', () => {
  it('401s on an invalid Entra token', async () => {
    verifyMock.mockRejectedValue(new ClientAiEntraInvalidTokenError('bad'));
    const res = await postExchange(buildApp());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_token' });
  });

  it('503s when Microsoft JWKS is unreachable', async () => {
    verifyMock.mockRejectedValue(new ClientAiEntraJwksUnavailableError('down'));
    const res = await postExchange(buildApp());
    expect(res.status).toBe(503);
  });

  it('429s when the per-IP rate limit is exhausted', async () => {
    rateLimiterMock.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
    const res = await postExchange(buildApp());
    expect(res.status).toBe(429);
  });

  it('404s with tenant_not_provisioned when no mapping exists, and audits the denial', async () => {
    setupDb({ mapping: null, user: null });
    const res = await postExchange(buildApp());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'tenant_not_provisioned' });
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'client_ai.auth.exchange',
        result: 'denied',
        details: expect.objectContaining({ reason: 'tenant_not_provisioned', tid: TID }),
      })
    );
  });

  it('403s with disabled when the org policy is off', async () => {
    setupDb({ mapping: MAPPING_ROW, user: USER_ROW });
    getOrgPolicyMock.mockResolvedValue({ ...ENABLED_POLICY, enabled: false });
    const res = await postExchange(buildApp());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'disabled' });
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: 'denied', orgId: ORG_ID })
    );
  });

  it("403s with disabled when the org's partner has AI for Office disabled", async () => {
    setupDb({ mapping: { ...MAPPING_ROW, partnerEnabled: false }, user: USER_ROW });
    const res = await postExchange(buildApp());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('disabled');
  });

  it('403s with user_not_permitted under userAccess=selected when the user is not listed', async () => {
    setupDb({ mapping: MAPPING_ROW, user: USER_ROW });
    getOrgPolicyMock.mockResolvedValue({
      ...ENABLED_POLICY,
      userAccess: 'selected',
      selectedUserIds: ['ffffffff-1111-4222-8333-444455556666'],
    });
    const res = await postExchange(buildApp());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'user_not_permitted' });
  });

  it('403s when the portal user is not active', async () => {
    setupDb({ mapping: MAPPING_ROW, user: { ...USER_ROW, status: 'disabled' } });
    const res = await postExchange(buildApp());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'account_inactive' });
  });

  it('mints a clientai: Redis session for an existing user and audits success', async () => {
    setupDb({ mapping: MAPPING_ROW, user: USER_ROW });
    const res = await postExchange(buildApp());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(typeof body.accessToken).toBe('string');
    expect(body.accessToken.length).toBeGreaterThanOrEqual(32);
    expect(body.expiresInSeconds).toBe(86400);
    expect(body.user).toEqual({
      id: PORTAL_USER_ID,
      email: 'finance.user@contoso.com',
      name: 'Finance User',
    });
    // org + branding flow to the client so the add-in can render the
    // white-label footer (spec §11). Default policy has empty branding.
    expect(body.org).toEqual({ id: ORG_ID });
    expect(body.branding).toEqual({ displayName: null, logoUrl: null });

    expect(redisMock.setex).toHaveBeenCalledWith(
      `clientai:session:${body.accessToken}`,
      86400,
      expect.stringContaining(PORTAL_USER_ID)
    );
    expect(dbInsertMock).not.toHaveBeenCalled();
    expect(dbUpdateMock).toHaveBeenCalled(); // lastLoginAt refresh
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'client_ai.auth.exchange',
        result: 'success',
        orgId: ORG_ID,
        actorId: PORTAL_USER_ID,
      })
    );
  });

  it('surfaces org white-label branding from the policy in the success response', async () => {
    setupDb({ mapping: MAPPING_ROW, user: USER_ROW });
    getOrgPolicyMock.mockResolvedValue({
      ...ENABLED_POLICY,
      branding: { displayName: 'Lantern IT', logoUrl: 'https://cdn.example.com/logo.png' },
    });
    const res = await postExchange(buildApp());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.org).toEqual({ id: ORG_ID });
    expect(body.branding).toEqual({
      displayName: 'Lantern IT',
      logoUrl: 'https://cdn.example.com/logo.png',
    });
  });

  it('coerces non-string branding fields to null (defensive against bad JSONB)', async () => {
    setupDb({ mapping: MAPPING_ROW, user: USER_ROW });
    getOrgPolicyMock.mockResolvedValue({
      ...ENABLED_POLICY,
      branding: { displayName: 42, logoUrl: { nested: true } },
    });
    const res = await postExchange(buildApp());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.branding).toEqual({ displayName: null, logoUrl: null });
  });

  it('auto-provisions a portal user (authMethod=entra) on first exchange', async () => {
    setupDb({ mapping: MAPPING_ROW, user: null });
    const res = await postExchange(buildApp());
    expect(res.status).toBe(200);

    expect(dbInsertMock).toHaveBeenCalled();
    const valuesFn = dbInsertMock.mock.results[0]!.value.values;
    expect(valuesFn).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        email: 'finance.user@contoso.com',
        entraOid: OID,
        entraTenantId: TID,
        authMethod: 'entra',
        passwordHash: null,
      })
    );
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        result: 'success',
        details: expect.objectContaining({ provisioned: true }),
      })
    );
  });

  it('503s when Redis is unavailable', async () => {
    getRedisMock.mockReturnValue(null as never);
    const res = await postExchange(buildApp());
    expect(res.status).toBe(503);
  });

  it('400s on a missing accessToken body field', async () => {
    const app = buildApp();
    const res = await app.request('/client-ai/auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
