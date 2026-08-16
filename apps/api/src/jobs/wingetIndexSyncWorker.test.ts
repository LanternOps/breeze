import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../db', () => ({
  db: {
    insert: vi.fn(),
    delete: vi.fn(),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

// Use the REAL Drizzle table (not a stub object) so the ON CONFLICT `set`
// clauses below compile to actual SQL we can assert on — that is the only way
// to prove the truncated-bucket path preserves `latest_version` rather than
// overwriting it from `excluded`.
vi.mock('../db/schema', async () => ({
  wingetPackageIndex: (
    (await vi.importActual('../db/schema/wingetIndex')) as typeof import('../db/schema/wingetIndex')
  ).wingetPackageIndex,
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({})),
  isRedisAvailable: vi.fn(() => false),
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: vi.fn(),
  Worker: vi.fn(),
  Job: vi.fn(),
}));

import {
  parseWingetTreePaths,
  pickLatestVersion,
  compareWingetVersions,
  runWingetIndexSync,
  buildTreeUrl,
  WingetRateLimitError,
} from './wingetIndexSyncWorker';
import { db } from '../db';

// ---------------------------------------------------------------------------
// parseWingetTreePaths
// ---------------------------------------------------------------------------

describe('parseWingetTreePaths', () => {
  it('derives package_id / vendor / name / versions from bucket-relative paths', () => {
    const map = parseWingetTreePaths([
      { path: 'Google/Chrome/126.0.6478.127/Google.Chrome.installer.yaml', type: 'blob' },
      { path: 'Google/Chrome/126.0.6478.127/Google.Chrome.yaml', type: 'blob' },
      { path: 'Google/Chrome/127.0.1/Google.Chrome.installer.yaml', type: 'blob' },
    ]);

    expect([...map.keys()]).toEqual(['Google.Chrome']);
    const entry = map.get('Google.Chrome')!;
    expect(entry.vendor).toBe('Google');
    expect(entry.name).toBe('Chrome');
    expect(entry.versions.sort()).toEqual(['126.0.6478.127', '127.0.1']);
  });

  it('accepts repo-absolute paths with the manifests/<letter>/ prefix', () => {
    const map = parseWingetTreePaths([
      { path: 'manifests/g/Google/Chrome/126.0/Google.Chrome.installer.yaml', type: 'blob' },
    ]);
    expect(map.get('Google.Chrome')).toEqual({ vendor: 'Google', name: 'Chrome', versions: ['126.0'] });
  });

  it('handles multi-segment package identifiers', () => {
    const map = parseWingetTreePaths([
      {
        path: 'Microsoft/VisualStudio/2022/Community/17.10.4/Microsoft.VisualStudio.2022.Community.installer.yaml',
        type: 'blob',
      },
    ]);
    const entry = map.get('Microsoft.VisualStudio.2022.Community')!;
    expect(entry).toBeDefined();
    expect(entry.vendor).toBe('Microsoft');
    expect(entry.name).toBe('VisualStudio.2022.Community');
    expect(entry.versions).toEqual(['17.10.4']);
  });

  it('handles digit buckets', () => {
    const map = parseWingetTreePaths([
      { path: '7zip/7zip/24.07/7zip.7zip.installer.yaml', type: 'blob' },
    ]);
    expect(map.get('7zip.7zip')).toEqual({ vendor: '7zip', name: '7zip', versions: ['24.07'] });
  });

  it('ignores tree entries, non-yaml files and too-shallow paths', () => {
    const map = parseWingetTreePaths([
      { path: 'Google/Chrome/126.0', type: 'tree' },
      { path: 'Google/Chrome/126.0/README.md', type: 'blob' },
      { path: 'Google/.validation', type: 'blob' },
      { path: 'Orphan/thing.yaml', type: 'blob' },
    ]);
    expect(map.size).toBe(0);
  });

  it('deduplicates versions across the several manifest files per version', () => {
    const map = parseWingetTreePaths([
      { path: 'Vendor/App/1.0/Vendor.App.yaml', type: 'blob' },
      { path: 'Vendor/App/1.0/Vendor.App.installer.yaml', type: 'blob' },
      { path: 'Vendor/App/1.0/Vendor.App.locale.en-US.yaml', type: 'blob' },
    ]);
    expect(map.get('Vendor.App')!.versions).toEqual(['1.0']);
  });

  it('tolerates entries without a type field (trees API omits nothing, fixtures might)', () => {
    const map = parseWingetTreePaths([{ path: 'Vendor/App/1.0/Vendor.App.yaml' }]);
    expect(map.size).toBe(1);
  });
});

