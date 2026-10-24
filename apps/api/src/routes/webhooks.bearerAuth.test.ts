import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// #9652: "Bearer token" authentication is stored as an encrypted
// `Authorization: Bearer <token>` custom header (the existing encrypted-headers
// storage). These tests pin the API half: a webhook can be created with a
// bearer header and no HMAC secret, reads report `authType` without ever
// returning the token, an edit can switch between the two, and the fields the
// old form sent (`auth`, `bearerToken`) are rejected instead of stripped.

vi.mock('../services/unassignedPool/protectedOrg', () => ({ isHoldingOrg: vi.fn(async () => false) }));

const { validateWebhookUrlSafetyWithDnsMock } = vi.hoisted(() => ({
  validateWebhookUrlSafetyWithDnsMock: vi.fn(),
}));

vi.mock('../workers/webhookDelivery', () => ({
  getWebhookWorker: vi.fn(() => ({ queueDelivery: vi.fn() })),
}));

vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

vi.mock('../services/notificationSenders/webhookSender', () => ({
  validateWebhookUrlSafetyWithDns: validateWebhookUrlSafetyWithDnsMock,
  redactUrlForLogs: (rawUrl: string) => {
    try {
      const parsed = new URL(rawUrl);
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString().replace(/\/$/, '');
    } catch {
      return '[invalid-url]';
    }
  },
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

vi.mock('../db/schema', () => ({
  webhooks: {
    id: 'id',
    orgId: 'orgId',
    url: 'url',
    headers: 'headers',
    status: 'status',
    createdAt: 'createdAt',
    approvalGeneration: 'approvalGeneration',
  },
  webhookDeliveries: { id: 'id', webhookId: 'webhookId', status: 'status', deliveredAt: 'deliveredAt', createdAt: 'createdAt' },
}));

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const WEBHOOK_ID = '22222222-2222-2222-2222-222222222222';

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'organization',
      partnerId: null,
      orgId: '11111111-1111-1111-1111-111111111111',
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111',
      user: { id: 'user-123', email: 'test@example.com' },
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

import { db } from '../db';
import { encryptSecret } from '../services/secretCrypto';
import { encryptWebhookHeaders } from '../services/notificationChannelSecrets';
import { toWorkerWebhookConfig, webhookRoutes } from './webhooks';

const TOKEN = 'tok-9652-very-secret';

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: WEBHOOK_ID,
    orgId: ORG_ID,
    name: 'Bearer hook',
    url: 'https://hooks.example.com/in',
    secret: null,
    events: ['device.online'],
    headers: [],
    status: 'active',
    retryPolicy: null,
    createdBy: 'user-123',
    createdAt: new Date('2026-10-22T00:00:00.000Z'),
    updatedAt: new Date('2026-10-22T00:00:00.000Z'),
    lastDeliveryAt: null,
    approvalGeneration: 1,
    ...overrides,
  };
}

function bearerRow(overrides: Record<string, unknown> = {}) {
  return storedRow({
    headers: encryptWebhookHeaders([{ key: 'Authorization', value: `Bearer ${TOKEN}` }]),
    ...overrides,
  });
}

function mockInsertEcho() {
  vi.mocked(db.insert).mockReturnValueOnce({
    values: vi.fn((values: any) => ({
      returning: vi.fn(() => Promise.resolve([storedRow({ ...values, id: WEBHOOK_ID })])),
    })),
  } as any);
}

function insertedValues(): any {
  return vi.mocked(db.insert).mock.results[0]?.value.values.mock.calls[0][0];
}

function mockSelectOne(row: unknown) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([row])) })) })),
  } as any);
}

function mockUpdateEcho(stored: Record<string, unknown>) {
  const set = vi.fn((payload: Record<string, unknown>) => ({
    where: vi.fn(() => ({
      returning: vi.fn(() => Promise.resolve([{ ...stored, ...payload, approvalGeneration: 2 }])),
    })),
  }));
  vi.mocked(db.update).mockReturnValueOnce({ set } as any);
  return set;
}

