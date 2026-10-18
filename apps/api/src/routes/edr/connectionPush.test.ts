import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const s = vi.hoisted(() => ({
  auth: {
    scope: 'partner' as 'organization' | 'partner' | 'system',
    orgId: null as string | null,
    partnerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as string | null,
    partnerOrgAccess: 'all' as 'all' | 'selected' | 'none' | null,
  },
  gates: { permission: false, mfa: false },
  depth: 0,
  connection: null as null | Record<string, unknown>,
  tenants: [] as Array<{ vendorTenantId: string }>,
  updates: [] as Array<{ set: Record<string, unknown>; depth: number }>,
  vendorDepths: [] as number[],
  order: [] as string[],
  selectWheres: [] as unknown[],
  /** Per-update `.returning()` rows, consumed in order (default: one row). */
  updateReturning: [] as Array<Array<{ id: string }>>,
}));

const ID = '33333333-3333-4333-8333-333333333333';
const PARTNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

vi.mock('../../db', async () => {
  const schema = await vi.importActual<typeof import('../../db/schema')>('../../db/schema');
  const select = vi.fn(() => {
    let table: unknown = null;
    const c: Record<string, unknown> = {};
    c.from = vi.fn((t: unknown) => { table = t; return c; });
    c.where = vi.fn((cond: unknown) => { s.selectWheres.push(cond); return c; });
    c.limit = vi.fn(() => c);
    (c as { then: unknown }).then = (res: (v: unknown) => unknown) => {
      const rows = table === schema.edrTenants ? s.tenants : s.connection ? [s.connection] : [];
      return Promise.resolve(rows).then(res);
    };
    return c;
  });
  const update = vi.fn(() => ({
    set: vi.fn((v: Record<string, unknown>) => {
      s.updates.push({ set: v, depth: s.depth });
      s.order.push('db:update');
      const done = Promise.resolve([{ id: ID }]);
      const rows = s.updateReturning.length > 0 ? s.updateReturning.shift()! : [{ id: ID }];
      return { where: vi.fn(() => Object.assign(done, { returning: vi.fn(async () => rows) })) };
    }),
  }));
  return {
    db: { select, update },
    runOutsideDbContext: vi.fn(async (fn: () => unknown) => {
      const saved = s.depth; s.depth = 0;
      try { return await fn(); } finally { s.depth = saved; }
    }),
  };
});

vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => (s.gates.permission ? c.json({ error: 'Forbidden' }, 403) : next())),
  requireMfa: vi.fn(() => async (c: any, next: any) => (s.gates.mfa ? c.json({ error: 'MFA required' }, 403) : next())),
  withAuthDbAccessContext: vi.fn(async (_auth: unknown, fn: () => Promise<unknown>) => {
    s.depth += 1;
    try { return await fn(); } finally { s.depth -= 1; }
  }),
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));

