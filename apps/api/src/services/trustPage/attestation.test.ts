import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import type { TrustPagePublicPayload } from '@breeze/shared';

vi.mock('../secretCrypto', () => ({
  encryptSecret: (s: string | null | undefined) => (s == null ? null : `enc:${Buffer.from(s, 'utf8').toString('base64')}`),
  decryptForColumn: (_t: string, _c: string, s: string | null | undefined) =>
    s == null ? null : Buffer.from(s.replace(/^enc:/, ''), 'base64').toString('utf8'),
}));
vi.mock('../../db', () => ({
  db: {},
  withSystemDbAccessContext: async <T>(fn: () => Promise<T>) => fn(),
  runOutsideDbContext: <T>(fn: () => T) => fn(),
  hasDbAccessContext: () => false,
  runAfterDbContextExit: (_label: string, work: () => unknown) => { work(); },
  runAfterDbContextCommit: (_label: string, work: () => unknown) => { work(); },
}));

/** Fake Redis: records SET … EX ttl; `fail` makes every call throw. */
const redis = vi.hoisted(() => {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  const state = { enabled: true, fail: false };
  const client = {
    get: async (k: string) => { if (state.fail) throw new Error('redis down'); return store.get(k) ?? null; },
    set: async (k: string, v: string, mode: string, ttl: number) => {
      if (state.fail) throw new Error('redis down');
      if (mode !== 'EX') throw new Error(`unexpected SET mode ${mode}`);
      store.set(k, v); ttls.set(k, ttl); return 'OK';
    },
  };
  return { store, ttls, state, client };
});
vi.mock('../redis', () => ({ getRedis: () => (redis.state.enabled ? redis.client : null) }));

import {
  signTrustAttestation,
  trustAttestationIssuer,
  trustCanonicalPageUrl,
  TrustAttestationStale,
  TRUST_ATTESTATION_TYP,
} from './attestation';
import {
  activateTrustSigningKey,
  loadTrustJwks,
  prepareTrustSigningKey,
  revokeTrustSigningKey,
  TrustAttestationUnavailable,
  __setTrustKeyStoreForTests,
  type TrustKeyRow,
  type TrustKeyStore,
  type TrustKeyTx,
} from './attestationKeys';
import { __resetHotPathCachesForTests } from '../hotPathCache';
import type { ResolvedTrustPage } from './resolve';

/** Minimal transactional in-memory store (the key service itself is covered by attestationKeys.test.ts). */
class MemoryStore implements TrustKeyStore {
  rows: TrustKeyRow[] = [];
  async run<T>(fn: (tx: TrustKeyTx) => Promise<T>): Promise<T> {
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
    return result;
  }
}

const NOW = new Date('2026-10-16T12:00:00Z');
const NOW_S = NOW.getTime() / 1000;
const PAYLOAD = {
  schemaVersion: 1, snapshotId: 'snap-1', org: { name: 'Acme', logoUrl: null, primaryColor: null }, managedBy: { name: 'NW' },
  summary: { catalogTotal: 15, controlsShown: 15, controlsMet: 9 }, controls: [], documents: [],
  footer: { poweredByBreeze: true, frameworkAttributions: [] },
} as unknown as TrustPagePublicPayload;

function resolved(over: Partial<ResolvedTrustPage> = {}): ResolvedTrustPage {
  return {
    pageId: 'pg', orgId: 'o', partnerId: 'p', publishedAt: new Date('2026-10-01T00:00:00Z'), searchIndexable: false,
    lastEvaluatedAt: new Date(NOW.getTime() - 3600_000), snapshotId: 'snap-1', payload: PAYLOAD, ...over,
  };
}

const ISSUER = 'https://breeze.example.com';
const SUB = `${ISSUER}/portal/trust/nw/acme`;
const sign = (over: Partial<ResolvedTrustPage> = {}, canonicalUrl = SUB) =>
  signTrustAttestation({ resolved: resolved(over), payload: PAYLOAD, canonicalUrl });
