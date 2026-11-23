import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const PARTNER_ID = '11111111-1111-1111-1111-111111111111';
const CONN_ID = '44444444-4444-4444-4444-444444444444';
const KEY_ID = '77777777-7777-4777-8777-777777777777';
const USER_ID = '55555555-5555-5555-5555-555555555555';
// A distinctive key and last four: neither may appear in any response, audit row or log line.
const SECRET_KEY = 'sm-SECRET-key-material-Q7Z9';
const LAST4 = 'Q7Z9';

const { state } = vi.hoisted(() => ({
  state: {
    mfa: true,
    inContext: false,
    outside: false,
    listHostsCalledInContext: [] as boolean[],
    listHostsCalledOutside: [] as boolean[],
  },
}));

vi.mock('../../middleware/auth', () => ({
  withAuthDbAccessContext: vi.fn(async (_auth: unknown, fn: () => Promise<unknown>) => {
    state.inContext = true;
    try { return await fn(); } finally { state.inContext = false; }
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (c: any, next: any) => (state.mfa ? next() : c.json({ error: 'MFA required' }, 403))),
}));

vi.mock('../../services/permissions', () => ({ PERMISSIONS: { BILLING_MANAGE: { resource: 'billing', action: 'manage' } } }));

vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => {
    const was = state.outside;
    state.outside = true;
    try { return await fn(); } finally { state.outside = was; }
  }),
}));

vi.mock('../../services/unifi/unifiConnectionService', () => ({ getConnection: vi.fn() }));

vi.mock('../../services/unifi/unifiKeyService', async (importActual) => {
  const actual = await importActual<typeof import('../../services/unifi/unifiKeyService')>();
  return {
    UnifiKeyError: actual.UnifiKeyError,
    listKeys: vi.fn(async () => []),
    addKey: vi.fn(),
    updateKey: vi.fn(),
    deleteKey: vi.fn(),
    getKeyForTest: vi.fn(),
  };
});

const listHosts = vi.fn();
const listSites = vi.fn();
vi.mock('../../services/unifi/unifiClient', async (importActual) => {
  const actual = await importActual<typeof import('../../services/unifi/unifiClient')>();
  return { ...actual, createUnifiClient: vi.fn(() => ({ listHosts, listSites })) };
});

vi.mock('../../jobs/unifiWorker', () => ({ enqueueUnifiSync: vi.fn(async () => undefined) }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

import { unifiKeyRoutes } from './keys';
import { getConnection } from '../../services/unifi/unifiConnectionService';
import * as keySvc from '../../services/unifi/unifiKeyService';
import { createUnifiClient, UnifiApiError } from '../../services/unifi/unifiClient';
import { enqueueUnifiSync } from '../../jobs/unifiWorker';
import { writeRouteAudit } from '../../services/auditEvents';

function summary(over: Partial<keySvc.UnifiKeySummary> = {}): keySvc.UnifiKeySummary {
  return {
    id: KEY_ID, label: 'Macera', keyLast4: LAST4, isEnabled: true, status: 'pending', lastSyncAt: null, lastSyncStatus: null,
    lastSyncError: null, lastOkAt: null, hostsSeen: null, sitesSeen: null, createdAt: new Date('2026-11-22T00:00:00Z'), ...over,
  };
}

function cloudConn() {
  return {
    id: CONN_ID, partnerId: PARTNER_ID, connectionType: 'cloud' as const, baseUrl: 'https://api.ui.com', accountLabel: null,
    isActive: true, status: 'connected' as const, lastSyncAt: null, lastSyncStatus: null, lastSyncError: null,
  };
}

function app() {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'partner', partnerId: PARTNER_ID, partnerOrgAccess: 'all', orgId: null,
      canAccessOrg: () => true, user: { id: USER_ID, email: 'admin@example.com' },
    } as any);
    return next();
  });
  a.route('/unifi/keys', unifiKeyRoutes);
  return a;
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const patch = (body: unknown) => ({ ...json(body), method: 'PATCH' });

let logged: string[];
let spies: Array<ReturnType<typeof vi.spyOn>>;