const v = vi.hoisted(() => ({
  registerPush: vi.fn(async () => {}),
  unregisterPush: vi.fn(async (..._a: unknown[]): Promise<{ changed: boolean }> => ({ changed: true })),
  sendTestPush: vi.fn(async () => {}),
}));
const track = (name: keyof typeof v) => async (...a: unknown[]) => {
  s.vendorDepths.push(s.depth);
  s.order.push(`vendor:${name}`);
  return (v[name] as (...x: unknown[]) => unknown)(...a);
};
vi.mock('../../services/edrProviders/registry', () => ({
  getEdrProvider: vi.fn((key: string) => {
    if (key === 'nopush') return { key, label: 'No Push', capabilities: {} };
    if (key !== 'bitdefender') throw new Error('unknown');
    return {
      key, label: 'Bitdefender GravityZone', capabilities: {},
      verifyWebhook: () => ({ ok: false, error: 'x' }),
      registerPush: track('registerPush'), unregisterPush: track('unregisterPush'), sendTestPush: track('sendTestPush'),
    };
  }),
}));
const enc = vi.hoisted(() => ({ encrypt: vi.fn((_s: string, id: string, p: unknown) => `sealed:${id}:${String(p)}`) }));
vi.mock('../../services/edrProviders/credentials', () => ({
  encryptEdrSecret: enc.encrypt,
  decryptEdrSecret: vi.fn(() => ({ apiKey: 'k'.repeat(24) })),
}));
vi.mock('../../services/edrProviders/context', () => ({
  buildEdrAdapterContext: vi.fn(() => ({ ctx: true })),
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { requireMfa, requirePermission } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { EdrProviderRequestError } from '../../services/edrProviders/types';
import { edrConnectionPushRoutes, publicApiBase } from './connectionPush';

// Captured at import, before beforeEach clears mock history.
const GATE_PERMISSION_CALLS = vi.mocked(requirePermission).mock.calls.map((c) => [...c]);
const GATE_MFA_CALLS = vi.mocked(requireMfa).mock.calls.length;

const row = (over: Record<string, unknown> = {}) => ({
  id: ID, partnerId: PARTNER_ID, provider: 'bitdefender', name: 'GZ', baseUrl: 'https://cloud.gravityzone.bitdefender.com/api',
  region: null, vendorRootId: 'root', credentialsEncrypted: 'enc', isActive: true, status: 'connected',
  pushEnabled: false, pushRegisteredAt: null, webhookSecretEncrypted: null, ...over,
});

let app: Hono;
const ENV = { PUBLIC_API_URL: process.env.PUBLIC_API_URL, BREEZE_SERVER: process.env.BREEZE_SERVER };

beforeEach(() => {
  vi.clearAllMocks();
  s.auth = { scope: 'partner', orgId: null, partnerId: PARTNER_ID, partnerOrgAccess: 'all' };
  s.gates = { permission: false, mfa: false };
  s.depth = 0; s.updates = []; s.vendorDepths = []; s.order = []; s.selectWheres = []; s.updateReturning = [];
  s.connection = row();
  s.tenants = [{ vendorTenantId: 'c1' }, { vendorTenantId: 'c2' }];
  process.env.PUBLIC_API_URL = 'https://breeze.example.test';
  delete process.env.BREEZE_SERVER;
  v.registerPush.mockResolvedValue(undefined);
  v.unregisterPush.mockResolvedValue({ changed: true });
  v.sendTestPush.mockResolvedValue(undefined);
  app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth' as never, { ...s.auth, user: { id: '99999999-9999-4999-8999-999999999999', email: 't@example.com' } } as never);
    return next();
  });
  app.route('/edr', edrConnectionPushRoutes);
});
afterEach(() => {
  for (const [k, val] of Object.entries(ENV)) {
    if (val === undefined) delete process.env[k]; else process.env[k] = val;
  }
});

const call = (method: string, path = `/edr/connections/${ID}/push`) => app.request(path, { method });
const audits = () => vi.mocked(writeRouteAudit).mock.calls.map((c) => (c[1] as { action: string }).action);

describe('publicApiBase', () => {
  it('PUBLIC_API_URL wins over BREEZE_SERVER; origin only; https required', () => {
    process.env.PUBLIC_API_URL = 'https://api.example.test/some/path/';
    process.env.BREEZE_SERVER = 'https://other.example.test';
    expect(publicApiBase()).toEqual({ ok: true, base: 'https://api.example.test' });
    delete process.env.PUBLIC_API_URL;
    expect(publicApiBase()).toEqual({ ok: true, base: 'https://other.example.test' });
    process.env.BREEZE_SERVER = 'http://plain.example.test';
    expect(publicApiBase()).toMatchObject({ ok: false, code: 'public_url_not_https' });
    delete process.env.BREEZE_SERVER;
    expect(publicApiBase()).toMatchObject({ ok: false, code: 'public_url_unset' });
    process.env.PUBLIC_API_URL = '   ';
    expect(publicApiBase()).toMatchObject({ ok: false, code: 'public_url_unset' });
    process.env.PUBLIC_API_URL = 'not a url';
    expect(publicApiBase()).toMatchObject({ ok: false, code: 'public_url_not_https' });
  });
});

describe('gates (all three routes)', () => {
  const routes: Array<[string, string]> = [
    ['POST', `/edr/connections/${ID}/push`],
    ['DELETE', `/edr/connections/${ID}/push`],
    ['POST', `/edr/connections/${ID}/push/test`],
  ];
  it.each(routes)('%s %s: selected-org partner user -> 403, no vendor call, no write', async (m, p) => {
    s.auth.partnerOrgAccess = 'selected';
    s.connection = row({ pushEnabled: true, webhookSecretEncrypted: 'x' });
    expect((await call(m, p)).status).toBe(403);
    expect(s.order).toEqual([]);
  });
  it.each(routes)('%s %s: organization token -> 403', async (m, p) => {
    s.auth = { scope: 'organization', orgId: 'o', partnerId: null, partnerOrgAccess: null };
    expect((await call(m, p)).status).toBe(403);
    expect(s.order).toEqual([]);
  });
  it.each(routes)('%s %s: MFA not satisfied -> 403', async (m, p) => {
    s.gates.mfa = true;
    expect((await call(m, p)).status).toBe(403);
    expect(s.order).toEqual([]);
  });
  it.each(routes)('%s %s: missing ORGS_WRITE -> 403', async (m, p) => {
    s.gates.permission = true;
    expect((await call(m, p)).status).toBe(403);
  });
  it.each(routes)('%s %s: unknown connection -> 404', async (m, p) => {
    s.connection = null;
    expect((await call(m, p)).status).toBe(404);
    expect(s.order).toEqual([]);
  });
  it.each(routes)('%s %s: bad id -> 400', async (m, p) => {
    expect((await call(m, p.replace(ID, 'nope'))).status).toBe(400);
  });

  it('review: each route attaches ORGS_WRITE (organizations.write) and MFA', () => {
    expect(GATE_PERMISSION_CALLS).toEqual([['organizations', 'write'], ['organizations', 'write'], ['organizations', 'write']]);
    expect(GATE_MFA_CALLS).toBe(3);
  });

  it.each(routes)('review: %s %s loads the connection scoped to the CALLER\'s partner id', async (m, p) => {
    s.connection = row({ pushEnabled: true, webhookSecretEncrypted: 'x' });
    await call(m, p);
    const first = new PgDialect().sqlToQuery(s.selectWheres[0] as SQL);
    expect(first.sql).toMatch(/"partner_id" = \$\d/);
    expect(first.params).toEqual(expect.arrayContaining([ID, PARTNER_ID]));
  });
});

describe('POST /edr/connections/:id/push', () => {
  it('stores a fresh sealed secret with push OFF, registers OUTSIDE any DB context, then turns push ON', async () => {
    const res = await call('POST');
    expect(res.status).toBe(200);
    expect(s.order).toEqual(['db:update', 'vendor:registerPush', 'db:update']);
    // 1. secret stored (sealed, row-bound spec), push disabled
    const secretPlain = enc.encrypt.mock.calls[0]![2] as string;
    expect(enc.encrypt).toHaveBeenCalledWith('connection_webhook_secret', ID, secretPlain);
    expect(secretPlain).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
    expect(s.updates[0]!.set).toMatchObject({ webhookSecretEncrypted: `sealed:${ID}:${secretPlain}`, pushEnabled: false, pushRegisteredAt: null });
    // 2. vendor registration: env base URL, the SAME plaintext secret, mapped tenants
    expect(v.registerPush).toHaveBeenCalledWith({ ctx: true }, {
      url: `https://breeze.example.test/api/v1/webhooks/edr/${ID}`, secret: secretPlain, vendorTenantIds: ['c1', 'c2'],
      replaceExisting: false,
    });
    expect(s.vendorDepths).toEqual([0]);
    // 3. enabled only after the vendor accepted
    expect(s.updates[1]!.set).toMatchObject({ pushEnabled: true, pushRegisteredAt: expect.any(Date) });
    expect(audits()).toContain('edr.connection.push_enabled');
  });

  it('the secret is never returned by the route', async () => {
    const res = await call('POST');
    const secretPlain = enc.encrypt.mock.calls[0]![2] as string;
    const text = await res.text();
    expect(text).not.toContain(secretPlain);
    expect(text).not.toContain('sealed:');
    expect(JSON.stringify(vi.mocked(writeRouteAudit).mock.calls)).not.toContain(secretPlain);
  });

  it('two opt-ins mint two different secrets (rotation = DELETE + POST)', async () => {
    await call('POST');
    await call('POST');
    expect(enc.encrypt.mock.calls[0]![2]).not.toBe(enc.encrypt.mock.calls[1]![2]);
  });

  it('a vendor refusal leaves push disabled, maps the error, and audits a failure', async () => {
    v.registerPush.mockRejectedValue(new EdrProviderRequestError('GravityZone push.setPushEventSettings failed: bad params', {
      code: 'invalid_params', reauth: false, scope: 'connection',
    }));
    const res = await call('POST');
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'vendor_error' });
    expect(s.updates.some((u) => u.set.pushEnabled === true)).toBe(false);
    expect(audits()).toContain('edr.connection.push_enabled');
    const audit = vi.mocked(writeRouteAudit).mock.calls.at(-1)![1] as { result?: string };
    expect(audit.result).toBe('failure');
  });

  it('409 when no public https API URL is configured — before any write or vendor call', async () => {
    delete process.env.PUBLIC_API_URL;
    let res = await call('POST');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'public_url_unset' });
    process.env.PUBLIC_API_URL = 'http://breeze.example.test';
    res = await call('POST');
    expect(await res.json()).toMatchObject({ code: 'public_url_not_https' });
    expect(s.order).toEqual([]);
  });

  it('review: push already pointing elsewhere -> 409 push_conflict, push stays off; replaceExisting:true goes through', async () => {
    v.registerPush.mockRejectedValueOnce(new EdrProviderRequestError('GravityZone push events already go to another destination', {
      code: 'push_conflict', reauth: false, scope: 'connection',
    }));
    let res = await call('POST');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'push_conflict' });
    expect(s.updates.some((u) => u.set.pushEnabled === true)).toBe(false);
    expect((v.registerPush.mock.calls[0] as unknown[])[1]).toMatchObject({ replaceExisting: false });

    res = await app.request(`/edr/connections/${ID}/push`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ replaceExisting: true }),
    });
    expect(res.status).toBe(200);
    expect((v.registerPush.mock.calls[1] as unknown[])[1]).toMatchObject({ replaceExisting: true });
  });

  it('review: the enabling CAS matching no row (secret rotated / push turned off meanwhile) -> 409, failure audit, not success', async () => {
    s.updateReturning = [[{ id: ID }], []];
    const res = await call('POST');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'push_state_changed' });
    const audit = vi.mocked(writeRouteAudit).mock.calls.at(-1)![1] as { action: string; result?: string };
    expect(audit).toMatchObject({ action: 'edr.connection.push_enabled', result: 'failure' });
  });

  it('review: a non-vendor failure (e.g. stored credentials do not decrypt) is a logged 500, not a fake vendor rejection', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    v.registerPush.mockRejectedValueOnce(new TypeError('boom'));
    const res = await call('POST');
    expect(res.status).toBe(500);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('409 for an inactive connection; 400 for an adapter without push', async () => {
    s.connection = row({ isActive: false });
    let res = await call('POST');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'connection_inactive' });
    s.connection = row({ provider: 'nopush' });
    res = await call('POST');
    expect(res.status).toBe(400);
    expect(s.order).toEqual([]);
  });
});

