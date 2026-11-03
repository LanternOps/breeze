/**
 * `search_packages` (full-control W12, #6782): the AI twin of GET
 * /software/package-search — find a winget (Windows) or Homebrew (macOS)
 * package id to add as a catalog install method.
 *
 * Same services as the route: winget is a local search of the synced
 * `winget_package_index`; Homebrew is the cached formulae.brew.sh catalogue
 * (a constant upstream URL; the caller supplies only the query). Because the
 * Homebrew branch can wait on that fetch, the tool manages its own DB context
 * (#7128): no per-call transaction is held across external I/O, and the winget
 * branch opens a short caller-scoped context for its queries.
 */
import { withDbAccessContext, hasDbAccessContext } from '../db';
import { dbAccessContextFromAuth, type AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import {
  annotateBreezeTested, getWingetIndexFreshness, searchHomebrew, searchWingetIndex, type PackageSearchResult,
} from './packageSearch';
import { bounded, clampLimit, jsonError, thrown } from './aiToolsSoftwareShared';

const SEARCH_LIMIT = 25;

function inCallerContext<T>(auth: AuthContext, fn: () => Promise<T>): Promise<T> {
  return hasDbAccessContext() ? fn() : withDbAccessContext(dbAccessContextFromAuth(auth), fn);
}

export function registerPackageSearchTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('search_packages', {
    tier: 1,
    domain: 'patching',
    searchHint: 'find a winget or Homebrew package id to add to the software catalog',
    selfManagedDbContext: true,
    definition: {
      name: 'search_packages',
      description: 'Search winget (platform windows) or Homebrew (platform macos) for a package id to use as a software catalog install method. Up to 25 results.',
      input_schema: {
        type: 'object' as const,
        properties: {
          platform: { type: 'string', enum: ['windows', 'macos'], description: 'windows = winget, macos = Homebrew' },
          query: { type: 'string', description: 'Package name or id (2-100 characters)' },
          limit: { type: 'number', description: 'Max results (default 25, max 25)' },
        },
        required: ['platform', 'query'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      if (query.length < 2 || query.length > 100) return jsonError('query must be 2-100 characters', 'VALIDATION_ERROR');
      const limit = clampLimit(input.limit, SEARCH_LIMIT, SEARCH_LIMIT);
      try {
        if (input.platform === 'macos') {
          const outcome = await searchHomebrew(query, limit);
          return outcome.degraded
            ? bounded({ results: [], degraded: true, note: 'The Homebrew catalogue is unavailable right now; try again later.' })
            : bounded({ results: outcome.results });
        }
        if (input.platform !== 'windows') return jsonError('platform must be windows or macos', 'VALIDATION_ERROR');
        return await inCallerContext(auth, async () => {
          const raw = await searchWingetIndex(query, limit);
          if (raw.length === 0) {
            const freshness = await getWingetIndexFreshness();
            return freshness.packages === 0
              ? bounded({ results: [], degraded: true, note: 'The winget index has not been synced yet.' })
              : bounded({ results: [], indexUpdatedAt: freshness.lastSyncedAt });
          }
          let results: PackageSearchResult[] = raw;
          try {
            results = await annotateBreezeTested(raw);
          } catch (err) {
            // Decoration only, as in the route: never fail the search because the catalog lookup did.
            console.warn('[search_packages] breezeTested annotation failed', { error: err instanceof Error ? err.message : String(err) });
          }
          return bounded({ results });
        });
      } catch (error) {
        return thrown('search_packages', error);
      }
    },
  });
}
