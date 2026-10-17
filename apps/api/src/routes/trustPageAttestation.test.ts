import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify, type JSONWebKeySet } from 'jose';

const serving = vi.hoisted(() => ({ isServing: vi.fn(), readCachedSnapshotPayload: vi.fn(async () => null), cacheSnapshotPayload: vi.fn() }));
vi.mock('../services/trustPage/servingSet', () => ({ ...serving, trustServingMember: (p: string, o?: string) => (o ? `${p}/${o}` : p) }));
const resolve = vi.hoisted(() => ({ resolvePublishedTrustPage: vi.fn() }));
vi.mock('../services/trustPage/resolve', async (orig) => ({ ...(await orig<typeof import('../services/trustPage/resolve')>()), ...resolve }));
// Token cache off: the signing service's cache is covered in attestation.test.ts.
vi.mock('../services/redis', () => ({ getRedis: () => null }));
const dbSelect = vi.hoisted(() => vi.fn());
vi.mock('../db', () => ({
  db: { select: dbSelect },
  runOutsideDbContext: <T>(fn: () => T) => fn(),
  withSystemDbAccessContext: async <T>(fn: () => Promise<T>) => fn(),
  hasDbAccessContext: () => false,
  runAfterDbContextExit: (_label: string, work: () => unknown) => { work(); },
  runAfterDbContextCommit: (_label: string, work: () => unknown) => { work(); },
}));
vi.mock('../services/secretCrypto', () => ({
  encryptSecret: (s: string | null | undefined) => (s == null ? null : `enc:${Buffer.from(s, 'utf8').toString('base64')}`),
  decryptForColumn: (_t: string, _c: string, s: string | null | undefined) =>
    s == null ? null : Buffer.from(s.replace(/^enc:/, ''), 'base64').toString('utf8'),
}));

import { trustPageAttestationRoutes } from './trustPageAttestation';
import {
  activateTrustSigningKey,
  prepareTrustSigningKey,
  revokeTrustSigningKey,
  __setTrustKeyStoreForTests,
  type TrustKeyRow,
  type TrustKeyStore,
} from '../services/trustPage/attestationKeys';
import { __resetHotPathCachesForTests } from '../services/hotPathCache';

class MemoryStore implements TrustKeyStore {
  rows: TrustKeyRow[] = [];
  async run<T>(fn: Parameters<TrustKeyStore['run']>[0]): Promise<T> {
    const working = this.rows.map((r) => ({ ...r }));
    const result = await fn({
      list: async () => working.map((r) => ({ ...r })),
      insert: async (row) => {
        if (row.status === 'active' && working.some((r) => r.status === 'active')) return false;
        working.push({ ...row, activatedAt: row.activatedAt ?? null, createdAt: new Date(), retiredAt: null, revokedAt: null });
        return true;
      },
      update: async (kid, patch) => { Object.assign(working.find((r) => r.kid === kid)!, patch); },
    });
    this.rows = working;
    return result as T;
  }
}

const ISSUER = 'https://breeze.example.com';
const PAYLOAD = { schemaVersion: 1, snapshotId: 's1', org: { name: 'Acme', logoUrl: null, primaryColor: null }, managedBy: { name: 'NW' }, summary: { catalogTotal: 15, controlsShown: 15, controlsMet: 9 }, controls: [], documents: [], footer: { poweredByBreeze: true, frameworkAttributions: [] } };
const RESOLVED = () => ({ pageId: 'pg', orgId: 'o', partnerId: 'p', publishedAt: new Date('2026-10-01T00:00:00Z'), searchIndexable: true, lastEvaluatedAt: new Date(Date.now() - 600_000), snapshotId: 's1', payload: PAYLOAD });
const GENERIC = { error: 'Not found', code: 'NOT_FOUND' };

// Mounted the way index.ts does it, behind the app-wide credentialed CORS (which must not leak onto these responses).
const app = new Hono();
app.use('*', cors({ origin: (origin) => (origin === 'https://dashboard.example.com' ? origin : null), credentials: true }));
const api = new Hono();
api.route('/trust/attestation', trustPageAttestationRoutes);
app.route('/api/v1', api);

