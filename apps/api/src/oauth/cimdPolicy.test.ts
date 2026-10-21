import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  redis: {} as object | null,
  hostBudgetLeft: Infinity,
  globalBudgetLeft: Infinity,
  rateLimiterThrows: false,
  rateKeys: [] as string[],
  knownBudgetLeft: Infinity,
  knownClient: false,
  knownClientThrows: false,
  warns: [] as Array<{ errorId: string; context?: Record<string, unknown>; err?: unknown }>,
}));

vi.mock('./log', async (importOriginal) => ({
  ...await importOriginal<typeof import('./log')>(),
  logOauthWarn: (args: { errorId: string; context?: Record<string, unknown>; err?: unknown }) => { state.warns.push(args); },
}));
vi.mock('./cimdKnownClient', () => ({
  isActiveMaterializedCimdClient: async () => {
    if (state.knownClientThrows) throw new Error('db down');
    return state.knownClient;
  },
}));

vi.mock('../services/redis', () => ({ getRedis: () => state.redis }));
vi.mock('../services/rate-limit', () => ({
  rateLimiter: vi.fn(async (_redis: unknown, key: string) => {
    if (state.rateLimiterThrows) throw new Error('ECONNRESET');
    state.rateKeys.push(key);
    const left = key.includes(':host:') ? state.hostBudgetLeft
      : key.endsWith(':known') ? state.knownBudgetLeft : state.globalBudgetLeft;
    return { allowed: left > 0, remaining: Math.max(0, left - 1), resetAt: new Date(Date.now() + 60_000) };
  }),
}));

import {
  CIMD_APPROVAL_TTL_MS, CIMD_FETCH_BUDGET, CIMD_FETCH_TIMEOUT_MS, CIMD_MAX_BYTES,
  __cimdApprovalsForTests, __resetCimdApprovalsForTests, __resetCimdRefusalLogForTests, cimdAllowFetch, cimdHostAllowed,
  createOidcProviderFetch, isCimdClientId, parseCimdAllowedHosts, validateCimdMetadata,
} from './cimdPolicy';

const ID = 'https://client.example.com/oauth/metadata.json';

type CimdEnv = {
  enabled?: boolean;
  allowlist?: string[];
  hostBudgetLeft?: number;
  globalBudgetLeft?: number;
  nodeEnv?: string;
  redis?: object | null;
};

async function withCimdEnv<T>(env: CimdEnv, fn: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  process.env.OAUTH_CIMD_ENABLED = env.enabled === false ? 'false' : 'true';
  if (env.allowlist) process.env.OAUTH_CIMD_ALLOWED_HOSTS = env.allowlist.join(',');
  else delete process.env.OAUTH_CIMD_ALLOWED_HOSTS;
  if (env.nodeEnv) process.env.NODE_ENV = env.nodeEnv;
  state.hostBudgetLeft = env.hostBudgetLeft ?? Infinity;
  state.globalBudgetLeft = env.globalBudgetLeft ?? Infinity;
  state.redis = env.redis === undefined ? {} : env.redis;
  try {
    return await fn();
  } finally {
    process.env = saved;
  }
}

beforeEach(() => {
  __resetCimdApprovalsForTests();
  __resetCimdRefusalLogForTests();
  state.warns = [];
  state.knownClient = false;
  state.knownClientThrows = false;
  state.knownBudgetLeft = Infinity;
  state.rateKeys = [];
  state.rateLimiterThrows = false;
  state.redis = {};
});

