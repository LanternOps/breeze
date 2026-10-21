/**
 * B-W03 (#6157): the CIMD wiring against a REAL oidc-provider instance, so an
 * oidc-provider upgrade (or an `ack` mismatch) that stops calling our hooks
 * fails here rather than in production. Review Focus 3 and 4.
 *
 * Only the edges are faked: the outbound HTTP (`safeFetch`), Redis, the DB and
 * the materialising `cimdAllowClient` (a spy whose answer the test controls).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair } from 'jose';
import { Provider } from 'oidc-provider';

const state = vi.hoisted(() => ({
  documents: new Map<string, Record<string, unknown>>(),
  fetched: [] as string[],
  allowClient: true,
}));

vi.mock('../services/connectionHealth/oauthRetryCounter', () => ({ recordRefreshRetry: vi.fn() }));
vi.mock('../db', () => ({
  db: { select: vi.fn(() => { throw new Error('unexpected db access'); }) },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_c: unknown, fn: () => unknown) => fn()),
}));
vi.mock('../services/tenantStatus', () => ({
  TenantInactiveError: class TenantInactiveError extends Error {},
  assertActiveTenantContext: vi.fn(async () => {}),
  getActivePartner: vi.fn(async () => null),
  getActiveOrgTenant: vi.fn(async () => null),
}));
vi.mock('../services/redis', () => ({ getRedis: () => null }));
vi.mock('./cimdKnownClient', () => ({ isActiveMaterializedCimdClient: async () => false }));
vi.mock('./cimdClients', () => ({
  cimdAllowClient: vi.fn(async () => state.allowClient),
}));
vi.mock('../services/urlSafety', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/urlSafety')>(),
  safeFetch: vi.fn(async (url: string) => {
    state.fetched.push(url);
    const doc = state.documents.get(url);
    if (!doc) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(doc), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'max-age=600' },
    });
  }),
}));

import { buildOidcProviderConfiguration } from './provider';
import { cimdAllowClient } from './cimdClients';
import { __resetCimdApprovalsForTests, __resetCimdRefusalLogForTests } from './cimdPolicy';

const allowClientSpy = vi.mocked(cimdAllowClient);
let provider: Provider;
const savedEnv = { ...process.env };

function doc(id: string, extra: Record<string, unknown> = {}) {
  return {
    client_id: id,
    client_name: 'Example Agent',
    redirect_uris: ['http://127.0.0.1:3000/cb'],
    token_endpoint_auth_method: 'none',
    ...extra,
  };
}

beforeAll(async () => {
  process.env.OAUTH_CIMD_ENABLED = 'true';
  process.env.NODE_ENV = 'test';
  delete process.env.OAUTH_CIMD_ALLOWED_HOSTS;
  const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const jwk = { ...(await exportJWK(privateKey)), kid: 'test', alg: 'EdDSA', use: 'sig' };
  const config = buildOidcProviderConfiguration({ keys: [jwk] } as never, { cimdEnabled: true });
  provider = new Provider('https://issuer.example', config);
});

afterAll(() => {
  process.env = savedEnv;
});

beforeEach(() => {
  state.documents.clear();
  state.fetched = [];
  state.allowClient = true;
  allowClientSpy.mockClear();
  __resetCimdApprovalsForTests();
  __resetCimdRefusalLogForTests();
});

describe('CIMD through a real oidc-provider', () => {
  it('resolves a document once, then calls allowClient on every use including cache hits', async () => {
    const id = 'https://client.example.com/oauth/a.json';
    state.documents.set(id, doc(id));

    const first = await provider.Client.find(id);
    expect(first?.clientId).toBe(id);
    expect(state.fetched).toEqual([id]);
    expect(allowClientSpy).toHaveBeenCalledTimes(1);

    const second = await provider.Client.find(id);
    expect(second?.clientId).toBe(id);
    expect(state.fetched).toEqual([id]); // cache hit, no refetch
    expect(allowClientSpy).toHaveBeenCalledTimes(2); // ...but the policy ran again
  });

  it('a cached client is refused as soon as allowClient says no (disable / narrowed hosts)', async () => {
    const id = 'https://client.example.com/oauth/b.json';
    state.documents.set(id, doc(id));
    await provider.Client.find(id);
    state.allowClient = false;
    await expect(provider.Client.find(id)).rejects.toMatchObject({ error: 'invalid_client', error_description: 'client is not allowed' });
    expect(state.fetched).toEqual([id]);
  });

  it('a document naming an internal sector_identifier_uri never causes a second fetch', async () => {
    const id = 'https://client.example.com/oauth/c.json';
    state.documents.set(id, doc(id, {
      sector_identifier_uri: 'https://169.254.169.254/latest/meta-data',
      subject_type: 'pairwise',
    }));
    await expect(provider.Client.find(id)).rejects.toThrow();
    expect(state.fetched).toEqual([id]);
  });

  it('a non-CIMD id is never fetched', async () => {
    await expect(provider.Client.find('https://127.0.0.1/oauth/x.json')).rejects.toThrow();
    expect(state.fetched).toEqual([]);
  });
});
