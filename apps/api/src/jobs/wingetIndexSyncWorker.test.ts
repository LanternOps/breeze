import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db', () => ({
  db: {
    insert: vi.fn(),
    delete: vi.fn(),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  wingetPackageIndex: {
    id: 'id',
    packageId: 'package_id',
    vendorSegment: 'vendor_segment',
    nameSegment: 'name_segment',
    latestVersion: 'latest_version',
    syncedCommitSha: 'synced_commit_sha',
    updatedAt: 'updated_at',
  },
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

describe('runWingetIndexSync', () => {
  let insertMock: ReturnType<typeof vi.fn>;
  let deleteMock: ReturnType<typeof vi.fn>;
  let onConflictDoUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    onConflictDoUpdate = vi.fn(async () => undefined);
    insertMock = vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate })) }));
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
    expect(summary.deleted).toBe(1);

    // 1 bucket listing + 2 bucket subtrees.
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const rows = insertMock.mock.results[0]!.value.values.mock.calls[0][0];
    expect(rows).toEqual(
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

  it('exports a typed rate-limit error', () => {
    expect(new WingetRateLimitError('x')).toBeInstanceOf(Error);
    expect(new WingetRateLimitError('x').name).toBe('WingetRateLimitError');
  });
});