function mockList(rows: unknown[]) {
  vi.mocked(db.select)
    .mockReturnValueOnce({
      from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([{ count: rows.length }])) })),
    } as any)
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({ limit: vi.fn(() => ({ offset: vi.fn(() => Promise.resolve(rows)) })) })),
        })),
      })),
    } as any);
}

describe('webhook bearer-token authentication (#9652)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    // Drop queued once-values so a test that fails early cannot leak its
    // insert/select mock into the next one.
    vi.mocked(db.insert).mockReset();
    vi.mocked(db.select).mockReset();
    vi.mocked(db.update).mockReset();
    validateWebhookUrlSafetyWithDnsMock.mockResolvedValue([]);
    app = new Hono();
    app.route('/webhooks', webhookRoutes);
  });

  const post = (body: unknown) => app.request('/webhooks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const patch = (body: unknown) => app.request(`/webhooks/${WEBHOOK_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  describe('create', () => {
    it('creates a webhook authenticated only by an Authorization: Bearer header', async () => {
      mockInsertEcho();
      const res = await post({
        name: 'Bearer hook',
        url: 'https://hooks.example.com/in',
        events: ['device.online'],
        headers: [{ key: 'Authorization', value: `Bearer ${TOKEN}` }],
      });

      expect(res.status).toBe(201);
      const values = insertedValues();
      expect(values.secret).toBeNull();
      expect(values.headers).toHaveLength(1);
      expect(values.headers[0].key).toBe('Authorization');
      // Encrypted at rest, never the plaintext token.
      expect(String(values.headers[0].value)).toMatch(/^enc:v\d+:/);
      expect(JSON.stringify(values)).not.toContain(TOKEN);

      const body = await res.json();
      expect(body.authType).toBe('bearer');
      expect(body.hasSecret).toBe(false);
      expect(JSON.stringify(body)).not.toContain(TOKEN);
      expect(body.headers).toEqual([
        { key: 'Authorization', value: { redacted: true, hasSecret: true, masked: '********' } },
      ]);
    });

    it('still creates an HMAC webhook and reports authType hmac', async () => {
      mockInsertEcho();
      const res = await post({
        name: 'HMAC hook',
        url: 'https://hooks.example.com/in',
        secret: 'signing-secret',
        events: ['device.online'],
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.authType).toBe('hmac');
      expect(body.hasSecret).toBe(true);
    });

    it('rejects a webhook with neither a signing secret nor an Authorization header', async () => {
      const res = await post({
        name: 'No auth',
        url: 'https://hooks.example.com/in',
        events: ['device.online'],
        headers: [{ key: 'X-Trace', value: 'abc' }],
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/signing secret or an `Authorization: Bearer/);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it.each([
      ['a non-bearer scheme', 'Basic dXNlcjpwYXNz'],
      ['a bare token with no scheme', TOKEN],
      ['a scheme with no token', 'Bearer '],
      ['the masked marker with nothing stored', '********'],
    ])('rejects an Authorization header with %s when there is no signing secret', async (_case, value) => {
      const res = await post({
        name: 'Weak auth',
        url: 'https://hooks.example.com/in',
        events: ['device.online'],
        headers: [{ key: 'Authorization', value }],
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/signing secret or an `Authorization: Bearer/);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it.each([
      ['a lowercase key', 'authorization', `Bearer ${TOKEN}`],
      ['a lowercase scheme', 'Authorization', `bearer ${TOKEN}`],
    ])('accepts a bearer header with %s', async (_case, key, value) => {
      mockInsertEcho();
      const res = await post({
        name: 'Bearer hook',
        url: 'https://hooks.example.com/in',
        events: ['device.online'],
        headers: [{ key, value }],
      });
      expect(res.status).toBe(201);
      expect((await res.json()).authType).toBe('bearer');
    });

    it.each([
      ['bearerToken', { bearerToken: TOKEN }],
      ['auth', { auth: { type: 'bearer', token: TOKEN } }],
    ])('rejects the unsupported `%s` field instead of silently stripping it', async (_field, extra) => {
      const res = await post({
        name: 'Old form',
        url: 'https://hooks.example.com/in',
        secret: 'signing-secret',
        events: ['device.online'],
        ...extra,
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Authorization: Bearer/);
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe('read', () => {
    it('reports authType bearer for a stored bearer header without returning the token', async () => {
      mockList([bearerRow(), storedRow({ id: '33333333-3333-3333-3333-333333333333', secret: encryptSecret('s') })]);
      const res = await app.request('/webhooks');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(JSON.stringify(body)).not.toContain(TOKEN);
      expect(body.data[0].authType).toBe('bearer');
      expect(body.data[0].headers[0].value).toEqual({ redacted: true, hasSecret: true, masked: '********' });
      expect(body.data[1].authType).toBe('hmac');
    });

    it('does not treat a non-bearer Authorization scheme as bearer auth', async () => {
      mockList([storedRow({
        secret: encryptSecret('s'),
        headers: encryptWebhookHeaders([{ key: 'Authorization', value: 'Basic dXNlcjpwYXNz' }]),
      })]);
      const res = await app.request('/webhooks');
      const body = await res.json();
      expect(body.data[0].authType).toBe('hmac');
    });

    it('reports bearer when a webhook holds both a bearer header and a signing secret', async () => {
      mockList([bearerRow({ secret: encryptSecret('s') })]);
      const body = await (await app.request('/webhooks')).json();
      expect(body.data[0].authType).toBe('bearer');
      expect(body.data[0].hasSecret).toBe(true);
    });

    it('reads a bearer token from legacy record-shaped headers', async () => {
      mockList([storedRow({ headers: { Authorization: encryptSecret(`Bearer ${TOKEN}`) } })]);
      const body = await (await app.request('/webhooks')).json();
      expect(body.data[0].authType).toBe('bearer');
      expect(JSON.stringify(body)).not.toContain(TOKEN);
    });

    it('still lists a webhook whose headers cannot be decrypted, without claiming bearer', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        mockList([
          storedRow({ secret: encryptSecret('s'), headers: [{ key: 'Authorization', value: 'enc:v1:not-a-real-ciphertext' }] }),
          bearerRow({ id: '33333333-3333-3333-3333-333333333333' }),
        ]);
        const res = await app.request('/webhooks');
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data).toHaveLength(2);
        expect(body.data[0].authType).toBe('hmac');
        expect(body.data[1].authType).toBe('bearer');
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(WEBHOOK_ID), expect.anything());
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('hands the delivery worker the decrypted Authorization header and no signing secret', () => {
      const config = toWorkerWebhookConfig(bearerRow() as any);
      expect(config.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
      expect(config.secret).toBeUndefined();
    });
  });

  describe('update', () => {
    it('switches an HMAC webhook to bearer: clears the secret and stores the encrypted header', async () => {
      const stored = storedRow({ secret: encryptSecret('old-signing-secret') });
      mockSelectOne(stored);
      const set = mockUpdateEcho(stored);

      const res = await patch({
        secret: null,
        headers: [{ key: 'Authorization', value: `Bearer ${TOKEN}` }],
      });

      expect(res.status).toBe(200);
      const payload = (set.mock.calls as any[])[0][0];
      expect(payload.secret).toBeNull();
      expect(String(payload.headers[0].value)).toMatch(/^enc:v\d+:/);
      expect(JSON.stringify(payload)).not.toContain(TOKEN);
      const body = await res.json();
      expect(body.authType).toBe('bearer');
      expect(body.hasSecret).toBe(false);
    });

    it('keeps the stored bearer token when the masked header is re-submitted', async () => {
      const stored = bearerRow();
      mockSelectOne(stored);
      const set = mockUpdateEcho(stored);

      const res = await patch({
        name: 'Renamed',
        headers: [{ key: 'Authorization', value: '********' }],
      });

      expect(res.status).toBe(200);
      const payload = (set.mock.calls as any[])[0][0];
      expect(payload.headers[0].value).toBe((stored.headers as any)[0].value);
      expect('secret' in payload).toBe(false);
      expect((await res.json()).authType).toBe('bearer');
    });

    it('keeps a masked bearer token stored in legacy record-shaped headers', async () => {
      const storedValue = encryptSecret(`Bearer ${TOKEN}`) as string;
      const stored = storedRow({ secret: encryptSecret('s'), headers: { Authorization: storedValue } });
      mockSelectOne(stored);
      const set = mockUpdateEcho(stored);

      const res = await patch({ secret: null, headers: [{ key: 'Authorization', value: '********' }] });

      expect(res.status).toBe(200);
      const payload = (set.mock.calls as any[])[0][0];
      expect(payload.secret).toBeNull();
      expect(payload.headers).toEqual([{ key: 'Authorization', value: storedValue }]);
      expect((await res.json()).authType).toBe('bearer');
    });

    it('switches to bearer by clearing the secret when the bearer header is already stored', async () => {
      const stored = bearerRow({ secret: encryptSecret('s') });
      mockSelectOne(stored);
      const set = mockUpdateEcho(stored);
      const res = await patch({ secret: null });
      expect(res.status).toBe(200);
      expect((set.mock.calls as any[])[0][0].secret).toBeNull();
    });

    it('rejects clearing the secret when the only Authorization header is not a bearer token', async () => {
      mockSelectOne(storedRow({
        secret: encryptSecret('s'),
        headers: encryptWebhookHeaders([{ key: 'Authorization', value: 'Basic dXNlcjpwYXNz' }]),
      }));
      const res = await patch({ secret: null });
      expect(res.status).toBe(400);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('switches a bearer webhook back to HMAC by dropping the header and setting a secret', async () => {
      const stored = bearerRow();
      mockSelectOne(stored);
      const set = mockUpdateEcho(stored);

      const res = await patch({ secret: 'new-signing-secret', headers: [] });

      expect(res.status).toBe(200);
      const payload = (set.mock.calls as any[])[0][0];
      expect(payload.headers).toEqual([]);
      expect(String(payload.secret)).toMatch(/^enc:v\d+:/);
      const body = await res.json();
      expect(body.authType).toBe('hmac');
      expect(body.hasSecret).toBe(true);
    });

    it('rejects clearing the secret when no Authorization header would remain', async () => {
      mockSelectOne(storedRow({ secret: encryptSecret('old-signing-secret') }));
      const res = await patch({ secret: null });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/signing secret or an `Authorization: Bearer/);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('rejects clearing the secret when the same edit removes the Authorization header', async () => {
      const stored = bearerRow({ secret: encryptSecret('old-signing-secret') });
      mockSelectOne(stored);
      const res = await patch({ secret: null, headers: [{ key: 'X-Trace', value: 'abc' }] });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/signing secret or an `Authorization: Bearer/);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('still allows an unrelated edit of a legacy webhook that has no authentication', async () => {
      const stored = storedRow();
      mockSelectOne(stored);
      mockUpdateEcho(stored);
      const res = await patch({ name: 'Renamed', headers: [{ key: 'X-Trace', value: 'abc' }] });
      expect(res.status).toBe(200);
      expect((await res.json()).authType).toBe('none');
    });

    it('rejects the unsupported `bearerToken` field on update', async () => {
      const res = await patch({ bearerToken: TOKEN });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Authorization: Bearer/);
      expect(db.update).not.toHaveBeenCalled();
    });
  });
});
