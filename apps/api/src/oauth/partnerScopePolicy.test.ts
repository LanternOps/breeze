import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// We mock the DB module so the helper never actually reaches Postgres.
const selectRows: Array<{ settings: unknown } | undefined> = [];
let selectCallCount = 0;
// When set, a DB read takes its row, then waits here (holds a load open).
let readGate: Promise<void> | null = null;

vi.mock('../db', () => {
  // A minimal fluent-builder chain that matches the `.select().from().where().limit()`
  // shape used by fetchPolicyFromDb.
  const limit = vi.fn(async () => {
    selectCallCount += 1;
    const row = selectRows.shift();
    if (readGate) await readGate;
    return row ? [row] : [];
  });
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return {
    db: { select },
    withSystemDbAccessContext: <T>(fn: () => Promise<T>): Promise<T> => fn(),
    runOutsideDbContext: <T>(fn: () => T): T => fn(),
    // #8636 — the clear goes through the cluster invalidator.
    runAfterDbContextExit: (_label: string, work: () => unknown) => { work(); },
    runAfterDbContextCommit: (_label: string, work: () => unknown) => { work(); },
  };
});

import { ClusterCacheBus, __setClusterCacheBusForTests } from '../services/clusterCacheBus';
import { getClusterCacheTarget } from '../services/clusterCacheRegistry';
import {
  _policyCacheForTests,
  clearPartnerScopePolicyCache,
  getPartnerScopePolicy,
  OAUTH_SCOPE_POLICY_SETTINGS_KEY,
} from './partnerScopePolicy';

