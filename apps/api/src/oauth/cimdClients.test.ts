import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  rows: new Map<string, { id: string; metadata: unknown; disabledAt: Date | null }>(),
  inserts: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  redis: {} as object | null,
  createBudgetLeft: Infinity,
  rateKeys: [] as string[],
  selectThrows: false,
  warns: [] as Array<{ context?: Record<string, unknown>; err?: unknown }>,
}));

vi.mock('./log', async (importOriginal) => ({
  ...await importOriginal<typeof import('./log')>(),
  logOauthWarn: (args: { context?: Record<string, unknown>; err?: unknown }) => { state.warns.push(args); },
}));

vi.mock('../db', () => {
  const select = vi.fn(() => ({
    from: () => ({
      where: async (cond: { __id: string }) => {
        if (state.selectThrows) throw new Error('db down');
        const row = state.rows.get(cond.__id);
        return row ? [row] : [];
      },
    }),
  }));
  const insert = vi.fn(() => ({
    values: (v: Record<string, unknown>) => ({
      onConflictDoNothing: async () => {
        state.inserts.push(v);
        if (!state.rows.has(v.id as string)) {
          state.rows.set(v.id as string, { id: v.id as string, metadata: v.metadata, disabledAt: null });
        }
      },
    }),
  }));
  const update = vi.fn(() => ({
    set: (v: Record<string, unknown>) => ({
      where: async (cond: { __id: string }) => {
        state.updates.push({ ...v, id: cond.__id });
        const row = state.rows.get(cond.__id);
        if (row && !row.disabledAt) row.metadata = v.metadata;
      },
    }),
  }));
  return {
    db: { select, insert, update },
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
  };
});

// Drizzle helpers reduced to something the fake db above can read.
vi.mock('drizzle-orm', async (importOriginal) => ({
  ...await importOriginal<typeof import('drizzle-orm')>(),
  eq: (_col: unknown, value: string) => ({ __id: value }),
  and: (first: { __id: string }) => first,
  isNull: () => ({}),
}));

vi.mock('../services/redis', () => ({ getRedis: () => state.redis }));
vi.mock('../services/rate-limit', () => ({
  rateLimiter: vi.fn(async (_r: unknown, key: string) => {
    state.rateKeys.push(key);
    return { allowed: state.createBudgetLeft > 0, remaining: 0, resetAt: new Date() };
  }),
}));

import { __resetCimdMaterializeThrottleForTests, cimdAllowClient, materializeCimdClient } from './cimdClients';
import { __resetCimdRefusalLogForTests } from './cimdPolicy';

const ID = 'https://client.example.com/oauth/metadata.json';
const META = { client_id: ID, client_name: 'Example', redirect_uris: ['http://127.0.0.1:3000/cb'], token_endpoint_auth_method: 'none' };

function client(metadata: Record<string, unknown> = META, clientId = ID) {
  return { clientId, metadata: () => metadata };
}

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  process.env.OAUTH_CIMD_ENABLED = 'true';
  delete process.env.OAUTH_CIMD_ALLOWED_HOSTS;
  state.rows.clear();
  state.inserts = [];
  state.updates = [];
  state.redis = {};
  state.createBudgetLeft = Infinity;
  state.rateKeys = [];
  state.selectThrows = false;
  __resetCimdMaterializeThrottleForTests();
  __resetCimdRefusalLogForTests();
  state.warns = [];
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
});

afterEach(() => {
  process.env = savedEnv;
  vi.useRealTimers();
});

