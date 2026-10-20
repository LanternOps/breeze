import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, eq, sql, asc, desc, type SQL, type Column } from 'drizzle-orm';
import { requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { db } from '../../db';
import { readOwnPartnerAxisRows } from '../../db/partnerAxisRead';
import { patches, patchApprovals, devices, devicePatches } from '../../db/schema';
import { listPatchDevicesSchema, listPatchesSchema, listSourcesSchema, patchIdParamSchema } from './schemas';
import { getPagination, inferPatchOs, resolvePartnerIdForOrg } from './helpers';
import { loadPatchInstallFailures } from '../../services/patchInstallFailures';
import {
  listOutstandingDevices,
  loadOutstandingDeviceCounts,
  resolveOutstandingDeviceScope
} from '../../services/patchOutstandingDevices';
import { catalogEffectivePatchSeveritySql } from '../../services/patchSeverityOverlay';

// Whitelist mapping sort keys (validated by listPatchesSchema) to real columns.
// Never pass raw user input into orderBy — only keys present here are honored.
// `severity` is not a column here: it sorts on the request's resolved severity
// expression (see `resolvedSeverity` in the handler), so it is mapped there.
//
// NOTE (sort semantics — read before wiring the web to these params):
//   - `severity` sorts on a `patch_severity` enum value, and Postgres orders
//     enums by declaration order (critical, important, moderate, low, unknown),
//     not alphabetically — so ascending is most-severe-first, the same order
//     as the web's semantic rank (PatchList.tsx severityRank: critical=0,
//     important=1, moderate=2, low=3). Keep the `::patch_severity` cast on the
//     resolved expression or this silently becomes an alphabetical text sort.
//   - The web also exposes `os` and `approvalStatus` as SortKeys with NO column
//     in this map; they'd need server-side support (osTypes / patch_approvals
//     join) before they can be pushed down.
const PATCH_SORT_COLUMNS: Record<string, Column> = {
  title: patches.title,
  source: patches.source,
  releaseDate: patches.releaseDate,
  createdAt: patches.createdAt
};

export const listRoutes = new Hono();

// GET /patches - List available patches
listRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  // Same RBAC bar as every sibling patch READ (compliance.ts, approvals.ts):
  // this route returns the patch inventory joined per-org, so scope alone is
  // not the gate. DEVICES_READ is granted to every device-viewing role, which
  // is exactly the population that can already see the compliance figures
  // this list backs.
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', listPatchesSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    // Check org access if specified
    if (query.orgId && !auth.canAccessOrg(query.orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    const { page, limit, offset } = getPagination(query);

    // The caller's device set: accessible orgs (auth.orgCondition), narrowed by
    // ?orgId= and the user's site restriction. Feeds both the resolved
    // severity below and the outstanding-device count (#8728), so the two
    // read the same devices. `null` = the caller can see no devices.
    const deviceScope = resolveOutstandingDeviceScope(auth, {
      orgId: query.orgId,
      allowedSiteIds: (c.get('permissions') as UserPermissions | undefined)?.allowedSiteIds
    });

    // #9387: `patches.severity` is trusted-source-only and stays 'unknown'
    // forever for microsoft/apple/linux rows, so the catalog showed almost the
    // whole Windows volume as Unrated. Resolve it the way the ring list and
    // patchEligibility.ts do — trusted value when known, otherwise the most
    // severe value the caller's own devices reported (never another tenant's:
    // the fallback is pinned to `deviceScope`). The column, the ?severity=
    // filter, and the severity sort all use this one expression, so they
    // cannot disagree.
    const resolvedSeverity = catalogEffectivePatchSeveritySql(deviceScope);

    // Build conditions
    const conditions: SQL[] = [];
    let sourcePredicate: SQL | undefined;
    if (query.source) {
      sourcePredicate = eq(patches.source, query.source);
      conditions.push(sourcePredicate);
    }
    if (query.severity) {
      conditions.push(sql`${resolvedSeverity} = ${query.severity}`);
    }
    if (query.os) {
      conditions.push(sql`${sql.param(query.os)} = ANY(${patches.osTypes})`);
    }

    // Org scoping. The `patches` table is a global vendor-published catalog
    // with no `org_id` column — the only way "patches for org X" is meaningful
    // is via the device_patches join showing which patches are present on
    // devices in that org. When the caller passes `?orgId=<uuid>`, narrow to
    // patches present on devices in that org via EXISTS. Without an explicit
    // orgId we preserve the prior behavior (full catalog for partner/system
    // scope) to keep this change minimum-risk; a follow-up can decide whether
    // partner-no-orgId callers should also auto-narrow.
    if (query.orgId) {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM ${devicePatches} dp
        INNER JOIN ${devices} d ON d.id = dp.device_id
        WHERE dp.patch_id = ${patches.id} AND d.org_id = ${query.orgId}
      )`);
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Resolve sort column/direction from the whitelisted map. Defaults preserve
    // the prior newest-first behavior when no sort params are supplied. The
    // `?? createdAt` fallback is defensive — query.sortBy is already constrained
    // to the whitelist keys by listPatchesSchema, so the lookup never misses.
    //
    // sortBy/sortDir are API-ready but NOT yet consumed by the web client: the
    // patches page (apps/web/.../PatchesPage.tsx) walks pages at `limit=200`
    // (up to its own cap) and then sorts/paginates entirely client-side, so
    // this server-side ordering is currently exercised only by direct API
    // callers. Wiring the web to send these (and thereby drop the page walk) is
    // a follow-up — see the severity NOTE on PATCH_SORT_COLUMNS
    // above before doing so.
    const sortColumn: Column | SQL = query.sortBy === 'severity'
      ? resolvedSeverity
      : (query.sortBy && PATCH_SORT_COLUMNS[query.sortBy]) || patches.createdAt;
    const sortDirection = query.sortDir ?? (query.sortBy ? 'asc' : 'desc');
    // `id` is a mandatory tiebreaker, NOT a cosmetic nicety: every sortable
    // column here has mass ties. `created_at` is `defaultNow()` and patch
    // ingest runs inside `db.transaction` (routes/agents/patches.ts), and
    // Postgres `now()` is the TRANSACTION timestamp — so all 333 patches from
    // one device's scan report share a byte-identical `created_at`. Sorting on
    // a tied key alone leaves row order undefined between two LIMIT/OFFSET
    // queries (different OFFSETs can even pick different plans), so a client
    // paging through the catalog would get some rows twice and miss others
    // entirely. That silently reproduces #3157 behind a correct-looking count.
    const orderByClause = sortDirection === 'asc'
      ? [asc(sortColumn), asc(patches.id)]
      : [desc(sortColumn), desc(patches.id)];

    // Get patches with optional approval status for the org
    const patchList = await db
      .select({
        id: patches.id,
        title: patches.title,
        description: patches.description,
        source: patches.source,
        vendor: patches.vendor,
        packageId: patches.packageId,
        version: patches.version,
        cveIds: patches.cveIds,
        severity: resolvedSeverity,
        category: patches.category,
        osTypes: patches.osTypes,
        inferredOs: sql<string | null>`(
          SELECT "devices"."os_type"
          FROM "device_patches"
          INNER JOIN "devices" ON "devices"."id" = "device_patches"."device_id"
          WHERE "device_patches"."patch_id" = "patches"."id"
          ORDER BY "device_patches"."last_checked_at" DESC NULLS LAST
          LIMIT 1
        )`,
        releaseDate: patches.releaseDate,
        requiresReboot: patches.requiresReboot,
        downloadSizeMb: patches.downloadSizeMb,
        createdAt: patches.createdAt
      })
      .from(patches)
      .where(whereClause)
      .orderBy(...orderByClause)
      .limit(limit)
      .offset(offset);

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(patches)
      .where(whereClause);

    // Per-source counts (ignores the source filter so the chips reflect
    // the full breakdown of all visible patches).
    const sourceConditions = conditions.filter((c) => c !== sourcePredicate);
    const sourceWhereClause = sourceConditions.length > 0 ? and(...sourceConditions) : undefined;
    const sourceCounts = await db
      .select({ source: patches.source, count: sql<number>`count(*)::int` })
      .from(patches)
      .where(sourceWhereClause)
      .groupBy(patches.source);
    const counts: Record<string, number> = {
      microsoft: 0,
      apple: 0,
      linux: 0,
      third_party: 0,
      custom: 0,
    };
    for (const row of sourceCounts) counts[row.source] = Number(row.count);

    // Resolve approval statuses (optionally ring-scoped). Approvals are
    // partner-scoped, so we need the caller's partner:
    //   - With ?orgId: resolve the org's partner (org access already checked above).
    //   - Without orgId (the "All orgs" partner-wide view): use the caller's own
    //     partner from their token. Gated on partner/system scope — org-scoped
    //     tokens must never read partner-wide approvals (they're 403'd on the write
    //     side too, and patch_approvals is partner-axis RLS).
    // Both paths derive the partner server-side, so the system-context read below
    // never widens tenant visibility. Without the no-orgId branch the all-orgs
    // list silently shows every patch as 'pending' on reload even though the
    // approval row exists (issue #2597).
    let approvalStatuses: Record<string, string> = {};
    const approvalPartnerId = query.orgId
      ? await resolvePartnerIdForOrg(query.orgId)
      : (auth.scope !== 'organization' ? auth.partnerId : null);
    // A partner-scoped token should always carry its own partnerId. If it
    // doesn't, the read below is skipped and every patch renders 'pending' —
    // the exact #2597 symptom via a different cause. Surface that invariant
    // violation instead of failing invisibly. (Org scope with no orgId and
    // system scope with no partnerId both legitimately yield null and are
    // silent — only the partner case is unexpected.)
    if (approvalPartnerId === null && auth.scope === 'partner') {
      console.warn(
        `[Patches] partner-scope token has null partnerId (user=${auth.user?.id ?? 'unknown'}); patch approvals will render as pending`
      );
    }
    if (approvalPartnerId !== null) {
      const approvalConditions = [eq(patchApprovals.partnerId, approvalPartnerId)];
      if (query.ringId) {
        approvalConditions.push(eq(patchApprovals.ringId, query.ringId));
      }

      // patch_approvals is partner-axis RLS with an own-partner SELECT branch
      // (#7647): readOwnPartnerAxisRows reads it on the request's own connection
      // when the ambient context covers approvalPartnerId, and only takes the
      // second-connection system escape otherwise (#7663). The partner is
      // SERVER-DERIVED (from the access-checked org, or from the caller's own
      // token) and the query stays pinned to it.
      const approvals = await readOwnPartnerAxisRows(approvalPartnerId, () =>
        db
          .select({
            patchId: patchApprovals.patchId,
            status: patchApprovals.status
          })
          .from(patchApprovals)
          .where(and(...approvalConditions))
      );

      approvalStatuses = Object.fromEntries(
        approvals.map(a => [a.patchId, a.status])
      );
    }
    // If approvalPartnerId is null (see the scope cases above) no approvals
    // apply — leave approvalStatuses empty.

    // Deployment axis (#4223): approval alone cannot say that the last install
    // attempt failed on a device (e.g. the agent's battery preflight), so the
    // list overlays the latest failed attempt and its reason per patch. Read in
    // request context — patch_job_results is device-join RLS.
    const installFailures = await loadPatchInstallFailures(
      patchList.map((patch) => patch.id),
      { orgId: query.orgId }
    );

    // Device axis (#8728): how many devices in the caller's scope still need
    // each patch on this page. One grouped query, one integer per row; the
    // hostnames are on demand from GET /patches/:id/devices, which scopes
    // through the same helper so the two cannot disagree. `deviceScope` is
    // resolved at the top of the handler (it also scopes the severity).
    const outstandingCounts = deviceScope
      ? await loadOutstandingDeviceCounts(patchList.map((patch) => patch.id), deviceScope)
      : new Map<string, number>();

    const data = patchList.map(patch => ({
      ...patch,
      os: inferPatchOs(patch.osTypes, patch.source, patch.inferredOs),
      approvalStatus: approvalStatuses[patch.id] || 'pending',
      installFailure: installFailures.get(patch.id) ?? null,
      outstandingDeviceCount: outstandingCounts.get(patch.id) ?? 0
    }));

    return c.json({
      data,
      counts,
      pagination: { page, limit, total: Number(countResult[0]?.count ?? 0) }
    });
  }
);

// GET /patches/sources - List available patch sources
listRoutes.get(
  '/sources',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listSourcesSchema),
  async (c) => {
    const sources = [
      { id: 'microsoft', name: 'Microsoft Windows Update', os: 'windows' },
      { id: 'apple', name: 'Apple Software Update', os: 'macos' },
      { id: 'linux', name: 'Linux Package Manager', os: 'linux' },
      { id: 'third_party', name: 'Third Party', os: null },
      { id: 'custom', name: 'Custom', os: null }
    ];

    const query = c.req.valid('query');
    const filtered = query.os
      ? sources.filter(s => s.os === query.os || s.os === null)
      : sources;

    return c.json({ data: filtered });
  }
);

// GET /patches/:id/devices - Devices in the caller's scope that still need the
// patch (#8728): the drill-down behind the list's outstanding device count.
listRoutes.get(
  '/:id/devices',
  requireScope('organization', 'partner', 'system'),
  // Same RBAC bar as the patch list it backs.
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', patchIdParamSchema),
  zValidator('query', listPatchDevicesSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const query = c.req.valid('query');

    if (query.orgId && !auth.canAccessOrg(query.orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    const { page, limit, offset } = getPagination(query);
    const deviceScope = resolveOutstandingDeviceScope(auth, {
      orgId: query.orgId,
      allowedSiteIds: (c.get('permissions') as UserPermissions | undefined)?.allowedSiteIds
    });
    // A patch none of the caller's devices has reported gets the same 404 as
    // one that does not exist: the catalog is global, but which patches a
    // tenant's devices carry is that tenant's data.
    if (!deviceScope) {
      return c.json({ error: 'Patch not found' }, 404);
    }

    const result = await listOutstandingDevices(id, deviceScope, { limit, offset });
    if (!result.visible) {
      return c.json({ error: 'Patch not found' }, 404);
    }

    return c.json({
      data: result.devices,
      pagination: { page, limit, total: result.total }
    });
  }
);

// GET /patches/:id - Get patch details
listRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  // Same RBAC bar as the patch list above.
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', patchIdParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');

    const [patch] = await db
      .select()
      .from(patches)
      .where(eq(patches.id, id))
      .limit(1);

    if (!patch) {
      return c.json({ error: 'Patch not found' }, 404);
    }

    return c.json(patch);
  }
);