beforeEach(() => {
  selectRows.length = 0;
  selectCallCount = 0;
  clearPartnerScopePolicyCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getPartnerScopePolicy', () => {
  it('returns {} when the partner has no policy key at all', async () => {
    selectRows.push({ settings: { some_other_key: 'foo' } });
    await expect(getPartnerScopePolicy('p1')).resolves.toEqual({});
  });

  it('returns {} when the partner row is missing', async () => {
    selectRows.push(undefined);
    await expect(getPartnerScopePolicy('p1')).resolves.toEqual({});
  });

  it('returns the mcp_allowed_scopes array when set', async () => {
    selectRows.push({
      settings: {
        [OAUTH_SCOPE_POLICY_SETTINGS_KEY]: { mcp_allowed_scopes: ['mcp:read'] },
      },
    });
    await expect(getPartnerScopePolicy('p1')).resolves.toEqual({
      mcp_allowed_scopes: ['mcp:read'],
    });
  });

  it('filters out non-string entries defensively', async () => {
    selectRows.push({
      settings: {
        [OAUTH_SCOPE_POLICY_SETTINGS_KEY]: {
          mcp_allowed_scopes: ['mcp:read', 42, '', null, 'mcp:write'],
        },
      },
    });
    await expect(getPartnerScopePolicy('p1')).resolves.toEqual({
      mcp_allowed_scopes: ['mcp:read', 'mcp:write'],
    });
  });

  it('caches hits for subsequent calls within the TTL', async () => {
    selectRows.push({
      settings: {
        [OAUTH_SCOPE_POLICY_SETTINGS_KEY]: { mcp_allowed_scopes: ['mcp:read'] },
      },
    });

    const a = await getPartnerScopePolicy('p1');
    const b = await getPartnerScopePolicy('p1');
    expect(a).toEqual({ mcp_allowed_scopes: ['mcp:read'] });
    expect(b).toEqual({ mcp_allowed_scopes: ['mcp:read'] });
    expect(selectCallCount).toBe(1); // second call was a cache hit
  });

  it('re-fetches after clearPartnerScopePolicyCache(partnerId)', async () => {
    selectRows.push(
      { settings: { [OAUTH_SCOPE_POLICY_SETTINGS_KEY]: { mcp_allowed_scopes: ['mcp:read'] } } },
      { settings: { [OAUTH_SCOPE_POLICY_SETTINGS_KEY]: { mcp_allowed_scopes: ['mcp:read', 'mcp:write'] } } },
    );

    await getPartnerScopePolicy('p1');
    clearPartnerScopePolicyCache('p1');
    const after = await getPartnerScopePolicy('p1');

    expect(after).toEqual({ mcp_allowed_scopes: ['mcp:read', 'mcp:write'] });
    expect(selectCallCount).toBe(2);
  });

  it('re-fetches after global clearPartnerScopePolicyCache()', async () => {
    selectRows.push(
      { settings: { [OAUTH_SCOPE_POLICY_SETTINGS_KEY]: {} } },
      { settings: { [OAUTH_SCOPE_POLICY_SETTINGS_KEY]: { mcp_allowed_scopes: ['mcp:execute'] } } },
    );
    await getPartnerScopePolicy('p1');
    clearPartnerScopePolicyCache();
    expect(_policyCacheForTests.size).toBe(0);
    const after = await getPartnerScopePolicy('p1');
    expect(after).toEqual({ mcp_allowed_scopes: ['mcp:execute'] });
  });

  it('fails CLOSED to an empty whitelist when the DB lookup throws (deny all MCP scopes)', async () => {
    // A DB error must NOT mint over-broad tokens. {} would be treated as
    // "no cap -> all scopes" (the old fail-open bug); { mcp_allowed_scopes: [] }
    // makes computeEffectiveMcpScopes (effectiveScopes.ts) strip every scope
    // (requested ∩ [] = []).
    const { db } = await import('../db');
    const spy = vi.spyOn(db, 'select').mockImplementationOnce(() => {
      throw new Error('db down');
    });
    await expect(getPartnerScopePolicy('p1')).resolves.toEqual({ mcp_allowed_scopes: [] });
    spy.mockRestore();
  });

  it('does NOT cache the fail-closed result — recovers to the real policy on the next call', async () => {
    const { db } = await import('../db');
    const spy = vi.spyOn(db, 'select').mockImplementationOnce(() => {
      throw new Error('db down');
    });
    // First call hits the DB error -> fails closed (and must not be cached).
    await expect(getPartnerScopePolicy('p1')).resolves.toEqual({ mcp_allowed_scopes: [] });
    spy.mockRestore();
    // DB recovers; because the error path is not cached, the next call re-fetches.
    selectRows.push({
      settings: {
        [OAUTH_SCOPE_POLICY_SETTINGS_KEY]: { mcp_allowed_scopes: ['mcp:read'] },
      },
    });
    await expect(getPartnerScopePolicy('p1')).resolves.toEqual({ mcp_allowed_scopes: ['mcp:read'] });
  });
});

