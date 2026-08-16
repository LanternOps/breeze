import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { dbMock, redisMock } = vi.hoisted(() => ({
  dbMock: { select: vi.fn(), execute: vi.fn() },
  redisMock: { current: null as null | { get: ReturnType<typeof vi.fn>; setex: ReturnType<typeof vi.fn> } },
}));

vi.mock('../db', () => ({ db: dbMock }));

vi.mock('../db/schema', () => ({
  wingetPackageIndex: {
    packageId: 'package_id',
    vendorSegment: 'vendor_segment',
    nameSegment: 'name_segment',
    latestVersion: 'latest_version',
  },
}));

vi.mock('./redis', () => ({ getRedis: vi.fn(() => redisMock.current) }));

import {
  searchWingetIndex,
  searchHomebrew,
  annotateBreezeTested,
  escapeLikePattern,
  __resetBrewSingleFlight,
} from './packageSearch';

/** Records the Drizzle select chain and resolves with `rows` at .limit(). */
function selectChain(rows: unknown[]) {
  const calls: Record<string, unknown[]> = {};
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'orderBy']) {
    chain[method] = vi.fn((...args: unknown[]) => {
      calls[method] = args;
      return chain;
    });
  }
  chain.limit = vi.fn((...args: unknown[]) => {
    calls.limit = args;
    return Promise.resolve(rows);
  });
  return { chain, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.current = null;
  __resetBrewSingleFlight();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('escapeLikePattern', () => {
  it('escapes LIKE wildcards so a bare % does not match everything', () => {
    expect(escapeLikePattern('100%')).toBe('100\\%');
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
    expect(escapeLikePattern('c\\d')).toBe('c\\\\d');
    expect(escapeLikePattern('chrome')).toBe('chrome');
  });
});

describe('searchWingetIndex', () => {
  it('maps index rows to the package-search result shape', async () => {
    const { chain, calls } = selectChain([
      { packageId: 'Google.Chrome', vendorSegment: 'Google', nameSegment: 'Chrome', latestVersion: '126.0' },
      { packageId: 'Mozilla.Firefox', vendorSegment: 'Mozilla', nameSegment: 'Firefox', latestVersion: null },
    ]);
    dbMock.select.mockReturnValue(chain);

    const results = await searchWingetIndex('chrom', 25);

    expect(results).toEqual([
      {
        platform: 'windows',
        kind: 'winget',
        packageId: 'Google.Chrome',
        name: 'Chrome',
        vendor: 'Google',
        latestVersion: '126.0',
      },
      {
        platform: 'windows',
        kind: 'winget',
        packageId: 'Mozilla.Firefox',
        name: 'Firefox',
        vendor: 'Mozilla',
      },
    ]);
    // No latestVersion key at all when the column is null (Task 9 treats the
    // field as optional, not nullable).
    expect('latestVersion' in results[1]!).toBe(false);
    expect(calls.limit).toEqual([25]);
    expect(chain.orderBy).toHaveBeenCalled();
    expect(chain.where).toHaveBeenCalled();
  });

  it('defaults to a limit of 25', async () => {
    const { chain, calls } = selectChain([]);
    dbMock.select.mockReturnValue(chain);
    await searchWingetIndex('vs');
    expect(calls.limit).toEqual([25]);
  });
});

// ---------------------------------------------------------------------------
// Homebrew
// ---------------------------------------------------------------------------

const FORMULAE = [
  { name: 'wget', full_name: 'wget', token: undefined, desc: 'Internet file retriever', homepage: 'https://gnu.org/wget', versions: { stable: '1.24.5' } },
  { name: 'jq', full_name: 'jq', desc: 'Lightweight JSON processor', homepage: 'https://jqlang.org', versions: { stable: '1.7.1' } },
];

const CASKS = [
  { token: 'google-chrome', name: ['Google Chrome'], desc: 'Web browser', homepage: 'https://google.com/chrome', version: '126.0' },
  { token: 'slack', name: ['Slack'], desc: 'Team messaging', homepage: 'https://slack.com', version: '4.38' },
];

function stubBrewFetch(opts: { formulaFails?: boolean; caskFails?: boolean } = {}) {
  const fetchMock = vi.fn(async (url: string) => {
    const isCask = url.includes('cask.json');
    if ((isCask && opts.caskFails) || (!isCask && opts.formulaFails)) {
      return { ok: false, status: 503, text: async () => 'down' } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(isCask ? CASKS : FORMULAE),
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('searchHomebrew', () => {
  it('filters both indexes case-insensitively and maps casks vs formulae', async () => {
    stubBrewFetch();
    const { results, degraded } = await searchHomebrew('CHROME');

    expect(degraded).toBe(false);
    expect(results).toEqual([
      {
        platform: 'macos',
        kind: 'homebrew_cask',
        packageId: 'google-chrome',
        name: 'Google Chrome',
        vendor: '',
        latestVersion: '126.0',
        description: 'Web browser',
        homepageUrl: 'https://google.com/chrome',
      },
    ]);
  });

  it('matches on description as well as token/name', async () => {
    stubBrewFetch();
    const { results } = await searchHomebrew('json');
    expect(results.map((r) => r.packageId)).toEqual(['jq']);
    expect(results[0]!.kind).toBe('homebrew_formula');
    expect(results[0]!.latestVersion).toBe('1.7.1');
  });

  it('honours the limit', async () => {
    stubBrewFetch();
    const { results } = await searchHomebrew('e', 1);
    expect(results).toHaveLength(1);
  });

  it('returns degraded only when BOTH indexes are unavailable', async () => {
    stubBrewFetch({ formulaFails: true, caskFails: true });
    const both = await searchHomebrew('chrome');
    expect(both).toEqual({ results: [], degraded: true });

    __resetBrewSingleFlight();
    stubBrewFetch({ formulaFails: true });
    const partial = await searchHomebrew('chrome');
    expect(partial.degraded).toBe(false);
    expect(partial.results.map((r) => r.packageId)).toEqual(['google-chrome']);
  });

  it('serves from the Redis cache without fetching upstream', async () => {
    const get = vi.fn(async (key: string) =>
      JSON.stringify(key.endsWith('cask') ? CASKS : FORMULAE),
    );
    const setex = vi.fn();
    redisMock.current = { get, setex };
    const fetchMock = stubBrewFetch();

    const { results } = await searchHomebrew('slack');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(setex).not.toHaveBeenCalled();
    expect(results.map((r) => r.packageId)).toEqual(['slack']);
    expect(get).toHaveBeenCalledWith('pkgsearch:brew:formula');
    expect(get).toHaveBeenCalledWith('pkgsearch:brew:cask');
  });

  it('writes each raw body to Redis with a 6h TTL after a cold fetch', async () => {
    const setex = vi.fn();
    redisMock.current = { get: vi.fn(async () => null), setex };
    stubBrewFetch();

    await searchHomebrew('slack');

    expect(setex).toHaveBeenCalledWith('pkgsearch:brew:formula', 21600, JSON.stringify(FORMULAE));
    expect(setex).toHaveBeenCalledWith('pkgsearch:brew:cask', 21600, JSON.stringify(CASKS));
  });

  it('survives a Redis outage (best-effort cache)', async () => {
    redisMock.current = {
      get: vi.fn(async () => { throw new Error('redis down'); }),
      setex: vi.fn(async () => { throw new Error('redis down'); }),
    };
    stubBrewFetch();
    const { results, degraded } = await searchHomebrew('slack');
    expect(degraded).toBe(false);
    expect(results.map((r) => r.packageId)).toEqual(['slack']);
  });

  it('single-flights concurrent searches into one upstream fetch per index', async () => {
    const fetchMock = stubBrewFetch();
    await Promise.all([searchHomebrew('slack'), searchHomebrew('chrome'), searchHomebrew('jq')]);
    // 2 sources x 1 fetch each, despite 3 concurrent callers.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// breezeTested annotation
// ---------------------------------------------------------------------------

describe('annotateBreezeTested', () => {
  const base = [
    { platform: 'windows' as const, kind: 'winget' as const, packageId: 'Google.Chrome', name: 'Chrome', vendor: 'Google' },
    { platform: 'windows' as const, kind: 'winget' as const, packageId: 'Mozilla.Firefox', name: 'Firefox', vendor: 'Mozilla' },
  ];

  it('attaches version-specific evidence only to matching packages', async () => {
    dbMock.execute.mockResolvedValue({
      rows: [
        {
          package_id: 'Google.Chrome',
          last_tested_version: '126.0',
          last_tested_at: new Date('2026-08-01T10:00:00.000Z'),
        },
      ],
    });

    const annotated = await annotateBreezeTested(base);

    expect(annotated[0]!.breezeTested).toEqual({ version: '126.0', testedAt: '2026-08-01T10:00:00.000Z' });
    expect(annotated[1]!.breezeTested).toBeUndefined();
  });

  it('handles a bare array result shape (driver variance)', async () => {
    dbMock.execute.mockResolvedValue([
      { package_id: 'Mozilla.Firefox', last_tested_version: '128', last_tested_at: '2026-07-02T00:00:00.000Z' },
    ]);
    const annotated = await annotateBreezeTested(base);
    expect(annotated[1]!.breezeTested).toEqual({ version: '128', testedAt: '2026-07-02T00:00:00.000Z' });
  });

  it('skips the query entirely for an empty result set', async () => {
    const annotated = await annotateBreezeTested([]);
    expect(annotated).toEqual([]);
    expect(dbMock.execute).not.toHaveBeenCalled();
  });

  it('leaves results untouched when nothing is breeze-tested', async () => {
    dbMock.execute.mockResolvedValue({ rows: [] });
    const annotated = await annotateBreezeTested(base);
    expect(annotated).toEqual(base);
  });
});
