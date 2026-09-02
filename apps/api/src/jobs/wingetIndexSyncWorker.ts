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
 * single-character bucket under `manifests/` rather than asking for the whole
 * tree at once. The bucket list is DISCOVERED from a non-recursive listing of
 * `manifests/` rather than hardcoded: upstream currently has 36 buckets (a-z
 * AND 0-9 — `manifests/7/7zip/…` is real), so a hardcoded a-z would silently
 * drop ten of them. That is 1 (bucket listing) + 36 (per-bucket) = 37
 * unauthenticated requests against a 60 req/h anonymous limit, hence the 24h
 * repeat and the 2s inter-request spacing.
 *
 * Generation semantics without a second table: every row written by a run is
 * stamped with the run's tree SHA; rows still carrying an older SHA are stale
 * and deleted — but ONLY after a run we can prove was COMPLETE, so a partial
 * run can never wipe the index. Three things make a run incomplete, and each
 * suppresses the prune while still allowing the (purely additive) upserts:
 * a rate-limited or failed fetch, and — the subtle one — a `truncated: true`
 * response.
 *
 * Truncation is NOT a rare edge case here, it is the steady state: a recursive
 * fetch of `manifests/m` returns 58k entries / ~16MB and comes back
 * `truncated: true` today (verified 2026-08-15). GitHub truncates below our
 * byte guard and still answers 200, and the entries it drops are exactly the
 * rows a prune would then delete — for `m` that is most of the 27k-entry
 * Microsoft namespace. The truncation cut point is not a clean alphabetical
 * boundary either, so the complete subset cannot be identified. We therefore
 * upsert what we got and skip the prune. Consequence to be aware of: while any bucket truncates,
 * withdrawn packages are never pruned and linger in the typeahead. That is a
 * cosmetic staleness; deleting 27k live packages every run is not.
 *
 * #3602 proposed an optional GitHub token (5000 req/h) to fix two things. Both
 * were investigated against the live API on 2026-08-16 and NEITHER justified it,
 * so no token is read here — deliberately, not by omission.
 *
 * Skipped runs: not observed and not expected. One run costs 37 requests, once
 * per 24h; the only other GitHub callers in this API are latestVersion (1/h,
 * TTL-cached) and binarySync (around releases), so steady state is ~39 of the
 * 60/h anonymous budget on a dedicated egress IP. A shared/CGNAT IP could still
 * lose that race — the `degraded` flag on GET /software/package-search is the
 * instrument that would SHOW it, and a token can be added then, with evidence.
 *
 * Pruning: unreachable by splitting a truncated bucket into smaller subtrees.
 * The split does not bottom out at any affordable depth:
 *
 *   manifests/m                     -> truncated (550 vendor directories,
 *                                      not the 351 #3602 assumed)
 *   manifests/m/Mozilla             -> 61,700 entries, STILL truncated
 *   manifests/m/Mozilla/Firefox     -> 66,194 entries, STILL truncated
 *   manifests/m/Mozilla/Firefox/*   -> 277 version directories
 *
 * Truncation is on RESPONSE BYTES, not entry count (Microsoft's 27,696-entry
 * subtree comes back complete), and winget's per-version locale manifests blow
 * that budget three levels deep. Bottoming out means descending to version
 * directories for the worst packages — hundreds of requests for ONE package,
 * unbounded across 36 buckets. Even at 5000 req/h that is not affordable, so a
 * token would not have bought pruning either.
 *
 * The real fix is to stop walking git trees altogether: Microsoft publishes the
 * prebuilt index the winget client itself searches at
 * https://cdn.winget.microsoft.com/cache/source2.msix — 3.5 MB, a SQLite
 * database, no rate limit and no truncation. Tracked in #3622; that work
 * retires this worker.
 *
 * Truncation has a second, quieter consequence: a truncated response's version
 * list is a SUBSET of reality, so the `latest_version` computed from it can be
 * lower than the value already stored. Upserts are therefore split in two. Rows
 * from complete buckets overwrite `latest_version` outright; rows from a
 * truncated bucket update the identity columns and the generation marker but
 * PRESERVE the stored `latest_version`, so the column can never walk backwards.
 * A package seen for the first time in a truncated response still inserts with
 * the partial value — there is no better prior — and self-corrects on the next
 * complete run. The tradeoff: for as long as a bucket keeps truncating, genuine
 * new releases of packages in that bucket are not picked up either. Version
 * intent at deploy time is `latest` (resolved on the device by winget itself),
 * so this column is display metadata, not the thing that decides what installs.
 *
 * Structure copied from jobs/cveEnrichmentWorker.ts.
 */
import { Job, Queue, Worker } from 'bullmq';
import { ne, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { wingetPackageIndex } from '../db/schema';
import { getBullMQConnection, isRedisAvailable } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';

const { db } = dbModule;

const QUEUE_NAME = 'winget-index-sync';
const JOB_NAME = 'sync';

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

/**
 * Build the Trees API URL for a `<ref>:<path>` expression.
 *
 * Verified against the live API on 2026-08-15 (see task-8 report): GitHub
 * accepts the fully percent-encoded form (`HEAD%3Amanifests%2Fq`), the
 * colon-only-encoded form (`HEAD%3Amanifests/q`) and the fully literal form
 * (`HEAD:manifests/q`) — all three return 200 with an identical body. We keep
 * the fully-encoded form since it is the one that cannot be confused by a path
 * segment containing reserved characters.
 */
export function buildTreeUrl(pathExpr: string, recursive: boolean): string {
  return (
    `${GITHUB_API}/repos/${REPO}/git/trees/${encodeURIComponent(pathExpr)}` +
    (recursive ? '?recursive=1' : '')
  );
}

async function fetchGitTree(pathExpr: string, recursive: boolean): Promise<GitTreeResponse> {
  const url = buildTreeUrl(pathExpr, recursive);

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
  /** False when any response was truncated — suppresses the stale-row prune. */
  complete: boolean;
  /** Buckets GitHub answered with `truncated: true` (data silently incomplete). */
  truncatedBuckets: string[];
  /** Whether the stale-generation delete actually ran. */
  pruned: boolean;
  /** Trees API calls this run made — the thing the rate limit actually counts. */
  requests: number;
  skipped?: 'rate_limited';
}

export async function runWingetIndexSync(): Promise<WingetIndexSyncSummary> {
  const summary: WingetIndexSyncSummary = {
    buckets: 0,
    packages: 0,
    upserted: 0,
    deleted: 0,
    treeSha: null,
    complete: true,
    truncatedBuckets: [],
    pruned: false,
    requests: 0,
  };

  let root: GitTreeResponse;
  try {
    root = await fetchGitTree('HEAD:manifests', false);
    summary.requests++;
  } catch (err) {
    if (err instanceof WingetRateLimitError) {
      console.warn('[WingetIndexSync] rate limited; skipping run', { error: err.message });
      return { ...summary, complete: false, skipped: 'rate_limited' };
    }
    throw err;
  }

  const treeSha = (root.sha ?? '').slice(0, 64);
  if (!treeSha) throw new WingetFetchError('GitHub manifests tree returned no sha');
  summary.treeSha = treeSha;

  // A truncated bucket LISTING means we don't even know every bucket, so the
  // walk cannot be authoritative. (Not expected at 36 entries, but the flag is
  // free to honour and the failure mode would be silent.)
  if (root.truncated) {
    summary.complete = false;
    console.warn('[WingetIndexSync] manifests bucket listing was truncated; prune suppressed');
  }

  const buckets = (root.tree ?? [])
    .filter((e) => e.type === 'tree' && /^[a-z0-9]$/i.test(e.path))
    .map((e) => e.path)
    .sort();

  if (buckets.length === 0) throw new WingetFetchError('GitHub manifests tree listed no buckets');

  const merged = new Map<string, ParsedWingetPackage>();
  // Packages whose version list came from a truncated response, and is
  // therefore possibly missing the newest versions. See the upsert below.
  const partialPackageIds = new Set<string>();

  const mergeInto = (
    target: Map<string, ParsedWingetPackage>,
    source: Map<string, ParsedWingetPackage>,
  ) => {
    for (const [pkgId, parsed] of source) {
      const existing = target.get(pkgId);
      if (existing) {
        for (const v of parsed.versions) {
          if (!existing.versions.includes(v)) existing.versions.push(v);
        }
      } else {
        target.set(pkgId, parsed);
      }
    }
  };

  for (const bucket of buckets) {
    await sleep(REQUEST_SPACING_MS);
    let tree: GitTreeResponse;
    try {
      tree = await fetchGitTree(`HEAD:manifests/${bucket}`, true);
      summary.requests++;
    } catch (err) {
      if (err instanceof WingetRateLimitError) {
        console.warn('[WingetIndexSync] rate limited mid-run; skipping run', {
          bucket,
          error: err.message,
        });
        return { ...summary, complete: false, skipped: 'rate_limited' };
      }
      throw err;
    }
    summary.buckets++;

    const bucketPackages = parseWingetTreePaths(tree.tree ?? []);

    // GitHub caps a recursive tree response and reports it with `truncated:
    // true` on an otherwise-normal 200 — the byte guard above cannot catch it
    // because truncation happens well below that ceiling. The dropped entries
    // are precisely the packages a prune would then delete, so a truncated
    // bucket makes the whole run non-authoritative. Upserts still proceed
    // (they are additive and cannot lose data); only the prune is suppressed.
    // Not rescuable — see the header block: subtree splitting was measured
    // against the live API and does not bottom out at any affordable depth,
    // with or without a token.
    const bucketComplete = !tree.truncated;
    if (!bucketComplete) {
      summary.complete = false;
      summary.truncatedBuckets.push(bucket);
      console.warn('[WingetIndexSync] bucket response truncated; prune suppressed for this run', {
        bucket,
        entries: (tree.tree ?? []).length,
      });
    }

    for (const pkgId of bucketPackages.keys()) {
      if (!bucketComplete) partialPackageIds.add(pkgId);
    }
    mergeInto(merged, bucketPackages);
  }

  summary.packages = merged.size;
  if (merged.size === 0) {
    // Defensive: never let an empty parse delete the whole index.
    throw new WingetFetchError('winget tree walk produced zero packages; refusing to prune index');
  }

  const now = new Date();
  const toRow = ([packageId, parsed]: [string, ParsedWingetPackage]) => ({
    packageId,
    vendorSegment: parsed.vendor,
    nameSegment: parsed.name,
    latestVersion: pickLatestVersion(parsed.versions)?.slice(0, 128) ?? null,
    syncedCommitSha: treeSha,
    updatedAt: now,
  });

  const entries = Array.from(merged.entries());
  const completeRows = entries.filter(([id]) => !partialPackageIds.has(id)).map(toRow);
  const partialRows = entries.filter(([id]) => partialPackageIds.has(id)).map(toRow);

  const upsertRows = async (
    rows: typeof completeRows,
    latestVersionSet: ReturnType<typeof sql>,
  ): Promise<void> => {
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
            latestVersion: latestVersionSet,
            syncedCommitSha: sql`excluded.synced_commit_sha`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
      summary.upserted += chunk.length;
    }
  };

  // Rows from a complete bucket response: the version list is authoritative,
  // so `latest_version` is overwritten outright.
  await upsertRows(completeRows, sql`excluded.latest_version`);

  // Rows from a TRUNCATED bucket response: the version list is a subset of
  // reality, so its computed max can be LOWER than what we already stored —
  // overwriting would silently walk `latest_version` backwards (a truncated
  // `m` that only sees old Microsoft.Edge version directories would downgrade
  // a previously-correct value). For these we update the identity columns and
  // the generation marker but PRESERVE the existing `latest_version`. A row
  // that does not exist yet still inserts with the partial value, since no
  // better prior exists; it self-corrects on the next complete run.
  await upsertRows(partialRows, sql`${wingetPackageIndex.latestVersion}`);

  // Prune ONLY on a provably complete walk. Every bucket fetch succeeded (any
  // failure returned or threw above) AND no response was truncated, so a row
  // still carrying an older generation marker genuinely no longer exists
  // upstream. If anything was truncated we keep the stale rows: an outdated
  // typeahead entry is harmless, deleting a live package is not.
  if (!summary.complete) {
    console.warn('[WingetIndexSync] walk incomplete; skipping stale-row prune', {
      truncatedBuckets: summary.truncatedBuckets,
      packages: summary.packages,
    });
    return summary;
  }

  const deleted = await db
    .delete(wingetPackageIndex)
    .where(ne(wingetPackageIndex.syncedCommitSha, treeSha))
    .returning({ id: wingetPackageIndex.id });
  summary.deleted = Array.isArray(deleted) ? deleted.length : 0;
  summary.pruned = true;

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
        return {
          buckets: 0,
          packages: 0,
          upserted: 0,
          deleted: 0,
          treeSha: null,
          complete: false,
          truncatedBuckets: [],
          pruned: false,
          requests: 0,
          skipped: true,
        };
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
        // Daily at a registry-allocated slot. NOT `every: 24h` — BullMQ anchors
        // `every` to the Unix epoch, so every 24h job fires at 00:00:00.000 UTC
        // together (see jobs/scheduleRegistry.ts).
        repeat: { pattern: jobSchedule('winget-index-sync') },
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
