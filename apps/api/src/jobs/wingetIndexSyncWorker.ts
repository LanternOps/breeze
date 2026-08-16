/**
 * winget package-index sync.
 *
 * Mirrors the *paths* of the microsoft/winget-pkgs manifest tree into
 * `winget_package_index` so /software/package-search can offer typeahead over
 * winget IDs without hitting GitHub per keystroke. Manifest CONTENTS are never
 * parsed here — package IDs are `Vendor.Product` and already human-searchable,
 * and per-package detail is fetched lazily at import time.
 *
 * The Git Trees API truncates on a repo this size, so we walk one subtree per
 * single-character bucket under `manifests/` (a-z plus the digit buckets like
 * `manifests/7`) rather than asking for the whole tree at once. That is
 * 1 (bucket listing) + ~26 (per-bucket) unauthenticated requests, against a
 * 60 req/h anonymous limit, hence the 24h repeat and 2s inter-request spacing.
 *
 * Generation semantics without a second table: every row written by a run is
 * stamped with the run's tree SHA; rows still carrying an older SHA are stale
 * and deleted — but ONLY after every bucket fetch succeeded, so a partial run
 * can never wipe the index.
 *
 * Structure copied from jobs/cveEnrichmentWorker.ts.
 */
import { Job, Queue, Worker } from 'bullmq';
import { ne, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { wingetPackageIndex } from '../db/schema';
import { getBullMQConnection, isRedisAvailable } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';

const { db } = dbModule;

const QUEUE_NAME = 'winget-index-sync';
const JOB_NAME = 'sync';
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

const GITHUB_API = 'https://api.github.com';
const REPO = 'microsoft/winget-pkgs';
const FETCH_TIMEOUT_MS = 30_000;
const REQUEST_SPACING_MS = 2_000;
const MAX_RESPONSE_BYTES = 40_000_000;
const UPSERT_CHUNK_SIZE = 500;

type WingetIndexSyncJobData = Record<string, never>;

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

export class WingetRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WingetRateLimitError';
  }
}

export class WingetFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WingetFetchError';
  }
}

// ---------------------------------------------------------------------------
// Pure parsing
// ---------------------------------------------------------------------------

export interface WingetTreeEntry {
  path: string;
  type?: string;
}

export interface ParsedWingetPackage {
  vendor: string;
  name: string;
  versions: string[];
}

const MANIFEST_FILE_RE = /\.(yaml|yml)$/i;
const BUCKET_PREFIX_RE = /^(?:manifests\/)?[a-z0-9]\//i;

/**
 * Lenient version comparison: split on non-alphanumerics, compare numeric
 * segments numerically and everything else lexicographically. Good enough to
 * pick a "latest" from winget's wildly inconsistent version strings without
 * pretending to be semver.
 */
export function compareWingetVersions(a: string, b: string): number {
  const as = a.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const bs = b.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x) ? Number(x) : null;
    const yn = /^\d+$/.test(y) ? Number(y) : null;
    if (xn !== null && yn !== null) {
      if (xn !== yn) return xn < yn ? -1 : 1;
      continue;
    }
    // A numeric segment sorts below an alphanumeric one (1.0 < 1.0beta is
    // wrong for semver but harmless here: we only need a stable "max").
    if (xn !== null) return -1;
    if (yn !== null) return 1;
    const cmp = x.toLowerCase().localeCompare(y.toLowerCase());
    if (cmp !== 0) return cmp;
  }
  return 0;
}

export function pickLatestVersion(versions: string[]): string | null {
  let latest: string | null = null;
  for (const v of versions) {
    if (latest === null || compareWingetVersions(v, latest) > 0) latest = v;
  }
  return latest;
}

/**
 * Derive packages from winget-pkgs manifest paths.
 *
 * Accepts paths either relative to a bucket subtree
 * (`Google/Chrome/126.0/Google.Chrome.installer.yaml`) or repo-absolute
 * (`manifests/g/Google/Chrome/126.0/Google.Chrome.installer.yaml`).
 *
 * The package identifier is NOT assumed to be two segments — winget has
 * IDs like `Microsoft.VisualStudio.2022.Community`. The version directory is
 * always the manifest file's parent, so everything above it is the identifier.
 */