describe('compareWingetVersions / pickLatestVersion', () => {
  it('compares numeric segments numerically, not lexicographically', () => {
    expect(compareWingetVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareWingetVersions('126.0.6478.127', '99.0.1')).toBeGreaterThan(0);
    expect(compareWingetVersions('1.0', '1.0')).toBe(0);
  });

  it('treats a longer version as newer when prefixes match', () => {
    expect(compareWingetVersions('1.0.1', '1.0')).toBeGreaterThan(0);
  });

  it('picks the max version leniently', () => {
    expect(pickLatestVersion(['1.9.0', '1.10.0', '1.2.0'])).toBe('1.10.0');
    expect(pickLatestVersion(['2024.05.01', '2023.12.31'])).toBe('2024.05.01');
    expect(pickLatestVersion([])).toBeNull();
  });

  it('does not throw on non-numeric version strings', () => {
    expect(() => pickLatestVersion(['latest', 'nightly', '1.0'])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// runWingetIndexSync
// ---------------------------------------------------------------------------

function treeResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => init.headers?.[k.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Renders a Drizzle SQL fragment to the string Postgres would receive. */
const dialect = new PgDialect();
const renderSql = (fragment: unknown): string => dialect.sqlToQuery(fragment as never).sql;

interface UpsertCall {
  rows: Array<Record<string, unknown>>;
  latestVersionSet: string;
}

describe('runWingetIndexSync', () => {
  let insertMock: ReturnType<typeof vi.fn>;
  let deleteMock: ReturnType<typeof vi.fn>;
  let upserts: UpsertCall[];

  /** All rows written this run, across the complete/partial upsert split. */
  const allRows = () => upserts.flatMap((u) => u.rows);
  const upsertFor = (packageId: string) =>
    upserts.find((u) => u.rows.some((r) => r.packageId === packageId));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    upserts = [];
    insertMock = vi.fn(() => ({
      values: vi.fn((rows: Array<Record<string, unknown>>) => ({
        onConflictDoUpdate: vi.fn(async (cfg: { set: Record<string, unknown> }) => {
          upserts.push({ rows, latestVersionSet: renderSql(cfg.set.latestVersion) });
        }),
      })),
    }));
    deleteMock = vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 'stale-1' }]) })) }));
    (db as unknown as { insert: unknown }).insert = insertMock;
    (db as unknown as { delete: unknown }).delete = deleteMock;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Drives the promise while auto-advancing the 2s inter-request sleeps. */
  async function runWithTimers<T>(p: Promise<T>): Promise<T> {
    // Attach handlers synchronously so a rejection while the fake timers are
    // being drained is never reported as unhandled.
    const settled = p.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await vi.runAllTimersAsync();
    const outcome = await settled;
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  it('walks each bucket, upserts packages and prunes stale generations', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('HEAD%3Amanifests?') || url.endsWith('HEAD%3Amanifests')) {
        return treeResponse({
          sha: 'tree-sha-abc',
          tree: [
            { path: 'g', type: 'tree' },
            { path: 'v', type: 'tree' },
            { path: 'README.md', type: 'blob' },
          ],
        });
      }
      if (url.includes('manifests%2Fg')) {
        return treeResponse({
          sha: 'g-sha',
          tree: [{ path: 'Google/Chrome/126.0/Google.Chrome.installer.yaml', type: 'blob' }],
        });
      }
      return treeResponse({
        sha: 'v-sha',
        tree: [
          { path: 'Vendor/App/1.0/Vendor.App.yaml', type: 'blob' },
          { path: 'Vendor/App/1.2/Vendor.App.yaml', type: 'blob' },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runWithTimers(runWingetIndexSync());

    expect(summary.skipped).toBeUndefined();
    expect(summary.buckets).toBe(2);
    expect(summary.packages).toBe(2);
    expect(summary.upserted).toBe(2);
    expect(summary.treeSha).toBe('tree-sha-abc');
    expect(summary.complete).toBe(true);
    expect(summary.truncatedBuckets).toEqual([]);
    expect(summary.pruned).toBe(true);
    expect(summary.deleted).toBe(1);

    // 1 bucket listing + 2 bucket subtrees.
    expect(fetchMock).toHaveBeenCalledTimes(3);

    expect(allRows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          packageId: 'Google.Chrome',
          vendorSegment: 'Google',
          nameSegment: 'Chrome',
          latestVersion: '126.0',
          syncedCommitSha: 'tree-sha-abc',
        }),
        expect.objectContaining({ packageId: 'Vendor.App', latestVersion: '1.2' }),
      ]),
    );
    // Nothing was truncated, so every row overwrites latest_version outright.
    expect(upserts.every((u) => u.latestVersionSet === 'excluded.latest_version')).toBe(true);
    expect(deleteMock).toHaveBeenCalled();
  });

  it('skips the run without pruning when GitHub rate-limits the bucket listing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        treeResponse({ message: 'rate limit' }, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
      ),
    );

    const summary = await runWithTimers(runWingetIndexSync());

    expect(summary.skipped).toBe('rate_limited');
    expect(summary.complete).toBe(false);
    expect(summary.pruned).toBe(false);
    expect(deleteMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('skips the run without pruning when rate-limited mid-walk', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call++;
        if (call === 1) {
          return treeResponse({ sha: 'tree-sha', tree: [{ path: 'g', type: 'tree' }, { path: 'v', type: 'tree' }] });
        }
        if (call === 2) {
          return treeResponse({
            sha: 'g',
            tree: [{ path: 'Google/Chrome/1.0/Google.Chrome.yaml', type: 'blob' }],
          });
        }
        return treeResponse({}, { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
      }),
    );

    const summary = await runWithTimers(runWingetIndexSync());

    expect(summary.skipped).toBe('rate_limited');
    expect(summary.complete).toBe(false);
    expect(summary.pruned).toBe(false);
    expect(insertMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('rethrows non-rate-limit fetch failures rather than pruning', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => treeResponse({ message: 'boom' }, { status: 500 })));
    await expect(runWithTimers(runWingetIndexSync())).rejects.toThrow(/GitHub tree fetch failed \(500\)/);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('refuses to prune when the walk yields zero packages', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('manifests%2F')
          ? treeResponse({ sha: 'g', tree: [] })
          : treeResponse({ sha: 'tree-sha', tree: [{ path: 'g', type: 'tree' }] }),
      ),
    );

    await expect(runWithTimers(runWingetIndexSync())).rejects.toThrow(/zero packages/);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Truncation. GitHub caps a recursive tree response and reports it with
  // `truncated: true` on a 200 — the `manifests/m` bucket does this in
  // production TODAY (58k entries / 16MB, verified 2026-08-15). The entries it
  // silently drops are exactly the rows a prune would delete.
  // -------------------------------------------------------------------------

  it('suppresses the prune when a bucket response is truncated, but still upserts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('manifests%2Fm')) {
          return treeResponse({
            sha: 'm-sha',
            truncated: true,
            tree: [{ path: 'Microsoft/Edge/1.0/Microsoft.Edge.yaml', type: 'blob' }],
          });
        }
        if (url.includes('manifests%2Fg')) {
          return treeResponse({
            sha: 'g-sha',
            tree: [{ path: 'Google/Chrome/126.0/Google.Chrome.yaml', type: 'blob' }],
          });
        }
        return treeResponse({
          sha: 'tree-sha',
          tree: [{ path: 'g', type: 'tree' }, { path: 'm', type: 'tree' }],
        });
      }),
    );

    const summary = await runWithTimers(runWingetIndexSync());

    // The prune is the whole point of this test.
    expect(deleteMock).not.toHaveBeenCalled();
    expect(summary.pruned).toBe(false);
    expect(summary.deleted).toBe(0);
    expect(summary.complete).toBe(false);
    expect(summary.truncatedBuckets).toEqual(['m']);

    // Upserts are additive and must still land — a truncated run should keep
    // the index fresh for everything it *did* see.
    expect(summary.upserted).toBe(2);
    expect(insertMock).toHaveBeenCalled();
    expect(allRows().map((r) => r.packageId).sort()).toEqual(['Google.Chrome', 'Microsoft.Edge']);

    // The two groups are written with DIFFERENT conflict clauses: the package
    // from the complete `g` bucket overwrites latest_version, the one from the
    // truncated `m` bucket keeps whatever is already stored.
    expect(upsertFor('Google.Chrome')!.latestVersionSet).toBe('excluded.latest_version');
    expect(upsertFor('Microsoft.Edge')!.latestVersionSet).toBe(
      '"winget_package_index"."latest_version"',
    );
  });

  it('never downgrades latest_version for a package seen only in a truncated bucket', async () => {
    // The scenario the guard exists for: the stored row is at 130.0, and a
    // truncated response happens to include only the older 120.0 version dir.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('manifests%2Fm')) {
          return treeResponse({
            sha: 'm-sha',
            truncated: true,
            tree: [{ path: 'Microsoft/Edge/120.0/Microsoft.Edge.yaml', type: 'blob' }],
          });
        }
        return treeResponse({ sha: 'new-tree-sha', tree: [{ path: 'm', type: 'tree' }] });
      }),
    );

    const summary = await runWithTimers(runWingetIndexSync());
    const upsert = upsertFor('Microsoft.Edge')!;

    // The UPDATE branch re-reads the stored column instead of taking the
    // partial value, so an existing 130.0 survives the run untouched.
    expect(upsert.latestVersionSet).toBe('"winget_package_index"."latest_version"');
    expect(upsert.latestVersionSet).not.toContain('excluded');

    // The generation marker and identity columns DO still advance...
    expect(upsert.rows[0]!.syncedCommitSha).toBe('new-tree-sha');
    expect(upsert.rows[0]!.vendorSegment).toBe('Microsoft');
    expect(upsert.rows[0]!.nameSegment).toBe('Edge');

    // ...and the partial value is still carried for the INSERT branch, which
    // is correct for a package that has no stored row yet.
    expect(upsert.rows[0]!.latestVersion).toBe('120.0');
    expect(summary.pruned).toBe(false);
  });

  it('suppresses the prune when the bucket listing itself is truncated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('manifests%2F')
          ? treeResponse({
              sha: 'g-sha',
              tree: [{ path: 'Google/Chrome/126.0/Google.Chrome.yaml', type: 'blob' }],
            })
          : treeResponse({ sha: 'tree-sha', truncated: true, tree: [{ path: 'g', type: 'tree' }] }),
      ),
    );

    const summary = await runWithTimers(runWingetIndexSync());

    expect(deleteMock).not.toHaveBeenCalled();
    expect(summary.complete).toBe(false);
    expect(summary.pruned).toBe(false);
    // The listing, not a bucket, was truncated — so no bucket is named.
    expect(summary.truncatedBuckets).toEqual([]);
    expect(summary.upserted).toBe(1);
  });

  it('records every truncated bucket, not just the first', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('manifests%2F')) {
          const bucket = url.includes('manifests%2Fg') ? 'g' : 'm';
          return treeResponse({
            sha: `${bucket}-sha`,
            truncated: true,
            tree: [{ path: `Vendor${bucket}/App/1.0/Vendor.App.yaml`, type: 'blob' }],
          });
        }
        return treeResponse({
          sha: 'tree-sha',
          tree: [{ path: 'g', type: 'tree' }, { path: 'm', type: 'tree' }],
        });
      }),
    );

    const summary = await runWithTimers(runWingetIndexSync());
    expect(summary.truncatedBuckets).toEqual(['g', 'm']);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('builds the tree URL in a form the live GitHub API accepts', () => {
    // Verified against api.github.com on 2026-08-15: this exact URL returns 200.
    expect(buildTreeUrl('HEAD:manifests/q', true)).toBe(
      'https://api.github.com/repos/microsoft/winget-pkgs/git/trees/HEAD%3Amanifests%2Fq?recursive=1',
    );
    expect(buildTreeUrl('HEAD:manifests', false)).toBe(
      'https://api.github.com/repos/microsoft/winget-pkgs/git/trees/HEAD%3Amanifests',
    );
  });

  it('exports a typed rate-limit error', () => {
    expect(new WingetRateLimitError('x')).toBeInstanceOf(Error);
    expect(new WingetRateLimitError('x').name).toBe('WingetRateLimitError');
  });
});

