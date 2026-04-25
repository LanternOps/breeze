import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// We mock the DB module so the helper never actually reaches Postgres.
const selectRows: Array<{ settings: unknown } | undefined> = [];
let selectCallCount = 0;

vi.mock('../db', () => {
  // A minimal fluent-builder chain that matches the `.select().from().where().limit()`
  // shape used by fetchPolicyFromDb.
  const limit = vi.fn(async () => {
    selectCallCount += 1;
    const row = selectRows.shift();
    return row ? [row] : [];
  });
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return {
    db: { select },
    withSystemDbAccessContext: <T>(fn: () => Promise<T>): Promise<T> => fn(),
    runOutsideDbContext: <T>(fn: () => T): T => fn(),
  };
});

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

  it('fails open to {} when the DB lookup throws', async () => {
    const { db } = await import('../db');
    const spy = vi.spyOn(db, 'select').mockImplementationOnce(() => {
      throw new Error('db down');
    });
    await expect(getPartnerScopePolicy('p1')).resolves.toEqual({});
    spy.mockRestore();
  });
});
