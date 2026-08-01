import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const selectMock = vi.fn();

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: { orgId: 'org_id', status: 'status' },
}));

import {
  AGENT_RESERVED_INGEST_ENDPOINTS,
  DEFAULT_AGENT_ORG_RATE_LIMIT,
  DEFAULT_AGENT_ORG_RATE_LIMIT_MAX,
  DEFAULT_AGENT_ORG_RATE_LIMIT_PER_DEVICE,
  RESERVED_INGEST_FRACTION,
  computeOrgRateLimit,
  computeReservedIngestLimit,
  getCachedOrgDeviceCount,
  invalidateOrgDeviceCount,
  isReservedIngestPath,
  resolveOrgRateLimit,
} from './agentOrgRateLimit';

/** Minimal Redis stub — only the three commands this service uses. */
function makeRedis(overrides: Partial<Record<'get' | 'set' | 'del', unknown>> = {}) {
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
    ...overrides,
  } as never;
}

function mockDeviceCount(value: number) {
  selectMock.mockReturnValue({
    from: () => ({
      where: async () => [{ value }],
    }),
  });
}

function mockDeviceCountThrows(err: Error) {
  selectMock.mockReturnValue({
    from: () => ({
      where: async () => {
        throw err;
      },
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('computeOrgRateLimit', () => {
  it('floors small orgs at the historical default so their behavior is unchanged', () => {
    // 10 devices * 12 = 120, well under the 600 floor.
    expect(computeOrgRateLimit(10)).toBe(DEFAULT_AGENT_ORG_RATE_LIMIT);
    expect(computeOrgRateLimit(1)).toBe(DEFAULT_AGENT_ORG_RATE_LIMIT);
    expect(computeOrgRateLimit(0)).toBe(DEFAULT_AGENT_ORG_RATE_LIMIT);
  });

  it('scales linearly with device count past the floor', () => {
    // The regression this fixes: a 300-device org used to share the same 600
    // budget as a 5-device org.
    expect(computeOrgRateLimit(300)).toBe(300 * DEFAULT_AGENT_ORG_RATE_LIMIT_PER_DEVICE);
    expect(computeOrgRateLimit(1000)).toBe(1000 * DEFAULT_AGENT_ORG_RATE_LIMIT_PER_DEVICE);
  });

  it('caps at the platform ceiling so the tenant guardrail survives', () => {
    expect(computeOrgRateLimit(1_000_000)).toBe(DEFAULT_AGENT_ORG_RATE_LIMIT_MAX);
  });

  it.each([
    ['negative', -5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('treats a %s device count as zero and falls back to the floor', (_label, value) => {
    const got = computeOrgRateLimit(value as number);
    expect(got).toBeGreaterThanOrEqual(DEFAULT_AGENT_ORG_RATE_LIMIT);
    expect(got).toBeLessThanOrEqual(DEFAULT_AGENT_ORG_RATE_LIMIT_MAX);
  });

  it('honors AGENT_ORG_RATE_LIMIT_PER_MIN as the floor (back-compat)', () => {
    vi.stubEnv('AGENT_ORG_RATE_LIMIT_PER_MIN', '900');
    expect(computeOrgRateLimit(5)).toBe(900);
    // A large fleet still scales above the configured floor.
    expect(computeOrgRateLimit(500)).toBe(500 * DEFAULT_AGENT_ORG_RATE_LIMIT_PER_DEVICE);
  });

  it('honors AGENT_ORG_RATE_LIMIT_PER_DEVICE', () => {
    vi.stubEnv('AGENT_ORG_RATE_LIMIT_PER_DEVICE', '50');
    expect(computeOrgRateLimit(100)).toBe(5000);
  });

  it('honors AGENT_ORG_RATE_LIMIT_MAX', () => {
    vi.stubEnv('AGENT_ORG_RATE_LIMIT_MAX', '1000');
    expect(computeOrgRateLimit(10_000)).toBe(1000);
  });

  it('never returns below the floor even if the ceiling is misconfigured lower', () => {
    vi.stubEnv('AGENT_ORG_RATE_LIMIT_MAX', '10');
    expect(computeOrgRateLimit(500)).toBe(DEFAULT_AGENT_ORG_RATE_LIMIT);
  });
});

describe('computeReservedIngestLimit', () => {
  it('reserves a fraction of the org ceiling', () => {
    expect(computeReservedIngestLimit(600)).toBe(600 * RESERVED_INGEST_FRACTION);
    expect(computeReservedIngestLimit(1000)).toBe(200);
  });

  it('always reserves at least one slot', () => {
    expect(computeReservedIngestLimit(1)).toBe(1);
    expect(computeReservedIngestLimit(0)).toBe(1);
  });
});

describe('isReservedIngestPath', () => {
  // Derived from the declared endpoint list rather than restating the regex,
  // so the two can't drift.
  it.each(AGENT_RESERVED_INGEST_ENDPOINTS)(
    'treats the declared endpoint %s as reserved',
    (endpoint) => {
      expect(isReservedIngestPath(`/api/v1/agents/abc/${endpoint}`)).toBe(true);
      // Hono paths may carry a trailing slash.
      expect(isReservedIngestPath(`/api/v1/agents/abc/${endpoint}/`)).toBe(true);
    },
  );

  it.each([
    '/api/v1/agents/abc/heartbeat',
    '/api/v1/agents/abc/process-sample',
    '/api/v1/agents/abc/logs',
    '/api/v1/agents/abc/commands',
    '/api/v1/agents/abc/sessions',
    '/api/v1/agents/abc/security/status',
    '/api/v1/agents/abc/patches/pending/extra',
    '/api/v1/agents/abc/patchesomething',
  ])('does not reserve %s', (path) => {
    expect(isReservedIngestPath(path)).toBe(false);
  });

  // The reserved set is only meaningful if it matches endpoints the agent
  // actually calls. An earlier revision listed `inventory`, which is not a
  // route at all, while omitting `disks`, `network` and `changes` — real
  // inventory uploads that were therefore still being dropped. This pins the
  // set against the agent's real `sendInventoryData` endpoints.
  it('covers the durable-inventory endpoints the agent actually uploads to', () => {
    const agentDurableIngestEndpoints = [
      'patches/pending',
      'patches/installed',
      'hardware',
      'software',
      'disks',
      'network',
      'changes',
      'connections',
      'eventlogs',
      'management/posture',
    ];
    for (const endpoint of agentDurableIngestEndpoints) {
      expect(
        isReservedIngestPath(`/api/v1/agents/abc/${endpoint}`),
        `${endpoint} should be in the reserved ingest lane`,
      ).toBe(true);
    }
  });

  it('does not declare endpoints that are not real agent routes', () => {
    // `inventory` was declared once and does not exist; guard against it and
    // any other invented endpoint creeping back in.
    expect(AGENT_RESERVED_INGEST_ENDPOINTS).not.toContain('inventory');
  });
});

describe('getCachedOrgDeviceCount', () => {
  it('returns the cached value without touching the database', async () => {
    const redis = makeRedis({ get: vi.fn(async () => '42') });
    const got = await getCachedOrgDeviceCount(redis, 'org-1');
    expect(got).toBe(42);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('queries and caches on a cache miss', async () => {
    const redis = makeRedis();
    mockDeviceCount(7);

    const got = await getCachedOrgDeviceCount(redis, 'org-1');

    expect(got).toBe(7);
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect((redis as unknown as { set: ReturnType<typeof vi.fn> }).set).toHaveBeenCalledWith(
      'agent_org_devcount:org-1',
      '7',
      'EX',
      300,
    );
  });

  it('falls through to the database when the cache read throws', async () => {
    const redis = makeRedis({
      get: vi.fn(async () => {
        throw new Error('redis down');
      }),
    });
    mockDeviceCount(9);

    await expect(getCachedOrgDeviceCount(redis, 'org-1')).resolves.toBe(9);
  });

  it('still returns a count when the cache write throws', async () => {
    const redis = makeRedis({
      set: vi.fn(async () => {
        throw new Error('redis down');
      }),
    });
    mockDeviceCount(11);

    await expect(getCachedOrgDeviceCount(redis, 'org-1')).resolves.toBe(11);
  });

  it('queries directly when there is no redis at all', async () => {
    mockDeviceCount(3);
    await expect(getCachedOrgDeviceCount(null, 'org-1')).resolves.toBe(3);
  });

  it('ignores a malformed cached value and re-queries', async () => {
    const redis = makeRedis({ get: vi.fn(async () => 'not-a-number') });
    mockDeviceCount(5);
    await expect(getCachedOrgDeviceCount(redis, 'org-1')).resolves.toBe(5);
  });

  it('returns null when the count query fails', async () => {
    const redis = makeRedis();
    mockDeviceCountThrows(new Error('db down'));
    await expect(getCachedOrgDeviceCount(redis, 'org-1')).resolves.toBeNull();
  });
});

describe('resolveOrgRateLimit', () => {
  it('sizes the ceiling from the device count', async () => {
    const redis = makeRedis({ get: vi.fn(async () => '300') });
    await expect(resolveOrgRateLimit(redis, 'org-1')).resolves.toBe(
      300 * DEFAULT_AGENT_ORG_RATE_LIMIT_PER_DEVICE,
    );
  });

  it('falls back to the floor — not a generous ceiling — when the count is unavailable', async () => {
    // An unavailable database must not be a reason to widen a tenant guardrail.
    const redis = makeRedis();
    mockDeviceCountThrows(new Error('db down'));
    await expect(resolveOrgRateLimit(redis, 'org-1')).resolves.toBe(DEFAULT_AGENT_ORG_RATE_LIMIT);
  });

  it('falls back to the configured floor override when the count is unavailable', async () => {
    vi.stubEnv('AGENT_ORG_RATE_LIMIT_PER_MIN', '1500');
    const redis = makeRedis();
    mockDeviceCountThrows(new Error('db down'));
    await expect(resolveOrgRateLimit(redis, 'org-1')).resolves.toBe(1500);
  });
});

describe('invalidateOrgDeviceCount', () => {
  it('deletes the cache key', async () => {
    const redis = makeRedis();
    await invalidateOrgDeviceCount(redis, 'org-1');
    expect((redis as unknown as { del: ReturnType<typeof vi.fn> }).del).toHaveBeenCalledWith(
      'agent_org_devcount:org-1',
    );
  });

  it('is a no-op without redis', async () => {
    await expect(invalidateOrgDeviceCount(null, 'org-1')).resolves.toBeUndefined();
  });

  it('swallows redis errors — invalidation is best-effort behind the TTL', async () => {
    const redis = makeRedis({
      del: vi.fn(async () => {
        throw new Error('redis down');
      }),
    });
    await expect(invalidateOrgDeviceCount(redis, 'org-1')).resolves.toBeUndefined();
  });
});