// ---------------------------------------------------------------------------
// GitHub token (#3602)
// ---------------------------------------------------------------------------

describe('runWingetIndexSync — GitHub token (#3602)', () => {
  let insertMock: ReturnType<typeof vi.fn>;
  let deleteMock: ReturnType<typeof vi.fn>;
  let upserts: UpsertCall[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    delete process.env.WINGET_INDEX_GITHUB_TOKEN;

    upserts = [];
    insertMock = vi.fn(() => ({
      values: vi.fn((rows: Array<Record<string, unknown>>) => ({
        onConflictDoUpdate: vi.fn(async (cfg: { set: Record<string, unknown> }) => {
          upserts.push({ rows, latestVersionSet: renderSql(cfg.set.latestVersion) });
        }),
      })),
    }));
    deleteMock = vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => []) })) }));
    (db as unknown as { insert: unknown }).insert = insertMock;
    (db as unknown as { delete: unknown }).delete = deleteMock;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.WINGET_INDEX_GITHUB_TOKEN;
  });

  async function runWithTimers<T>(p: Promise<T>): Promise<T> {
    const settled = p.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await vi.runAllTimersAsync();
    const outcome = await settled;
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /** One bucket `m` whose recursive fetch comes back TRUNCATED. */
  function fixtureFetch() {
    return vi.fn(async (url: string) => {
      if (url.includes('manifests%2Fm')) {
        return treeResponse({
          sha: 'm',
          truncated: true,
          tree: [{ path: 'Microsoft/Edge/126.0/Microsoft.Edge.installer.yaml', type: 'blob' }],
        });
      }
      return treeResponse({ sha: 'root-sha', tree: [{ path: 'm', type: 'tree' }] });
    });
  }

  it('sends no Authorization header when no token is set', async () => {
    const fetchMock = fixtureFetch();
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runWithTimers(runWingetIndexSync());

    expect(summary.authenticated).toBe(false);
    expect(summary.requests).toBe(2);
    for (const [, init] of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    }
  });

  it('sends a bearer token on every request when one is set', async () => {
    process.env.WINGET_INDEX_GITHUB_TOKEN = 'ghp_test_token';
    const fetchMock = fixtureFetch();
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runWithTimers(runWingetIndexSync());

    expect(summary.authenticated).toBe(true);
    for (const [, init] of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ghp_test_token');
    }
  });

  it('ignores a whitespace-only token rather than sending an empty bearer', async () => {
    process.env.WINGET_INDEX_GITHUB_TOKEN = '   ';
    const fetchMock = fixtureFetch();
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runWithTimers(runWingetIndexSync());

    expect(summary.authenticated).toBe(false);
    for (const [, init] of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    }
  });

  /**
   * The token buys request headroom, NOT completeness. Subtree splitting was
   * measured against the live API on 2026-08-16 and does not bottom out at any
   * affordable depth (manifests/m/Mozilla and .../Mozilla/Firefox both come
   * back truncated), so a truncated bucket must still suppress the prune while
   * authenticated — and must not spend extra requests trying.
   */
  it('still suppresses the prune for a truncated bucket when authenticated, with no extra requests', async () => {
    process.env.WINGET_INDEX_GITHUB_TOKEN = 'ghp_test_token';
    const fetchMock = fixtureFetch();
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runWithTimers(runWingetIndexSync());

    expect(summary.truncatedBuckets).toEqual(['m']);
    expect(summary.complete).toBe(false);
    expect(summary.pruned).toBe(false);
    expect(deleteMock).not.toHaveBeenCalled();
    // Root listing + the one bucket. No vendor walk, authenticated or not.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(summary.requests).toBe(2);
    // Rows still land, and still preserve the stored latest_version.
    expect(upserts.length).toBeGreaterThan(0);
    expect(upserts.every((u) => u.latestVersionSet.includes('latest_version'))).toBe(true);
  });
});