let store: MemoryStore;
const get = (path: string, headers: Record<string, string> = {}) => app.request(`/api/v1/trust/attestation${path}`, { headers });
async function jwks(): Promise<JSONWebKeySet> {
  return (await get('/jwks.json')).json() as Promise<JSONWebKeySet>;
}
const verifyOpts = (sub: string) => ({ algorithms: ['ES256'], typ: 'trust-attestation+jwt', issuer: ISSUER, subject: sub });

beforeEach(() => {
  vi.clearAllMocks();
  store = new MemoryStore();
  __setTrustKeyStoreForTests(store);
  __resetHotPathCachesForTests();
  serving.isServing.mockResolvedValue(true);
  resolve.resolvePublishedTrustPage.mockImplementation(async () => RESOLVED());
  vi.stubEnv('DASHBOARD_URL', ISSUER);
});
afterEach(() => {
  __setTrustKeyStoreForTests(null);
  vi.unstubAllEnvs();
});

describe('GET /jwks.json', () => {
  it('200 application/jwk-set+json, public, max-age=600, Access-Control-Allow-Origin *, no Access-Control-Allow-Credentials, never empty (it provisions first)', async () => {
    expect(store.rows).toHaveLength(0);
    const res = await get('/jwks.json', { Origin: 'https://dashboard.example.com' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/jwk-set+json');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=600');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    const body = await res.json() as JSONWebKeySet;
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig', kid: store.rows[0]!.kid });
    expect(body.keys[0]).not.toHaveProperty('d');
    expect(store.rows).toHaveLength(1);
  });

  it('after a revoke without --replace it still serves the verify-only keys (archival verification)', async () => {
    await get('/jwks.json');
    const first = store.rows[0]!.kid;
    const prepared = await prepareTrustSigningKey();
    await activateTrustSigningKey(prepared.kid, { force: true });
    await revokeTrustSigningKey(prepared.kid);
    const res = await get('/jwks.json');
    expect(res.status).toBe(200);
    expect(((await res.json()) as JSONWebKeySet).keys.map((k) => k.kid)).toEqual([first]);
  });

  it('a keyset with nothing publishable → 503 no-store, never an empty JWKS', async () => {
    await get('/jwks.json');
    await revokeTrustSigningKey(store.rows[0]!.kid);
    const res = await get('/jwks.json');
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('GET /:partnerSlug/:orgSlug', () => {
  it('serving page → 200 application/jwt that verifies against /jwks.json; max-age ≤ 60 and ≤ exp − now; X-Robots-Tag noindex', async () => {
    const res = await get('/nw/acme', { Origin: 'https://dashboard.example.com' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/jwt');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    const token = await res.text();
    const { payload } = await jwtVerify(token, createLocalJWKSet(await jwks()), verifyOpts(`${ISSUER}/portal/trust/nw/acme`));
    expect((payload.trust as { payload: unknown }).payload).toEqual(PAYLOAD);

    const maxAge = Number(/^public, max-age=(\d+)$/.exec(res.headers.get('Cache-Control') ?? '')?.[1]);
    expect(maxAge).toBeLessThanOrEqual(60);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(decodeJwt(token).exp! - Math.floor(Date.now() / 1000));
  });

  it('max-age shrinks to exp − now when the page is close to going stale', async () => {
    resolve.resolvePublishedTrustPage.mockResolvedValue({ ...RESOLVED(), lastEvaluatedAt: new Date(Date.now() - (86400 - 30) * 1000) });
    const res = await get('/nw/acme');
    expect(res.status).toBe(200);
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('Cache-Control') ?? '')?.[1]);
    expect(maxAge).toBeLessThanOrEqual(30);
  });

  it('GET /:p (partner home) signs the partner-home URL', async () => {
    const res = await get('/nw');
    expect(res.status).toBe(200);
    expect(resolve.resolvePublishedTrustPage).toHaveBeenCalledWith('nw', null);
    await expect(jwtVerify(await res.text(), createLocalJWKSet(await jwks()), verifyOpts(`${ISSUER}/portal/trust/nw`))).resolves.toBeDefined();
  });

  it('unknown / unpublished / untrusted / invalid slug / reserved slug → the generic 404 with no-store (identical bodies and headers)', async () => {
    const snapshot = async (res: Response) => ({ status: res.status, body: await res.json(), headers: [...res.headers.entries()] });
    resolve.resolvePublishedTrustPage.mockResolvedValue(null); // unknown, unpublished and untrusted all resolve to null
    const unknown = await snapshot(await get('/nw/acme'));
    serving.isServing.mockResolvedValue(false);
    const notServing = await snapshot(await get('/nw/acme'));
    const invalid = await snapshot(await get('/NW/acme'));
    const tooLong = await snapshot(await get(`/${'x'.repeat(80)}/acme`));
    const reserved = await snapshot(await get('/preview/acme'));
    const deeper = await snapshot(await get('/nw/acme/extra'));
    expect(unknown).toEqual({ status: 404, body: GENERIC, headers: expect.arrayContaining([['cache-control', 'no-store']]) });
    for (const other of [notServing, invalid, tooLong, reserved, deeper]) expect(other).toEqual(unknown);
  });

  it('serving-set miss → 404 without a SQL call', async () => {
    serving.isServing.mockResolvedValue(false);
    expect((await get('/nw/acme')).status).toBe(404);
    expect(resolve.resolvePublishedTrustPage).not.toHaveBeenCalled();
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it('invalid slug → 404 before Redis', async () => {
    expect((await get('/NW/acme')).status).toBe(404);
    expect(serving.isServing).not.toHaveBeenCalled();
  });

  it('Redis down → falls through to the live resolve', async () => {
    serving.isServing.mockResolvedValue(null);
    expect((await get('/nw/acme')).status).toBe(200);
    expect(resolve.resolvePublishedTrustPage).toHaveBeenCalledWith('nw', 'acme');
  });

  it('no current snapshot → 404', async () => {
    resolve.resolvePublishedTrustPage.mockResolvedValue({ ...RESOLVED(), snapshotId: null, payload: null });
    const res = await get('/nw/acme');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(GENERIC);
  });

  it('serves the cached snapshot payload when present', async () => {
    serving.readCachedSnapshotPayload.mockResolvedValueOnce({ ...PAYLOAD, snapshotId: 's1' } as never);
    resolve.resolvePublishedTrustPage.mockResolvedValue({ ...RESOLVED(), payload: null });
    const res = await get('/nw/acme');
    expect(res.status).toBe(200);
    expect((decodeJwt(await res.text()).trust as { payload: unknown }).payload).toEqual(PAYLOAD);
  });

  it('stale page → 503 ATTESTATION_STALE, Retry-After 3600, no-store', async () => {
    for (const lastEvaluatedAt of [null, new Date(Date.now() - 25 * 3600_000)]) {
      resolve.resolvePublishedTrustPage.mockResolvedValue({ ...RESOLVED(), lastEvaluatedAt });
      const res = await get('/nw/acme');
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: 'ATTESTATION_STALE' });
      expect(res.headers.get('Retry-After')).toBe('3600');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    }
  });

  it('attestation from a rotated-out kid verifies against the JWKS', async () => {
    const old = await (await get('/nw/acme')).text();
    const prepared = await prepareTrustSigningKey();
    await activateTrustSigningKey(prepared.kid, { force: true });
    __resetHotPathCachesForTests();
    const current = await (await get('/nw/acme')).text();
    expect(decodeProtectedHeader(current).kid).toBe(prepared.kid);
    expect(decodeProtectedHeader(old).kid).not.toBe(prepared.kid);
    const set = createLocalJWKSet(await jwks());
    await expect(jwtVerify(old, set, verifyOpts(`${ISSUER}/portal/trust/nw/acme`))).resolves.toBeDefined();
    await expect(jwtVerify(current, set, verifyOpts(`${ISSUER}/portal/trust/nw/acme`))).resolves.toBeDefined();
  });

  it('no active key (revoked without --replace) → 503 no-store', async () => {
    await get('/jwks.json');
    await revokeTrustSigningKey(store.rows[0]!.kid);
    const res = await get('/nw/acme');
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(store.rows).toHaveLength(1); // never silently re-provisioned
  });

  it('issuer unavailable (production without DASHBOARD_URL/PUBLIC_APP_URL) → 503 no-store', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DASHBOARD_URL', '');
    vi.stubEnv('PUBLIC_APP_URL', '');
    const res = await get('/nw/acme');
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('an unexpected failure is still no-store', async () => {
    resolve.resolvePublishedTrustPage.mockRejectedValue(new Error('db down'));
    const res = await get('/nw/acme');
    expect(res.status).toBe(500);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
