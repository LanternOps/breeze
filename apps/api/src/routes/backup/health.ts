// apps/api/src/routes/backup/health.ts
/**
 * GET /backup/health/devices — the unified backup-health feed.
 *
 * NOT `/backup/health`: that path is the shipped verification/readiness summary
 * (verification.ts:69, documented in apps/docs, fetched by
 * BackupVerificationOverview.tsx:90). Hono is first-match-wins with no
 * fall-through, so re-using it here would silently blank the Verification tab.
 *
 * The handler is deliberately thin — scope in, read model out. Every rule about
 * what a row means lives in services/backupHealthReadModel.ts so the portal and
 * the posture report reach the same verdict from the same code.
 */
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import type { BackupHealth, ExternalBackupStatus } from '@breeze/shared';

import { zValidator } from '../../lib/validation';
import { db } from '../../db';
import { backupProviderConnections } from '../../db/schema';
import { requirePermission } from '../../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import {
  listBackupHealthRows,
  summarizeBackupHealth,
  type BackupHealthListOptions,
} from '../../services/backupHealthReadModel';
import { BACKUP_HEALTH_DEFAULT_LIMIT } from '../../services/backupHealthCursor';
import { emptyBackupHealthSummary } from '../../services/backupHealthRows';
import { backupHealthDevicesQuerySchema } from './schemas';

export const backupHealthRoutes = new Hono();

/**
 * The caller's site ceiling. `auth.allowedSiteIds` is primary (the auth
 * middleware always populates it); the `permissions` fallback exists because
 * `c.get('permissions')` is only set by `requirePermission`. Reading both can
 * only ever make this stricter. Mirrors verification.ts:47-52 — duplicated
 * rather than exported from there because that helper is file-local and the
 * duplication keeps the literal `allowedSiteIds` token in THIS handler, which
 * is what __tests__/helpers/routeScan.ts:233 scans for.
 */
function callerAllowedSiteIds(
  auth: { allowedSiteIds?: string[] } | undefined,
  c: { get(key: 'permissions'): unknown },
): string[] | undefined {
  return auth?.allowedSiteIds ?? (c.get('permissions') as UserPermissions | undefined)?.allowedSiteIds;
}

backupHealthRoutes.get(
  '/health/devices',
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  zValidator('query', backupHealthDevicesQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    // Org scope. An explicit ?orgId must be accessible — pre-checking rather
    // than leaning on RLS means the caller learns the filter was rejected
    // instead of reading an empty fleet as "all clear".
    let orgIds: string[];
    if (query.orgId) {
      if (!auth.canAccessOrg(query.orgId)) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
      orgIds = [query.orgId];
    } else if (Array.isArray(auth.accessibleOrgIds)) {
      orgIds = auth.accessibleOrgIds;
    } else {
      // system scope: accessibleOrgIds === null means "all orgs" with no finite
      // list. Rather than invent an unbounded cross-partner scan, ask for one.
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const siteIds = callerAllowedSiteIds(auth, c);
    const summary = emptyBackupHealthSummary();

    if (orgIds.length === 0 || siteIds?.length === 0) {
      // A caller who can see nothing has not observed a healthy fleet; the
      // all-zero summary says exactly that.
      return c.json({ data: { rows: [], summary, nextCursor: null, stale: false, unmappedDevices: 0 } });
    }

    const opts: BackupHealthListOptions = {
      sources: query.source as Array<'breeze' | 'provider'> | undefined,
      // The Cove-email default: rows with backup evidence. The overview's
      // "Include devices without any backup" toggle sends withBackup=false.
      onlyWithBackup: query.withBackup ?? true,
      filter: {
        health: query.health as BackupHealth[] | undefined,
        status: query.status as ExternalBackupStatus[] | undefined,
        search: query.search,
      },
      page: { limit: query.limit ?? BACKUP_HEALTH_DEFAULT_LIMIT, cursor: query.cursor ?? null },
    };
    const scope = { orgIds, siteIds };

    const [page, totals, unmappedDevices] = await Promise.all([
      listBackupHealthRows(scope, opts),
      summarizeBackupHealth(scope, { sources: opts.sources, onlyWithBackup: opts.onlyWithBackup, filter: opts.filter }),
      resolveUnmappedDevices(auth),
    ]);

    return c.json({
      data: {
        rows: page.rows,
        summary: totals,
        nextCursor: page.nextCursor,
        // Drives the overview's "data as of" banner. True when ANY row on this
        // page is backed by evidence we no longer trust.
        stale: page.rows.some((row: { stale: boolean }) => row.stale),
        unmappedDevices,
      },
    });
  },
);

/**
 * "N devices under unmapped customers" — the Huntress-style honesty counter, so
 * a partner-wide view never implies complete vendor coverage.
 *
 * `backup_provider_connections` is partner-axis, so this is meaningful only for
 * a partner/system caller; an org token would read zero rows through RLS
 * anyway, and short-circuiting saves the round-trip.
 */
async function resolveUnmappedDevices(auth: { scope: string; partnerId: string | null }): Promise<number> {
  if (auth.scope !== 'partner' && auth.scope !== 'system') return 0;
  if (!auth.partnerId) return 0;
  const rows = (await db
    .select({
      unmapped: backupProviderConnections.lastSyncUnmappedDevices,
    })
    .from(backupProviderConnections)
    .where(
      and(eq(backupProviderConnections.partnerId, auth.partnerId), eq(backupProviderConnections.isActive, true)),
    )) as Array<{ unmapped: number | null }>;
  return rows.reduce((sum, row) => sum + (row.unmapped ?? 0), 0);
}