beforeEach(() => {
  vi.clearAllMocks();
  state.mfa = true;
  state.inContext = false;
  state.outside = false;
  state.listHostsCalledInContext = [];
  state.listHostsCalledOutside = [];
  vi.mocked(getConnection).mockResolvedValue(cloudConn());
  listHosts.mockReset().mockImplementation(async () => {
    state.listHostsCalledInContext.push(state.inContext);
    state.listHostsCalledOutside.push(state.outside);
    return [{ id: 'host-a' }, { id: 'host-b' }];
  });
  listSites.mockReset().mockResolvedValue([{ siteId: 's1', hostId: 'host-a' }, { siteId: 's2', hostId: 'host-b' }, { siteId: 's3', hostId: 'host-b' }]);
  vi.mocked(keySvc.addKey).mockReset().mockResolvedValue(summary());
  vi.mocked(keySvc.updateKey).mockReset().mockResolvedValue(summary());
  vi.mocked(keySvc.deleteKey).mockReset().mockResolvedValue(true);
  vi.mocked(keySvc.listKeys).mockReset().mockResolvedValue([summary({ label: 'Old label' })]);
  vi.mocked(keySvc.getKeyForTest).mockReset().mockResolvedValue({
    baseUrl: 'https://api.ui.com',
    key: { id: KEY_ID, label: 'Macera', apiKey: SECRET_KEY, keyLast4: LAST4, lastSeenHostIds: null },
  });
  logged = [];
  spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : JSON.stringify(a) ?? String(a))).join(' ')); }),
  );
});

afterEach(() => {
  for (const s of spies) s.mockRestore();
});

function expectNoSecret(text: string) {
  expect(text).not.toContain(SECRET_KEY);
  expect(text).not.toContain('apiKeyEncrypted');
}

describe('GET /unifi/keys', () => {
  it('lists the connection keys', async () => {
    const res = await app().request('/unifi/keys');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keys).toHaveLength(1);
    expect(keySvc.listKeys).toHaveBeenCalledWith({}, CONN_ID, PARTNER_ID);
  });

  it('returns an empty list when not connected', async () => {
    vi.mocked(getConnection).mockResolvedValue(null);
    const res = await app().request('/unifi/keys');
    expect(await res.json()).toEqual({ keys: [] });
  });
});