export function parseWingetTreePaths(
  entries: Array<WingetTreeEntry>,
): Map<string, ParsedWingetPackage> {
  const out = new Map<string, ParsedWingetPackage>();

  for (const entry of entries) {
    if (!entry || typeof entry.path !== 'string') continue;
    if (entry.type && entry.type !== 'blob') continue;
    if (!MANIFEST_FILE_RE.test(entry.path)) continue;

    const normalized = entry.path.replace(BUCKET_PREFIX_RE, '');
    const segments = normalized.split('/').filter(Boolean);
    // <idSegment...>/<version>/<file.yaml> — at least 3 segments.
    if (segments.length < 3) continue;

    const version = segments[segments.length - 2]!;
    const idSegments = segments.slice(0, segments.length - 2);
    if (idSegments.length < 2) continue;

    const packageId = idSegments.join('.');
    if (packageId.length > 256) continue;

    const vendor = idSegments[0]!.slice(0, 200);
    const name = idSegments.slice(1).join('.').slice(0, 200);
    if (!vendor || !name) continue;

    const existing = out.get(packageId);
    if (existing) {
      if (!existing.versions.includes(version)) existing.versions.push(version);
    } else {
      out.set(packageId, { vendor, name, versions: [version] });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// GitHub fetching
// ---------------------------------------------------------------------------

interface GitTreeResponse {
  sha: string;
  truncated?: boolean;
  tree?: Array<{ path: string; type: string }>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchGitTree(pathExpr: string, recursive: boolean): Promise<GitTreeResponse> {
  const url =
    `${GITHUB_API}/repos/${REPO}/git/trees/${encodeURIComponent(pathExpr)}` +
    (recursive ? '?recursive=1' : '');

  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'breeze-rmm-winget-index-sync',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    const snippet = bodyText.slice(0, 300);
    const remaining = res.headers?.get?.('x-ratelimit-remaining');
    if (res.status === 429 || (res.status === 403 && remaining === '0')) {
      throw new WingetRateLimitError(
        `GitHub rate limited (${res.status}) for ${pathExpr}: ${snippet}`,
      );
    }
    throw new WingetFetchError(
      `GitHub tree fetch failed (${res.status}) for ${pathExpr}: ${snippet}`,
    );
  }

  const text = await res.text();
  if (text.length >= MAX_RESPONSE_BYTES) {
    throw new WingetFetchError(`GitHub tree response too large (${text.length} bytes) for ${pathExpr}`);
  }
  try {
    return JSON.parse(text) as GitTreeResponse;
  } catch (err) {
    throw new WingetFetchError(
      `GitHub returned invalid JSON for ${pathExpr}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface WingetIndexSyncSummary {
  buckets: number;
  packages: number;
  upserted: number;
  deleted: number;
  treeSha: string | null;
  skipped?: 'rate_limited';
}

export async function runWingetIndexSync(): Promise<WingetIndexSyncSummary> {
  const summary: WingetIndexSyncSummary = {
    buckets: 0,
    packages: 0,
    upserted: 0,
    deleted: 0,
    treeSha: null,
  };

  let root: GitTreeResponse;
  try {
    root = await fetchGitTree('HEAD:manifests', false);
  } catch (err) {
    if (err instanceof WingetRateLimitError) {
      console.warn('[WingetIndexSync] rate limited; skipping run', { error: err.message });
      return { ...summary, skipped: 'rate_limited' };
    }
    throw err;
  }

  const treeSha = (root.sha ?? '').slice(0, 64);
  if (!treeSha) throw new WingetFetchError('GitHub manifests tree returned no sha');
  summary.treeSha = treeSha;

  const buckets = (root.tree ?? [])
    .filter((e) => e.type === 'tree' && /^[a-z0-9]$/i.test(e.path))
    .map((e) => e.path)
    .sort();

  if (buckets.length === 0) throw new WingetFetchError('GitHub manifests tree listed no buckets');

  const merged = new Map<string, ParsedWingetPackage>();

  for (const bucket of buckets) {
    await sleep(REQUEST_SPACING_MS);
    let tree: GitTreeResponse;
    try {
      tree = await fetchGitTree(`HEAD:manifests/${bucket}`, true);
    } catch (err) {
      if (err instanceof WingetRateLimitError) {
        console.warn('[WingetIndexSync] rate limited mid-run; skipping run', {
          bucket,
          error: err.message,
        });
        return { ...summary, skipped: 'rate_limited' };
      }
      throw err;
    }
    summary.buckets++;
    for (const [pkgId, parsed] of parseWingetTreePaths(tree.tree ?? [])) {
      const existing = merged.get(pkgId);
      if (existing) {
        for (const v of parsed.versions) {
          if (!existing.versions.includes(v)) existing.versions.push(v);
        }
      } else {
        merged.set(pkgId, parsed);
      }
    }
  }

  summary.packages = merged.size;
  if (merged.size === 0) {
    // Defensive: never let an empty parse delete the whole index.
    throw new WingetFetchError('winget tree walk produced zero packages; refusing to prune index');
  }

  const now = new Date();
  const rows = Array.from(merged.entries()).map(([packageId, parsed]) => ({
    packageId,
    vendorSegment: parsed.vendor,
    nameSegment: parsed.name,
    latestVersion: pickLatestVersion(parsed.versions)?.slice(0, 128) ?? null,
    syncedCommitSha: treeSha,
    updatedAt: now,
  }));

  for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK_SIZE);
    await db
      .insert(wingetPackageIndex)
      .values(chunk)
      .onConflictDoUpdate({
        target: wingetPackageIndex.packageId,
        set: {
          vendorSegment: sql`excluded.vendor_segment`,
          nameSegment: sql`excluded.name_segment`,
          latestVersion: sql`excluded.latest_version`,
          syncedCommitSha: sql`excluded.synced_commit_sha`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
    summary.upserted += chunk.length;
  }

  // Every bucket succeeded (any failure returned/threw above), so anything
  // still carrying an older generation marker no longer exists upstream.
  const deleted = await db
    .delete(wingetPackageIndex)
    .where(ne(wingetPackageIndex.syncedCommitSha, treeSha))
    .returning({ id: wingetPackageIndex.id });
  summary.deleted = Array.isArray(deleted) ? deleted.length : 0;

  return summary;
}

// ---------------------------------------------------------------------------
// BullMQ wiring
// ---------------------------------------------------------------------------

let syncQueue: Queue<WingetIndexSyncJobData> | null = null;
let syncWorker: Worker<WingetIndexSyncJobData> | null = null;

export function getWingetIndexSyncQueue(): Queue<WingetIndexSyncJobData> {
  if (!syncQueue) {
    syncQueue = new Queue<WingetIndexSyncJobData>(QUEUE_NAME, {
      connection: getBullMQConnection(),
    });
  }
  return syncQueue;
}

export function createWingetIndexSyncWorker(): Worker<WingetIndexSyncJobData> {
  return new Worker<WingetIndexSyncJobData>(
    QUEUE_NAME,
    async (job: Job<WingetIndexSyncJobData>) => {
      if (job.name !== JOB_NAME) {
        console.warn(`[WingetIndexSync] Ignoring unknown job name: ${job.name}`);
        return { buckets: 0, packages: 0, upserted: 0, deleted: 0, treeSha: null, skipped: true };
      }
      return runWithSystemDbAccess(() => runWingetIndexSync());
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1,
    },
  );
}

export async function initializeWingetIndexSyncWorker(): Promise<void> {
  if (!isRedisAvailable()) {
    console.warn('[WingetIndexSync] Redis unavailable; queue worker disabled');
    return;
  }

  try {
    syncWorker = createWingetIndexSyncWorker();
    attachWorkerObservability(syncWorker, 'wingetIndexSyncWorker');

    syncWorker.on('error', (error) => {
      console.error('[WingetIndexSync] Worker error:', error);
    });
    syncWorker.on('failed', (job, error) => {
      console.error(`[WingetIndexSync] Job ${job?.id} failed:`, error);
    });

    const queue = getWingetIndexSyncQueue();
    const existingJobs = await queue.getRepeatableJobs();
    for (const job of existingJobs) {
      await queue.removeRepeatableByKey(job.key);
    }

    await queue.add(
      JOB_NAME,
      {} as WingetIndexSyncJobData,
      {
        repeat: { every: DEFAULT_INTERVAL_MS },
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 10 },
      },
    );

    console.log('[WingetIndexSync] Worker initialized');
  } catch (error) {
    console.error('[WingetIndexSync] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownWingetIndexSyncWorker(): Promise<void> {
  if (syncWorker) {
    await syncWorker.close();
    syncWorker = null;
  }
  if (syncQueue) {
    await syncQueue.close();
    syncQueue = null;
  }
}