const verifyOpts = { algorithms: ['ES256'], typ: TRUST_ATTESTATION_TYP, issuer: ISSUER, subject: SUB };

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore();
  __setTrustKeyStoreForTests(store);
  __resetHotPathCachesForTests();
  redis.store.clear(); redis.ttls.clear(); redis.state.enabled = true; redis.state.fail = false;
  vi.stubEnv('DASHBOARD_URL', `${ISSUER}/some/path/`);
  vi.stubEnv('PUBLIC_APP_URL', 'https://other.example.org');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  __setTrustKeyStoreForTests(null);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('issuer and canonical URL', () => {
  it('iss is the origin of DASHBOARD_URL, else PUBLIC_APP_URL', () => {
    expect(trustAttestationIssuer()).toBe(ISSUER);
    vi.stubEnv('DASHBOARD_URL', '');
    expect(trustAttestationIssuer()).toBe('https://other.example.org');
  });
  it('sub is <iss>/portal/trust/<p>[/<o>], slugs URL-encoded', () => {
    expect(trustCanonicalPageUrl(ISSUER, 'nw', 'acme')).toBe(SUB);
    expect(trustCanonicalPageUrl(ISSUER, 'nw', null)).toBe(`${ISSUER}/portal/trust/nw`);
  });
  it('production without DASHBOARD_URL/PUBLIC_APP_URL throws TrustAttestationUnavailable', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DASHBOARD_URL', '');
    vi.stubEnv('PUBLIC_APP_URL', '');
    expect(() => trustAttestationIssuer()).toThrow(TrustAttestationUnavailable);
  });
  it('outside production falls back to the local dashboard origin', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DASHBOARD_URL', '');
    vi.stubEnv('PUBLIC_APP_URL', '');
    expect(trustAttestationIssuer()).toBe('http://localhost:4321');
  });
});