describe('POST /unifi/keys', () => {
  it('validates outside the request DB context, stores the key, queues a sync and returns 201', async () => {
    const res = await app().request('/unifi/keys', json({ label: ' Macera ', apiKey: SECRET_KEY }));
    expect(res.status).toBe(201);
    expect(state.listHostsCalledInContext).toEqual([false]);
    expect(state.listHostsCalledOutside).toEqual([true]);
    expect(createUnifiClient).toHaveBeenCalledWith({ baseUrl: 'https://api.ui.com', apiKey: SECRET_KEY });
    expect(keySvc.addKey).toHaveBeenCalledWith({}, {
      integrationId: CONN_ID, partnerId: PARTNER_ID, label: 'Macera', apiKey: SECRET_KEY, seenHostIds: ['host-a', 'host-b'], createdBy: USER_ID,
    });
    expect(enqueueUnifiSync).toHaveBeenCalledWith(CONN_ID, PARTNER_ID, 'manual');
    const body = await res.json();
    expect(body.key.id).toBe(KEY_ID);
  });

  it('returns 400 on a 401 from UniFi and stores nothing', async () => {
    listHosts.mockRejectedValue(new UnifiApiError(`UniFi API error 401: bad key ${SECRET_KEY}`, 401));
    const res = await app().request('/unifi/keys', json({ label: 'Macera', apiKey: SECRET_KEY }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, message: 'Could not validate the UniFi API key.' });
    expect(keySvc.addKey).not.toHaveBeenCalled();
    expect(enqueueUnifiSync).not.toHaveBeenCalled();
  });

  it('returns 400 on a 403 from UniFi', async () => {
    listHosts.mockRejectedValue(new UnifiApiError('forbidden', 403));
    const res = await app().request('/unifi/keys', json({ label: 'Macera', apiKey: SECRET_KEY }));
    expect(res.status).toBe(400);
  });

  it('returns 502 when UniFi cannot be reached, without logging the key', async () => {
    listHosts.mockRejectedValue(new Error(`connect ECONNREFUSED while sending ${SECRET_KEY}`));
    const res = await app().request('/unifi/keys', json({ label: 'Macera', apiKey: SECRET_KEY }));
    expect(res.status).toBe(502);
    expect(keySvc.addKey).not.toHaveBeenCalled();
    expectNoSecret(await res.text());
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) expectNoSecret(line);
  });

  it('returns 409 UNIFI_KEY_LABEL_TAKEN', async () => {
    vi.mocked(keySvc.addKey).mockRejectedValue(new keySvc.UnifiKeyError('UNIFI_KEY_LABEL_TAKEN'));
    const res = await app().request('/unifi/keys', json({ label: 'Macera', apiKey: SECRET_KEY }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ success: false, code: 'UNIFI_KEY_LABEL_TAKEN' });
    expect(enqueueUnifiSync).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('returns 409 UNIFI_KEY_LIMIT', async () => {
    vi.mocked(keySvc.addKey).mockRejectedValue(new keySvc.UnifiKeyError('UNIFI_KEY_LIMIT'));
    const res = await app().request('/unifi/keys', json({ label: 'Macera', apiKey: SECRET_KEY }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('UNIFI_KEY_LIMIT');
  });

  it('refuses a self-hosted connection before calling UniFi', async () => {
    vi.mocked(getConnection).mockResolvedValue({ ...cloudConn(), connectionType: 'self_hosted' });
    const res = await app().request('/unifi/keys', json({ label: 'Macera', apiKey: SECRET_KEY }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('UNIFI_NOT_CLOUD');
    expect(listHosts).not.toHaveBeenCalled();
  });

  it('returns 400 when not connected', async () => {
    vi.mocked(getConnection).mockResolvedValue(null);
    const res = await app().request('/unifi/keys', json({ label: 'Macera', apiKey: SECRET_KEY }));
    expect(res.status).toBe(400);
    expect(listHosts).not.toHaveBeenCalled();
  });

  it.each([
    [{ label: '', apiKey: SECRET_KEY }],
    [{ label: '   ', apiKey: SECRET_KEY }],
    [{ label: 'x'.repeat(101), apiKey: SECRET_KEY }],
    [{ label: 'ok', apiKey: '' }],
    [{ label: 'ok', apiKey: 'k'.repeat(501) }],
  ])('rejects an invalid body %#', async (body) => {
    const res = await app().request('/unifi/keys', json(body));
    expect(res.status).toBe(400);
    expect(listHosts).not.toHaveBeenCalled();
  });

  it('still answers 201 when queueing the first sync fails (the scheduler picks the key up)', async () => {
    vi.mocked(enqueueUnifiSync).mockRejectedValueOnce(new Error('redis down'));
    const res = await app().request('/unifi/keys', json({ label: 'Macera', apiKey: SECRET_KEY }));
    expect(res.status).toBe(201);
  });
});

describe('PATCH /unifi/keys/:keyId', () => {
  it('rejects an empty body', async () => {
    const res = await app().request(`/unifi/keys/${KEY_ID}`, patch({}));
    expect(res.status).toBe(400);
    expect(keySvc.updateKey).not.toHaveBeenCalled();
  });

  it('rejects a key id that is not a uuid', async () => {
    const res = await app().request('/unifi/keys/not-a-uuid', patch({ label: 'x' }));
    expect(res.status).toBe(400);
    expect(keySvc.updateKey).not.toHaveBeenCalled();
  });

  it('renames without calling UniFi or queueing a sync', async () => {
    vi.mocked(keySvc.updateKey).mockResolvedValue(summary({ label: 'Fabric North' }));
    const res = await app().request(`/unifi/keys/${KEY_ID}`, patch({ label: ' Fabric North ' }));
    expect(res.status).toBe(200);
    expect(listHosts).not.toHaveBeenCalled();
    expect(keySvc.updateKey).toHaveBeenCalledWith({}, { integrationId: CONN_ID, partnerId: PARTNER_ID, keyId: KEY_ID, label: 'Fabric North' });
    expect(enqueueUnifiSync).not.toHaveBeenCalled();
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'unifi.key.update',
      details: { integrationId: CONN_ID, keyId: KEY_ID, label: 'Fabric North', previousLabel: 'Old label', changed: ['label'] },
    }));
  });

  it('replacing a key validates it first, passes the host snapshot and queues a sync', async () => {
    const res = await app().request(`/unifi/keys/${KEY_ID}`, patch({ apiKey: SECRET_KEY }));
    expect(res.status).toBe(200);
    expect(state.listHostsCalledInContext).toEqual([false]);
    expect(keySvc.updateKey).toHaveBeenCalledWith({}, {
      integrationId: CONN_ID, partnerId: PARTNER_ID, keyId: KEY_ID, apiKey: SECRET_KEY, seenHostIds: ['host-a', 'host-b'],
    });
    expect(enqueueUnifiSync).toHaveBeenCalledWith(CONN_ID, PARTNER_ID, 'manual');
    expect(vi.mocked(writeRouteAudit).mock.calls[0]![1].details).toMatchObject({ changed: ['secret'] });
  });

  it('a replacement UniFi rejects is a 400 and changes nothing', async () => {
    listHosts.mockRejectedValue(new UnifiApiError('unauthorized', 401));
    const res = await app().request(`/unifi/keys/${KEY_ID}`, patch({ apiKey: SECRET_KEY, label: 'New' }));
    expect(res.status).toBe(400);
    expect(keySvc.updateKey).not.toHaveBeenCalled();
  });

  it('enabling a key queues a sync; disabling does not', async () => {
    vi.mocked(keySvc.listKeys).mockResolvedValue([summary({ isEnabled: false })]);
    await app().request(`/unifi/keys/${KEY_ID}`, patch({ isEnabled: true }));
    expect(enqueueUnifiSync).toHaveBeenCalledTimes(1);
    vi.mocked(keySvc.listKeys).mockResolvedValue([summary({ isEnabled: true })]);
    await app().request(`/unifi/keys/${KEY_ID}`, patch({ isEnabled: false }));
    expect(enqueueUnifiSync).toHaveBeenCalledTimes(1);
  });

  it('maps UNIFI_LAST_ENABLED_KEY to 409 and UNIFI_KEY_NOT_FOUND to 404', async () => {
    vi.mocked(keySvc.updateKey).mockRejectedValueOnce(new keySvc.UnifiKeyError('UNIFI_LAST_ENABLED_KEY'));
    const last = await app().request(`/unifi/keys/${KEY_ID}`, patch({ isEnabled: false }));
    expect(last.status).toBe(409);
    expect((await last.json()).code).toBe('UNIFI_LAST_ENABLED_KEY');
    vi.mocked(keySvc.updateKey).mockRejectedValueOnce(new keySvc.UnifiKeyError('UNIFI_KEY_NOT_FOUND'));
    const missing = await app().request(`/unifi/keys/${KEY_ID}`, patch({ label: 'x' }));
    expect(missing.status).toBe(404);
  });
});

describe('DELETE /unifi/keys/:keyId', () => {
  it('removes the key and audits it', async () => {
    const res = await app().request(`/unifi/keys/${KEY_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(keySvc.deleteKey).toHaveBeenCalledWith({}, { integrationId: CONN_ID, partnerId: PARTNER_ID, keyId: KEY_ID });
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'unifi.key.remove', details: { integrationId: CONN_ID, keyId: KEY_ID, label: 'Old label' },
    }));
  });

  it('is idempotent: an already-removed key answers success without an audit row', async () => {
    vi.mocked(keySvc.deleteKey).mockResolvedValue(false);
    vi.mocked(keySvc.listKeys).mockResolvedValue([]);
    const res = await app().request(`/unifi/keys/${KEY_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('refuses the last enabled key with 409', async () => {
    vi.mocked(keySvc.deleteKey).mockRejectedValue(new keySvc.UnifiKeyError('UNIFI_LAST_ENABLED_KEY'));
    const res = await app().request(`/unifi/keys/${KEY_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('UNIFI_LAST_ENABLED_KEY');
  });
});

describe('POST /unifi/keys/:keyId/test', () => {
  it('reads hosts and sites with that key outside any DB context', async () => {
    const res = await app().request(`/unifi/keys/${KEY_ID}/test`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, hostsFound: 2, sitesFound: 3 });
    expect(state.listHostsCalledInContext).toEqual([false]);
    expect(keySvc.getKeyForTest).toHaveBeenCalledWith({}, CONN_ID, PARTNER_ID, KEY_ID);
  });

  it('a rejected key answers 400 with a message that never holds the key', async () => {
    listHosts.mockRejectedValue(new UnifiApiError(`UniFi API error 401: ${SECRET_KEY}`, 401));
    const res = await app().request(`/unifi/keys/${KEY_ID}/test`, { method: 'POST' });
    expect(res.status).toBe(400);
    const text = await res.text();
    expectNoSecret(text);
    expect(JSON.parse(text)).toMatchObject({ success: false, hostsFound: 0, sitesFound: 0 });
  });

  it('an unreachable UniFi answers 502', async () => {
    listHosts.mockRejectedValue(new Error('ETIMEDOUT'));
    const res = await app().request(`/unifi/keys/${KEY_ID}/test`, { method: 'POST' });
    expect(res.status).toBe(502);
  });

  it('an unknown key answers 404', async () => {
    vi.mocked(keySvc.getKeyForTest).mockResolvedValue(null);
    const res = await app().request(`/unifi/keys/${KEY_ID}/test`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('a key that does not decrypt answers 400 without calling UniFi', async () => {
    vi.mocked(keySvc.getKeyForTest).mockResolvedValue({
      baseUrl: 'https://api.ui.com',
      key: { id: KEY_ID, label: 'Macera', apiKey: null, decryptError: 'The stored API key could not be decrypted', lastSeenHostIds: null },
    });
    const res = await app().request(`/unifi/keys/${KEY_ID}/test`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect(listHosts).not.toHaveBeenCalled();
  });
});

describe('secrets and MFA', () => {
  it('every write route requires MFA', async () => {
    state.mfa = false;
    const calls: Array<[string, RequestInit]> = [
      ['/unifi/keys', json({ label: 'Macera', apiKey: SECRET_KEY })],
      [`/unifi/keys/${KEY_ID}`, patch({ label: 'x' })],
      [`/unifi/keys/${KEY_ID}`, { method: 'DELETE' }],
      [`/unifi/keys/${KEY_ID}/test`, { method: 'POST' }],
    ];
    for (const [path, init] of calls) {
      const res = await app().request(path, init);
      expect(res.status, `${init.method} ${path}`).toBe(403);
    }
    expect(listHosts).not.toHaveBeenCalled();
    expect(keySvc.addKey).not.toHaveBeenCalled();
    expect(keySvc.updateKey).not.toHaveBeenCalled();
    expect(keySvc.deleteKey).not.toHaveBeenCalled();
  });

  it('the audit row never contains the key or its last four', async () => {
    await app().request('/unifi/keys', json({ label: 'Macera', apiKey: SECRET_KEY }));
    await app().request(`/unifi/keys/${KEY_ID}`, patch({ apiKey: SECRET_KEY, label: 'Renamed', isEnabled: true }));
    await app().request(`/unifi/keys/${KEY_ID}`, { method: 'DELETE' });
    const audits = vi.mocked(writeRouteAudit).mock.calls.map((call) => call[1]);
    expect(audits.map((a) => a.action)).toEqual(['unifi.key.add', 'unifi.key.update', 'unifi.key.remove']);
    for (const a of audits) {
      expect(a).toMatchObject({ orgId: null, partnerId: PARTNER_ID, resourceType: 'unifi_integration_key', resourceId: KEY_ID });
      const text = JSON.stringify(a);
      expectNoSecret(text);
      expect(text).not.toContain(LAST4);
      expect(text).not.toContain('keyLast4');
    }
    expect(audits[1]!.details).toMatchObject({ changed: ['label', 'secret'] });
  });

  it('responses never include apiKeyEncrypted or the key', async () => {
    const texts = [
      await (await app().request('/unifi/keys')).text(),
      await (await app().request('/unifi/keys', json({ label: 'Macera', apiKey: SECRET_KEY }))).text(),
      await (await app().request(`/unifi/keys/${KEY_ID}`, patch({ apiKey: SECRET_KEY }))).text(),
      await (await app().request(`/unifi/keys/${KEY_ID}/test`, { method: 'POST' })).text(),
    ];
    for (const t of texts) expectNoSecret(t);
    for (const line of logged) expectNoSecret(line);
  });
});
