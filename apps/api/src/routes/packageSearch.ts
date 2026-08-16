/**
 * GET /software/package-search — typeahead over winget / Homebrew package
 * managers, backing the Task 9 "import package" modal. Mounted from
 * routes/software.ts.
 *
 * Read-only lookup against public package catalogs: no MFA, DEVICES_READ, and
 * no tenant data is involved (winget_package_index is platform-global and
 * Homebrew is fetched from formulae.brew.sh).
 */
import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { authMiddleware, requirePermission, requireScope } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import {
  DEFAULT_SEARCH_LIMIT,
  annotateBreezeTested,
  searchHomebrew,
  searchWingetIndex,
  type PackageSearchResult,
} from '../services/packageSearch';

export const packageSearchQuerySchema = z.object({
  platform: z.enum(['windows', 'macos']),
  q: z.string().min(2).max(100),
});

export const packageSearchRoutes = new Hono();
packageSearchRoutes.use('*', authMiddleware);

const requirePackageSearchRead = requirePermission(
  PERMISSIONS.DEVICES_READ.resource,
  PERMISSIONS.DEVICES_READ.action,
);

packageSearchRoutes.get(
  '/package-search',
  requireScope('organization', 'partner', 'system'),
  requirePackageSearchRead,
  zValidator('query', packageSearchQuerySchema),
  async (c) => {
    const { platform, q } = c.req.valid('query');

    if (platform === 'macos') {
      const outcome = await searchHomebrew(q, DEFAULT_SEARCH_LIMIT);
      return c.json(
        outcome.degraded ? { results: [], degraded: true as const } : { results: outcome.results },
        200,
      );
    }

    const raw = await searchWingetIndex(q, DEFAULT_SEARCH_LIMIT);
    let results: PackageSearchResult[] = raw;
    try {
      results = await annotateBreezeTested(raw);
    } catch (err) {
      // The annotation is decoration; never fail the search because the
      // catalog lookup did.
      console.warn('[packageSearch] breezeTested annotation failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return c.json({ results }, 200);
  },
);