describe('cluster cache binding (#8636)', () => {
  const NAME = 'partner-oauth-scope-policy';
  const policy = (...scopes: string[]) => ({
    settings: { [OAUTH_SCOPE_POLICY_SETTINGS_KEY]: { mcp_allowed_scopes: scopes } },
  });
  let published: Array<[string, string | null]>;

  beforeEach(() => {
    published = [];
    readGate = null;
    const bus = new ClusterCacheBus({ origin: 'unit', getPublisher: () => null, createSubscriber: () => null });
    vi.spyOn(bus, 'publish').mockImplementation(async (cache: string, key: string | null) => {
      published.push([cache, key]);
      return 'published';
    });
    __setClusterCacheBusForTests(bus);
  });
  afterEach(() => {
    readGate = null;
    __setClusterCacheBusForTests(null);
  });

  it('a remote drop for one partner makes the next read go back to the DB', async () => {
    selectRows.push(policy('mcp:read'), policy('mcp:read', 'mcp:write'));
    await getPartnerScopePolicy('p1');
    await getPartnerScopePolicy('p1');
    expect(selectCallCount).toBe(1);

    getClusterCacheTarget(NAME)!.invalidate('p1');

    await expect(getPartnerScopePolicy('p1')).resolves.toEqual({ mcp_allowed_scopes: ['mcp:read', 'mcp:write'] });
    expect(selectCallCount).toBe(2);
  });

  it('a remote drop with no key clears every partner', async () => {
    selectRows.push(policy('mcp:read'), policy('mcp:read'), policy('mcp:write'), policy('mcp:write'));
    await getPartnerScopePolicy('p1');
    await getPartnerScopePolicy('p2');
    getClusterCacheTarget(NAME)!.invalidate();
    await getPartnerScopePolicy('p1');
    await getPartnerScopePolicy('p2');
    expect(selectCallCount).toBe(4);
  });

  it('the writer call publishes [name, partnerId] and the global clear publishes [name, null]', () => {
    clearPartnerScopePolicyCache('p1');
    expect(published).toEqual([[NAME, 'p1']]);
    published.length = 0;
    clearPartnerScopePolicyCache();
    expect(published).toEqual([[NAME, null]]);
  });

  it('a load in flight when a remote drop lands answers its caller but is not cached', async () => {
    let release!: () => void;
    readGate = new Promise<void>((resolve) => { release = resolve; });
    selectRows.push(policy('mcp:read'));
    const inFlight = getPartnerScopePolicy('p1');

    getClusterCacheTarget(NAME)!.invalidate('p1');
    release();
    readGate = null;
    await expect(inFlight).resolves.toEqual({ mcp_allowed_scopes: ['mcp:read'] });
    expect(_policyCacheForTests.has('p1')).toBe(false);

    selectRows.push(policy('mcp:write'));
    await expect(getPartnerScopePolicy('p1')).resolves.toEqual({ mcp_allowed_scopes: ['mcp:write'] });
    expect(selectCallCount).toBe(2);
  });

  it('a caller after the drop starts a fresh read instead of joining the stale flight, and the old flight does not evict the new one', async () => {
    let releaseOld!: () => void;
    readGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    selectRows.push(policy('mcp:read'));
    const stale = getPartnerScopePolicy('p1');

    getClusterCacheTarget(NAME)!.invalidate('p1');
    let releaseNew!: () => void;
    readGate = new Promise<void>((resolve) => { releaseNew = resolve; });
    selectRows.push(policy('mcp:write'));
    const fresh = getPartnerScopePolicy('p1');
    const joined = getPartnerScopePolicy('p1'); // joins the NEW flight
    expect(selectCallCount).toBe(2);

    // The old flight settles first; its cleanup must not drop the new flight.
    releaseOld();
    await expect(stale).resolves.toEqual({ mcp_allowed_scopes: ['mcp:read'] });
    const third = getPartnerScopePolicy('p1');
    expect(selectCallCount).toBe(2);

    releaseNew();
    readGate = null;
    await expect(fresh).resolves.toEqual({ mcp_allowed_scopes: ['mcp:write'] });
    await expect(joined).resolves.toEqual({ mcp_allowed_scopes: ['mcp:write'] });
    await expect(third).resolves.toEqual({ mcp_allowed_scopes: ['mcp:write'] });
    expect(_policyCacheForTests.get('p1')?.value).toEqual({ mcp_allowed_scopes: ['mcp:write'] });
  });

  it('a read that fails while a drop lands still fails closed and is not cached', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = await import('../db');
    const limitFn = (db.select() as unknown as { from: () => { where: () => { limit: ReturnType<typeof vi.fn> } } })
      .from().where().limit;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    limitFn.mockImplementationOnce(async () => {
      selectCallCount += 1;
      await gate;
      throw new Error('db down');
    });
    const inFlight = getPartnerScopePolicy('p1');
    getClusterCacheTarget(NAME)!.invalidate('p1');
    release();
    await expect(inFlight).resolves.toEqual({ mcp_allowed_scopes: [] });
    expect(_policyCacheForTests.has('p1')).toBe(false);
    selectRows.push(policy('mcp:read'));
    await expect(getPartnerScopePolicy('p1')).resolves.toEqual({ mcp_allowed_scopes: ['mcp:read'] });
    error.mockRestore();
  });
});