describe('DELETE /edr/connections/:id/push', () => {
  it('clears the secret and disables push BEFORE the vendor call; vendor call outside any DB context', async () => {
    s.connection = row({ pushEnabled: true, webhookSecretEncrypted: 'x' });
    const res = await call('DELETE');
    expect(res.status).toBe(200);
    expect(s.order).toEqual(['db:update', 'vendor:unregisterPush']);
    expect(s.updates[0]!.set).toMatchObject({ pushEnabled: false, pushRegisteredAt: null, webhookSecretEncrypted: null });
    expect(s.vendorDepths).toEqual([0]);
    expect(await res.json()).toMatchObject({ warnings: [] });
    expect(audits()).toContain('edr.connection.push_disabled');
  });

  it('review: passes our webhook URL so the vendor push is only turned off while it still points at Breeze', async () => {
    s.connection = row({ pushEnabled: true, webhookSecretEncrypted: 'x' });
    v.unregisterPush.mockResolvedValueOnce({ changed: false } as never);
    const res = await call('DELETE');
    expect(v.unregisterPush).toHaveBeenCalledWith({ ctx: true }, { url: `https://breeze.example.test/api/v1/webhooks/edr/${ID}` });
    const body = await res.json() as { warnings: string[] };
    expect(body.warnings).toHaveLength(1);
    expect(s.updates[0]!.set).toMatchObject({ webhookSecretEncrypted: null, pushEnabled: false });
  });

  it('still clears the secret when the vendor call fails, and reports a warning', async () => {
    s.connection = row({ pushEnabled: true, webhookSecretEncrypted: 'x' });
    v.unregisterPush.mockRejectedValue(new Error('timeout'));
    const res = await call('DELETE');
    expect(res.status).toBe(200);
    expect(s.updates[0]!.set).toMatchObject({ webhookSecretEncrypted: null, pushEnabled: false });
    const body = await res.json() as { warnings: string[] };
    expect(body.warnings).toHaveLength(1);
  });
});