describe('isCimdClientId', () => {
  it('https + real path only', () => {
    expect(isCimdClientId('https://client.example.com/oauth/metadata.json')).toBe(true);
    for (const bad of ['http://client.example.com/x', 'https://client.example.com/', 'https://client.example.com',
      'https://u:p@client.example.com/x', 'https://client.example.com/x#f', 'https://client.example.com/a/../x',
      'https://client.example.com/%2e%2e/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'Ab3dDcrStyleId']) {
      expect(isCimdClientId(bad), bad).toBe(false);
    }
  });
  it('rejects a query string, a backslash, whitespace, an IPv4-mapped literal and non-strings', () => {
    for (const bad of ['https://client.example.com/x?a=1', 'https://client.example.com/a\\b', 'https://client.example.com/a b',
      'https://[::ffff:127.0.0.1]/x', 'https://10.0.0.5/x', 'https://0x7f000001/x', 42, null, undefined]) {
      expect(isCimdClientId(bad), String(bad)).toBe(false);
    }
  });
});

describe('cimdHostAllowed / parseCimdAllowedHosts', () => {
  it('unset allowlist admits any host; .suffix needs a real subdomain; exact matches exact', () => {
    expect(cimdHostAllowed('client.example.com', [])).toBe(true);
    expect(cimdHostAllowed('client.example.com', ['.example.com'])).toBe(true);
    expect(cimdHostAllowed('example.com', ['.example.com'])).toBe(false);
    expect(cimdHostAllowed('evilexample.com', ['.example.com'])).toBe(false);
    expect(cimdHostAllowed('example.com', ['example.com'])).toBe(true);
    expect(cimdHostAllowed('a.example.com', ['example.com'])).toBe(false);
    expect(cimdHostAllowed('CLIENT.Example.com.', ['client.example.com'])).toBe(true);
  });
  it('parses a CSV, trimming and lower-casing; rejects malformed entries', () => {
    expect(parseCimdAllowedHosts(' Example.com , .example.org ')).toEqual({ ok: true, hosts: ['example.com', '.example.org'] });
    expect(parseCimdAllowedHosts(undefined)).toEqual({ ok: true, hosts: [] });
    expect(parseCimdAllowedHosts('')).toEqual({ ok: true, hosts: [] });
    for (const bad of ['https://example.com', 'example.com/path', '*.example.com', 'example.com,,x.org', 'exa mple.com', '..example.com']) {
      expect(parseCimdAllowedHosts(bad).ok, bad).toBe(false);
    }
  });
});

describe('cimdAllowFetch', () => {
  it.each([
    ['flag off', { enabled: false }],
    ['host not in OAUTH_CIMD_ALLOWED_HOSTS', { allowlist: ['.trusted.example.org'] }],
    ['per-host budget spent', { hostBudgetLeft: 0 }],
    ['global budget spent', { globalBudgetLeft: 0 }],
    ['production without redis', { nodeEnv: 'production', redis: null }],
  ] as Array<[string, CimdEnv]>)('allowFetch refuses: %s', async (_l, env) => {
    expect(await withCimdEnv(env, () => cimdAllowFetch({}, ID))).toBe(false);
    expect(__cimdApprovalsForTests().size).toBe(0);
  });

  it('refuses a URL that is not a CIMD client id', async () => {
    expect(await withCimdEnv({}, () => cimdAllowFetch({}, 'https://127.0.0.1/x'))).toBe(false);
    expect(state.rateKeys).toEqual([]);
  });

  it('fails closed when the rate limiter throws', async () => {
    state.rateLimiterThrows = true;
    expect(await withCimdEnv({}, async () => {
      state.rateLimiterThrows = true;
      return cimdAllowFetch({}, ID);
    })).toBe(false);
  });

  it('admits a suffix match and registers a single approval', async () => {
    expect(await withCimdEnv({ allowlist: ['.example.com'] }, () => cimdAllowFetch({}, ID))).toBe(true);
    expect([...__cimdApprovalsForTests().keys()]).toEqual([ID]);
    expect(state.rateKeys).toEqual(['oauth:cimd:fetch:host:client.example.com', 'oauth:cimd:fetch:global']);
  });

  it('budgets match the plan', () => {
    expect(CIMD_FETCH_BUDGET).toEqual({ perHostPerMinute: 10, globalPerMinute: 120, createsPerHour: 200 });
    expect(CIMD_FETCH_TIMEOUT_MS).toBe(5000);
    expect(CIMD_MAX_BYTES).toBe(5120);
    expect(CIMD_APPROVAL_TTL_MS).toBe(30_000);
  });

  it('non-production without redis skips budgets but still approves', async () => {
    expect(await withCimdEnv({ nodeEnv: 'development', redis: null }, () => cimdAllowFetch({}, ID))).toBe(true);
  });
});

describe('validateCimdMetadata', () => {
  const ok = { client_id: ID, client_name: 'Example', redirect_uris: ['http://127.0.0.1:3000/cb'], token_endpoint_auth_method: 'none' };

  it('requires client_name, public auth, policy-valid redirect_uris, no DCR-rejected fields', () => {
    expect(validateCimdMetadata(ID, ok).ok).toBe(true);
    for (const patch of [{ client_name: undefined }, { client_name: 'x'.repeat(129) }, { client_name: '' }, { token_endpoint_auth_method: 'private_key_jwt' },
      { redirect_uris: ['http://10.0.0.5/cb'] }, { redirect_uris: [] }, { sector_identifier_uri: 'https://evil.example.net/s' },
      { jwks_uri: 'https://evil.example.net/j' }, { jwks: { keys: [] } }, { software_statement: 'x' }, { request_uris: ['https://evil.example.net/r'] },
      { client_id: 'https://other.example.com/m.json' }, { grant_types: ['client_credentials'] }, { response_types: ['token'] },
      { scope: 'mcp:read admin' }]) {
      expect(validateCimdMetadata(ID, { ...ok, ...patch }).ok, JSON.stringify(patch)).toBe(false);
    }
  });

  it('accepts an omitted auth method (clientDefaults make it public) and the DCR grant/response/scope sets', () => {
    const { token_endpoint_auth_method: _t, ...noAuth } = ok;
    expect(validateCimdMetadata(ID, noAuth).ok).toBe(true);
    expect(validateCimdMetadata(ID, { ...ok, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'openid mcp:read' }).ok).toBe(true);
  });
});

describe('createOidcProviderFetch', () => {
  let spy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    spy = vi.fn(async () => new Response('{}', { status: 200 }));
  });

  async function approve(url = ID) {
    expect(await withCimdEnv({}, () => cimdAllowFetch({}, url))).toBe(true);
  }

  it('provider fetch refuses any URL allowFetch did not approve', async () => {
    const f = createOidcProviderFetch({ fetchImpl: spy as any });
    await expect(f('https://evil.example.net/sector')).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it('an approval is single-use and expires after 30 s', async () => {
    let now = 1_000_000;
    const f = createOidcProviderFetch({ fetchImpl: spy as any, now: () => now });
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await approve();
      await f(ID, { method: 'GET' });
      expect(spy).toHaveBeenCalledTimes(1);
      await expect(f(ID, { method: 'GET' })).rejects.toThrow();
      expect(spy).toHaveBeenCalledTimes(1);
      await approve();
      now += 30_001;
      await expect(f(ID, { method: 'GET' })).rejects.toThrow();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('passes a hard deadline signal and maxBytes 5120 to safeFetch', async () => {
    vi.useFakeTimers();
    try {
      await approve();
      let release!: () => void;
      const hanging = vi.fn((_u: string, i: { signal: AbortSignal }) => new Promise<Response>((resolve, reject) => {
        release = () => resolve(new Response('{}'));
        i.signal.addEventListener('abort', () => reject(i.signal.reason));
      }));
      spy = hanging as any;
      const f = createOidcProviderFetch({ fetchImpl: spy as any });
      const pending = f(ID, { method: 'GET', headers: { accept: 'application/json' } });
      pending.catch(() => undefined);
      await Promise.resolve();
      const [url, init] = spy.mock.calls[0]! as [string, Record<string, any>];
      expect(url).toBe(ID);
      expect(init.maxBytes).toBe(5120);
      expect(init).not.toHaveProperty('dispatcher');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.signal.aborted).toBe(false);
      vi.advanceTimersByTime(5000);
      expect(init.signal.aborted).toBe(true);
      await expect(pending).rejects.toThrow(/deadline/);
      void release;
    } finally {
      vi.useRealTimers();
    }
  });

  it('honours the library signal too', async () => {
    await approve();
    const f = createOidcProviderFetch({ fetchImpl: spy as any });
    const controller = new AbortController();
    await f(ID, { method: 'GET', signal: controller.signal });
    const init = spy.mock.calls[0]![1] as { signal: AbortSignal };
    controller.abort();
    expect(init.signal.aborted).toBe(true);
  });

  it('bounds the approval map', async () => {
    for (let i = 0; i < 1005; i++) {
      await withCimdEnv({}, () => cimdAllowFetch({}, `https://client.example.com/m/${i}.json`));
    }
    expect(__cimdApprovalsForTests().size).toBe(1000);
    expect(__cimdApprovalsForTests().has('https://client.example.com/m/0.json')).toBe(false);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('review fixes (B-W03 PR B)', () => {
  it('a materialised client still refetches when the new-client budget is spent', async () => {
    state.knownClient = true;
    expect(await withCimdEnv({ globalBudgetLeft: 0 }, () => cimdAllowFetch({}, ID))).toBe(true);
    expect(state.rateKeys).toEqual(['oauth:cimd:fetch:host:client.example.com', 'oauth:cimd:fetch:known']);
  });

  it('an unknown client is still held to the new-client budget', async () => {
    state.knownClient = false;
    expect(await withCimdEnv({ globalBudgetLeft: 0 }, () => cimdAllowFetch({}, ID))).toBe(false);
  });

  it('a failed known-client lookup falls back to the new-client budget', async () => {
    state.knownClientThrows = true;
    expect(await withCimdEnv({ globalBudgetLeft: 0 }, () => cimdAllowFetch({}, ID))).toBe(false);
  });

  it('the SSRF guard refuses a loopback hostname that is not an IP literal', async () => {
    expect(isCimdClientId('https://localhost/oauth/m.json')).toBe(true);
    expect(await withCimdEnv({}, () => cimdAllowFetch({}, 'https://localhost/oauth/m.json'))).toBe(false);
    expect(state.warns.map((w) => w.context?.reason)).toContain('ssrf_guard');
    expect(state.rateKeys).toEqual([]);
  });

  it('a rate-limiter error is logged as budget_check_failed with the error, not as an exhausted budget', async () => {
    expect(await withCimdEnv({}, async () => {
      state.rateLimiterThrows = true;
      return cimdAllowFetch({}, ID);
    })).toBe(false);
    const warn = state.warns.find((w) => w.context?.reason === 'budget_check_failed');
    expect(warn).toBeDefined();
    expect(warn!.err).toBeInstanceOf(Error);
  });

  it('two concurrent first uses of one client id each get an approval', async () => {
    await withCimdEnv({}, () => cimdAllowFetch({}, ID));
    await withCimdEnv({}, () => cimdAllowFetch({}, ID));
    const spy = vi.fn(async () => new Response('{}'));
    const f = createOidcProviderFetch({ fetchImpl: spy as any });
    await f(ID, { method: 'GET' });
    await f(ID, { method: 'GET' });
    expect(spy).toHaveBeenCalledTimes(2);
    await expect(f(ID, { method: 'GET' })).rejects.toThrow();
  });

  it('a failed document fetch is logged with its host and error, then rethrown', async () => {
    await withCimdEnv({}, () => cimdAllowFetch({}, ID));
    const f = createOidcProviderFetch({ fetchImpl: (async () => { throw new Error('ResponseTooLargeError'); }) as any });
    await expect(f(ID, { method: 'GET' })).rejects.toThrow('ResponseTooLargeError');
    const warn = state.warns.find((w) => w.context?.reason === 'fetch_failed');
    expect(warn).toMatchObject({ context: { host: 'client.example.com' } });
    expect(warn!.err).toBeInstanceOf(Error);
  });

  it('an unapproved provider fetch is logged', async () => {
    const f = createOidcProviderFetch({ fetchImpl: vi.fn() as any });
    await expect(f('https://evil.example.net/jwks')).rejects.toThrow();
    expect(state.warns.find((w) => w.context?.reason === 'fetch_not_approved')).toMatchObject({ context: { host: 'evil.example.net' } });
  });

  it('repeated refusals for one host and reason log once per window', async () => {
    await withCimdEnv({ enabled: false }, async () => {
      await cimdAllowFetch({}, ID);
      await cimdAllowFetch({}, ID);
      await cimdAllowFetch({}, ID);
    });
    expect(state.warns.filter((w) => w.context?.reason === 'disabled')).toHaveLength(1);
  });
});