describe('signTrustAttestation', () => {
  it("signs a compact JWT whose header is { alg: 'ES256', kid, typ: 'trust-attestation+jwt' }", async () => {
    const token = await sign();
    expect(token.split('.')).toHaveLength(3);
    const header = decodeProtectedHeader(token);
    expect(header).toEqual({ alg: 'ES256', kid: store.rows[0]!.kid, typ: 'trust-attestation+jwt' });
  });

  it('claims carry iss, sub, iat, jti (uuid), trust.v = 1, trust.payload deep-equals the input payload', async () => {
    const claims = decodeJwt(await sign());
    expect(claims.iss).toBe(ISSUER);
    expect(claims.sub).toBe(SUB);
    expect(claims.aud).toBeUndefined();
    expect(claims.iat).toBe(NOW_S);
    expect(claims.jti).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(claims.trust).toEqual({ v: 1, payload: PAYLOAD, lastEvaluatedAt: new Date(NOW.getTime() - 3600_000).toISOString() });
  });

  it('exp = iat + 3600 when lastEvaluatedAt is fresh', async () => {
    const claims = decodeJwt(await sign({ lastEvaluatedAt: new Date(NOW.getTime() - 60_000) }));
    expect(claims.exp).toBe(NOW_S + 3600);
  });

  it('exp = lastEvaluatedAt + 86400 when that is sooner', async () => {
    const lae = new Date(NOW.getTime() - (86400 - 600) * 1000); // 10 min of freshness left
    const claims = decodeJwt(await sign({ lastEvaluatedAt: lae }));
    expect(claims.exp).toBe(lae.getTime() / 1000 + 86400);
    expect(claims.exp).toBe(NOW_S + 600);
  });

  it('stale or null lastEvaluatedAt → throws TrustAttestationStale', async () => {
    await expect(sign({ lastEvaluatedAt: null })).rejects.toBeInstanceOf(TrustAttestationStale);
    await expect(sign({ lastEvaluatedAt: new Date(NOW.getTime() - 86400_000) })).rejects.toBeInstanceOf(TrustAttestationStale);
    await expect(sign({ lastEvaluatedAt: new Date(NOW.getTime() - 86400_000 - 1) })).rejects.toBeInstanceOf(TrustAttestationStale);
  });

  it('two tokens issued without the cache have different jti', async () => {
    redis.state.enabled = false;
    const a = decodeJwt(await sign());
    const b = decodeJwt(await sign());
    expect(a.jti).not.toBe(b.jti);
  });

  it('verifies with jwtVerify(token, createLocalJWKSet(jwks), { algorithms: [ES256], typ, issuer, subject })', async () => {
    const token = await sign();
    const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(await loadTrustJwks()), verifyOpts);
    expect(protectedHeader.typ).toBe('trust-attestation+jwt');
    expect((payload.trust as { payload: unknown }).payload).toEqual(PAYLOAD);
    // A wrong subject (a different page's URL) is rejected.
    await expect(jwtVerify(token, createLocalJWKSet(await loadTrustJwks()), { ...verifyOpts, subject: `${ISSUER}/portal/trust/nw/other` })).rejects.toThrow();
  });

  it('verify-only key stays in JWKS after activate', async () => {
    const tokenA = await sign();
    const kidA = decodeProtectedHeader(tokenA).kid;
    const prepared = await prepareTrustSigningKey();
    await activateTrustSigningKey(prepared.kid, { force: true });
    redis.store.clear();

    const jwks = await loadTrustJwks();
    expect(jwks.keys.map((k) => k.kid)).toEqual(expect.arrayContaining([kidA, prepared.kid]));
    await expect(jwtVerify(tokenA, createLocalJWKSet(jwks), verifyOpts)).resolves.toBeDefined();
    const tokenB = await sign();
    expect(decodeProtectedHeader(tokenB).kid).toBe(prepared.kid);
    await expect(jwtVerify(tokenB, createLocalJWKSet(jwks), verifyOpts)).resolves.toBeDefined();
  });

  it("revoked key's token no longer verifies", async () => {
    const tokenA = await sign();
    const kidA = decodeProtectedHeader(tokenA).kid!;
    await revokeTrustSigningKey(kidA, { replace: true });
    const jwks = await loadTrustJwks();
    expect(jwks.keys.map((k) => k.kid)).not.toContain(kidA);
    await expect(jwtVerify(tokenA, createLocalJWKSet(jwks), verifyOpts)).rejects.toThrow();
  });

  it('revoked without --replace: signing is unavailable, never a silent new key', async () => {
    const kidA = decodeProtectedHeader(await sign()).kid!;
    await revokeTrustSigningKey(kidA);
    redis.store.clear();
    await expect(sign()).rejects.toBeInstanceOf(TrustAttestationUnavailable);
    expect(store.rows).toHaveLength(1);
  });

  it('cache hit returns the same string without signing', async () => {
    const a = await sign();
    const b = await sign();
    expect(b).toBe(a); // a fresh signature would carry a new random jti
    expect(redis.store.size).toBe(1);
  });

  it('cache key changes with sub (slug rename), lastEvaluatedAt and kid', async () => {
    await sign();
    const keys = () => [...redis.store.keys()];
    const first = keys()[0]!;
    expect(first).toMatch(/^trust:attest:trust-[A-Za-z0-9_-]{16}:[0-9a-f]{64}:snap-1:\d+$/);

    await sign({}, `${ISSUER}/portal/trust/nw/acme-renamed`);
    expect(keys()).toHaveLength(2);

    await sign({ lastEvaluatedAt: new Date(NOW.getTime() - 1800_000) });
    expect(keys()).toHaveLength(3);

    const prepared = await prepareTrustSigningKey();
    await activateTrustSigningKey(prepared.kid, { force: true });
    await sign();
    expect(keys()).toHaveLength(4);
    expect(keys().filter((k) => k.startsWith(`trust:attest:${prepared.kid}:`))).toHaveLength(1);
  });

  it('cache TTL never outlives exp − 60 s', async () => {
    await sign({ lastEvaluatedAt: new Date(NOW.getTime() - 60_000) }); // exp = now + 3600 → ttl capped at 300
    expect([...redis.ttls.values()]).toEqual([300]);

    redis.ttls.clear(); redis.store.clear();
    const token = await sign({ lastEvaluatedAt: new Date(NOW.getTime() - (86400 - 200) * 1000) }); // exp = now + 200
    expect(decodeJwt(token).exp).toBe(NOW_S + 200);
    expect([...redis.ttls.values()]).toEqual([140]);

    redis.ttls.clear(); redis.store.clear();
    await sign({ lastEvaluatedAt: new Date(NOW.getTime() - (86400 - 50) * 1000) }); // exp = now + 50 → not cached
    expect(redis.store.size).toBe(0);
  });

  it('Redis errors are logged and skipped, never fatal', async () => {
    redis.state.fail = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = await sign();
    await expect(jwtVerify(token, createLocalJWKSet(await loadTrustJwks()), verifyOpts)).resolves.toBeDefined();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/"d"/);
    warn.mockRestore();
  });
});