describe('materializeCimdClient', () => {
  it('creates once, is unchanged on the same metadata, updates on a metadata hash change after 60 s', async () => {
    expect(await materializeCimdClient(ID, META)).toBe('created');
    expect(state.inserts).toEqual([{ id: ID, partnerId: null, clientSecretHash: null, metadata: META }]);
    expect(state.rateKeys).toEqual(['oauth:cimd:create:global']);

    // Same document, keys in a different order → still unchanged, no write.
    const reordered = { token_endpoint_auth_method: 'none', redirect_uris: ['http://127.0.0.1:3000/cb'], client_name: 'Example', client_id: ID };
    expect(await materializeCimdClient(ID, reordered)).toBe('unchanged');

    const changed = { ...META, client_name: 'Example v2' };
    expect(await materializeCimdClient(ID, changed)).toBe('unchanged'); // throttled: written < 60 s ago
    expect(state.updates).toEqual([]);

    vi.advanceTimersByTime(60_001);
    expect(await materializeCimdClient(ID, changed)).toBe('updated');
    expect(state.updates).toEqual([{ metadata: changed, id: ID }]);
    expect(await materializeCimdClient(ID, changed)).toBe('unchanged');
    expect(state.inserts).toHaveLength(1);
  });

  it('returns disabled for a disabled row and never rewrites it', async () => {
    state.rows.set(ID, { id: ID, metadata: META, disabledAt: new Date() });
    expect(await materializeCimdClient(ID, { ...META, client_name: 'other' })).toBe('disabled');
    expect(state.updates).toEqual([]);
    expect(state.inserts).toEqual([]);
  });

  it('returns budget_exceeded without writing when the create budget is spent', async () => {
    state.createBudgetLeft = 0;
    expect(await materializeCimdClient(ID, META)).toBe('budget_exceeded');
    expect(state.inserts).toEqual([]);
  });

  it('existing rows need no create budget', async () => {
    state.rows.set(ID, { id: ID, metadata: META, disabledAt: null });
    state.createBudgetLeft = 0;
    expect(await materializeCimdClient(ID, META)).toBe('unchanged');
    expect(state.rateKeys).toEqual([]);
  });

  it('production without redis cannot create', async () => {
    process.env.NODE_ENV = 'production';
    state.redis = null;
    expect(await materializeCimdClient(ID, META)).toBe('budget_exceeded');
    expect(state.inserts).toEqual([]);
  });
});

describe('cimdAllowClient', () => {
  it('admits a valid client and materialises it', async () => {
    expect(await cimdAllowClient({}, client())).toBe(true);
    expect(state.rows.has(ID)).toBe(true);
  });

  it('allowClient re-evaluates disable and host policy on cache hits', async () => {
    expect(await cimdAllowClient({}, client())).toBe(true);

    // Operator disables the client (revokeClientFamilies sets disabled_at).
    state.rows.get(ID)!.disabledAt = new Date();
    expect(await cimdAllowClient({}, client())).toBe(false);

    state.rows.get(ID)!.disabledAt = null;
    expect(await cimdAllowClient({}, client())).toBe(true);

    // Operator narrows the allowlist.
    process.env.OAUTH_CIMD_ALLOWED_HOSTS = '.trusted.example.org';
    expect(await cimdAllowClient({}, client())).toBe(false);

    // Operator turns the feature off.
    delete process.env.OAUTH_CIMD_ALLOWED_HOSTS;
    process.env.OAUTH_CIMD_ENABLED = 'false';
    expect(await cimdAllowClient({}, client())).toBe(false);
  });

  it('refuses invalid metadata before touching the database', async () => {
    expect(await cimdAllowClient({}, client({ ...META, jwks_uri: 'https://evil.example.net/j' }))).toBe(false);
    expect(await cimdAllowClient({}, client({ ...META, client_name: undefined }))).toBe(false);
    expect(state.inserts).toEqual([]);
  });

  it('refuses a non-CIMD client id', async () => {
    expect(await cimdAllowClient({}, client({ ...META, client_id: 'dcr_abc' }, 'dcr_abc'))).toBe(false);
  });

  it('fails closed when the database read throws, and logs the cause', async () => {
    state.selectThrows = true;
    expect(await cimdAllowClient({}, client())).toBe(false);
    const warn = state.warns.find((w) => w.context?.reason === 'materialize_failed');
    expect(warn?.err).toBeInstanceOf(Error);
  });

  it('refuses when the create budget is spent', async () => {
    state.createBudgetLeft = 0;
    expect(await cimdAllowClient({}, client())).toBe(false);
  });
});