describe('POST /edr/connections/:id/push/test', () => {
  it('asks the vendor for a test event outside any DB context -> 202', async () => {
    s.connection = row({ pushEnabled: true, webhookSecretEncrypted: 'x' });
    const res = await call('POST', `/edr/connections/${ID}/push/test`);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    expect(v.sendTestPush).toHaveBeenCalledTimes(1);
    expect(s.vendorDepths).toEqual([0]);
    expect(audits()).toContain('edr.connection.push_test');
  });

  it('409 when push is not enabled; 502 on a vendor failure', async () => {
    let res = await call('POST', `/edr/connections/${ID}/push/test`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'push_not_enabled' });
    expect(v.sendTestPush).not.toHaveBeenCalled();
    s.connection = row({ pushEnabled: true, webhookSecretEncrypted: 'x' });
    v.sendTestPush.mockRejectedValue(new EdrProviderRequestError('GravityZone push.sendTestPushEvent failed', {
      code: 'vendor_error', reauth: false, scope: 'operation',
    }));
    res = await call('POST', `/edr/connections/${ID}/push/test`);
    expect(res.status).toBe(502);
    // A non-vendor failure is a logged 500.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    v.sendTestPush.mockRejectedValue(new Error('down'));
    res = await call('POST', `/edr/connections/${ID}/push/test`);
    expect(res.status).toBe(500);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
