/**
 * Package-manager typeahead backing GET /software/package-search.
 *
 * Windows (winget) is served from the locally synced `winget_package_index`
 * table (see jobs/wingetIndexSyncWorker.ts). macOS (Homebrew) is served by
 * fetching formulae.brew.sh's two full JSON indexes and filtering client-side
 * — brew has no search API, and the two payloads are cached in Redis for 6h
 * plus an in-process single-flight so a burst of keystrokes is one upstream
 * fetch at most.
 */
import { asc, ilike, or, sql } from 'drizzle-orm';
import { db } from '../db';
import { wingetPackageIndex } from '../db/schema';
import { getRedis } from './redis';

export interface PackageSearchResult {
  platform: 'windows' | 'macos';
  kind: 'winget' | 'homebrew_cask' | 'homebrew_formula';
  packageId: string;
  name: string;
  vendor: string;
  latestVersion?: string;
  description?: string;
  homepageUrl?: string;
  breezeTested?: { version: string; testedAt: string };
}

export const DEFAULT_SEARCH_LIMIT = 25;

// ---------------------------------------------------------------------------
// winget
// ---------------------------------------------------------------------------

/** Escape LIKE wildcards so a user typing `%` doesn't match everything. */
export function escapeLikePattern(q: string): string {
  return q.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export async function searchWingetIndex(
  q: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
): Promise<PackageSearchResult[]> {
  const pattern = `%${escapeLikePattern(q)}%`;

  const rows = await db
    .select({
      packageId: wingetPackageIndex.packageId,
      vendorSegment: wingetPackageIndex.vendorSegment,
      nameSegment: wingetPackageIndex.nameSegment,
      latestVersion: wingetPackageIndex.latestVersion,
    })
    .from(wingetPackageIndex)
    .where(
      or(
        ilike(wingetPackageIndex.packageId, pattern),
        ilike(wingetPackageIndex.nameSegment, pattern),
        ilike(wingetPackageIndex.vendorSegment, pattern),
      ),
    )
    .orderBy(asc(wingetPackageIndex.nameSegment))
    .limit(limit);

  return rows.map((row) => ({
    platform: 'windows' as const,
    kind: 'winget' as const,
    packageId: row.packageId,
    name: row.nameSegment,
    vendor: row.vendorSegment,
    ...(row.latestVersion ? { latestVersion: row.latestVersion } : {}),
  }));
}

export interface WingetIndexFreshness {
  /** Rows currently in the index. 0 means the sync has never landed a run. */
  packages: number;
  /** Newest row timestamp — the last time a sync run wrote anything. */
  lastSyncedAt: string | null;
}

/**
 * Index-health probe for the winget search branch (#3602).
 *
 * The sync worker skips cleanly when GitHub rate-limits it, so a repeatedly
 * rate-limited deployment (shared egress IP, CGNAT) ends up serving an empty
 * or stale index — and an empty index looks exactly like "no matches" to the
 * caller. This lets the route distinguish the two, the way the Homebrew branch
 * already does with its `degraded` flag.
 */
export async function getWingetIndexFreshness(): Promise<WingetIndexFreshness> {
  const rows = (await db.execute(sql`
    SELECT count(*)::int AS packages, max(updated_at) AS last_synced_at
    FROM winget_package_index
  `)) as unknown as Array<{ packages: number; last_synced_at: Date | string | null }>;

  const row = rows[0];
  const raw = row?.last_synced_at ?? null;
  return {
    packages: Number(row?.packages ?? 0),
    lastSyncedAt: raw === null ? null : new Date(raw).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Homebrew
// ---------------------------------------------------------------------------

const BREW_TIMEOUT_MS = 15_000;
const BREW_CACHE_TTL_SECONDS = 6 * 60 * 60;
const BREW_MAX_BYTES = 60_000_000;

export class BrewFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrewFetchError';
  }
}

interface BrewSource {
  key: 'formula' | 'cask';
  url: string;
  redisKey: string;
}

const BREW_SOURCES: BrewSource[] = [
  { key: 'formula', url: 'https://formulae.brew.sh/api/formula.json', redisKey: 'pkgsearch:brew:formula' },
  { key: 'cask', url: 'https://formulae.brew.sh/api/cask.json', redisKey: 'pkgsearch:brew:cask' },
];

interface BrewEntry {
  token?: string;
  name?: string | string[];
  full_name?: string;
  desc?: string;
  homepage?: string;
  version?: string;
  versions?: { stable?: string };
}

const inflight = new Map<string, Promise<BrewEntry[] | null>>();

/** Test seam: drop the in-process single-flight map between tests. */
export function __resetBrewSingleFlight(): void {
  inflight.clear();
}

function parseBrewBody(body: string, source: BrewSource): BrewEntry[] {
  const parsed = JSON.parse(body);
  if (!Array.isArray(parsed)) {
    throw new BrewFetchError(`Homebrew ${source.key} index was not an array`);
  }
  return parsed as BrewEntry[];
}

async function loadBrewSource(source: BrewSource): Promise<BrewEntry[] | null> {
  const existing = inflight.get(source.key);
  if (existing) return existing;

  const promise = (async (): Promise<BrewEntry[] | null> => {
    const redis = getRedis();

    // 1. Cache.
    if (redis) {
      try {
        const cached = await redis.get(source.redisKey);
        if (cached) return parseBrewBody(cached, source);
      } catch (err) {
        console.warn('[packageSearch] brew cache read failed', {
          source: source.key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 2. Upstream.
    let body: string;
    try {
      const res = await fetch(source.url, {
        headers: { Accept: 'application/json', 'User-Agent': 'breeze-rmm-package-search' },
        signal: AbortSignal.timeout(BREW_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new BrewFetchError(`Homebrew ${source.key} index fetch failed (${res.status})`);
      }
      body = await res.text();
      if (body.length >= BREW_MAX_BYTES) {
        throw new BrewFetchError(`Homebrew ${source.key} index too large (${body.length} bytes)`);
      }
    } catch (err) {
      console.warn('[packageSearch] brew fetch failed', {
        source: source.key,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    let entries: BrewEntry[];
    try {
      entries = parseBrewBody(body, source);
    } catch (err) {
      console.warn('[packageSearch] brew index parse failed', {
        source: source.key,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    // 3. Best-effort cache write.
    if (redis) {
      try {
        await redis.setex(source.redisKey, BREW_CACHE_TTL_SECONDS, body);
      } catch (err) {
        console.warn('[packageSearch] brew cache write failed', {
          source: source.key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return entries;
  })().finally(() => {
    inflight.delete(source.key);
  });

  inflight.set(source.key, promise);
  return promise;
}

function brewDisplayName(entry: BrewEntry): string {
  if (Array.isArray(entry.name)) return entry.name[0] ?? entry.token ?? '';
  return entry.name ?? entry.token ?? '';
}

function mapBrewEntry(entry: BrewEntry, kind: 'homebrew_cask' | 'homebrew_formula'): PackageSearchResult | null {
  const packageId = entry.token ?? entry.full_name ?? (typeof entry.name === 'string' ? entry.name : undefined);
  if (!packageId) return null;
  const latestVersion = entry.versions?.stable ?? entry.version;
  return {
    platform: 'macos',
    kind,
    packageId,
    name: brewDisplayName(entry) || packageId,
    vendor: '',
    ...(latestVersion ? { latestVersion } : {}),
    ...(entry.desc ? { description: entry.desc } : {}),
    ...(entry.homepage ? { homepageUrl: entry.homepage } : {}),
  };
}

function matchesBrewQuery(entry: BrewEntry, needle: string): boolean {
  const haystack = [
    entry.token,
    entry.full_name,
    Array.isArray(entry.name) ? entry.name.join(' ') : entry.name,
    entry.desc,
  ]
    .filter((s): s is string => typeof s === 'string')
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}

export interface BrewSearchOutcome {
  results: PackageSearchResult[];
  /** True when BOTH indexes were unavailable (no cache, fetch failed). */
  degraded: boolean;
}

export async function searchHomebrew(
  q: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
): Promise<BrewSearchOutcome> {
  const needle = q.toLowerCase();
  const [formulae, casks] = await Promise.all(BREW_SOURCES.map((s) => loadBrewSource(s)));

  if (formulae === null && casks === null) {
    return { results: [], degraded: true };
  }

  const results: PackageSearchResult[] = [];
  for (const entry of casks ?? []) {
    if (!matchesBrewQuery(entry, needle)) continue;
    const mapped = mapBrewEntry(entry, 'homebrew_cask');
    if (mapped) results.push(mapped);
  }
  for (const entry of formulae ?? []) {
    if (!matchesBrewQuery(entry, needle)) continue;
    const mapped = mapBrewEntry(entry, 'homebrew_formula');
    if (mapped) results.push(mapped);
  }

  // Exact-token matches first, then prefix matches, then the rest by name.
  results.sort((a, b) => {
    const rank = (r: PackageSearchResult) =>
      r.packageId.toLowerCase() === needle ? 0 : r.packageId.toLowerCase().startsWith(needle) ? 1 : 2;
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });

  return { results: results.slice(0, limit), degraded: false };
}

// ---------------------------------------------------------------------------
// breeze-tested annotation
// ---------------------------------------------------------------------------

/**
 * Annotate winget results with version-specific "Breeze tested" evidence from
 * `third_party_package_catalog`. Raw SQL (rather than a join in the search
 * query) keeps the index search cheap and the annotation optional.
 */
export async function annotateBreezeTested(
  results: PackageSearchResult[],
): Promise<PackageSearchResult[]> {
  const ids = results.map((r) => r.packageId);
  if (ids.length === 0) return results;

  const rows = await db.execute(sql`
    SELECT package_id, last_tested_version, last_tested_at
    FROM third_party_package_catalog
    WHERE breeze_tested = true
      AND last_tested_version IS NOT NULL
      AND last_tested_at IS NOT NULL
      AND package_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
  `);

  const list: Array<Record<string, unknown>> = Array.isArray(rows)
    ? (rows as Array<Record<string, unknown>>)
    : ((rows as { rows?: Array<Record<string, unknown>> })?.rows ?? []);

  if (list.length === 0) return results;

  const tested = new Map<string, { version: string; testedAt: string }>();
  for (const row of list) {
    const packageId = row.package_id as string | undefined;
    const version = row.last_tested_version as string | undefined;
    const testedAt = row.last_tested_at as string | Date | undefined;
    if (!packageId || !version || !testedAt) continue;
    tested.set(packageId, {
      version,
      testedAt: testedAt instanceof Date ? testedAt.toISOString() : String(testedAt),
    });
  }

  return results.map((r) => {
    const hit = tested.get(r.packageId);
    return hit ? { ...r, breezeTested: hit } : r;
  });
}
