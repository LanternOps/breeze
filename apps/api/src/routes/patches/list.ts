import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, eq, sql, asc, desc, type SQL, type Column } from 'drizzle-orm';
import { requireScope } from '../../middleware/auth';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { patches, patchApprovals, devices, devicePatches } from '../../db/schema';
import { listPatchesSchema, listSourcesSchema, patchIdParamSchema } from './schemas';
import { getPagination, inferPatchOs, resolvePartnerIdForOrg } from './helpers';

// Whitelist mapping sort keys (validated by listPatchesSchema) to real columns.
// Never pass raw user input into orderBy — only keys present here are honored.
//
// NOTE (sort divergence — read before wiring the web to these params):
//   - `severity` here sorts ALPHABETICALLY (asc(patches.severity)). The web
//     (PatchList.tsx severityRank/approvalRank) sorts by SEMANTIC priority
//     (critical=0, important=1, moderate=2, low=3). Whoever later sends
//     sortBy/sortDir from fetchPatches must reconcile these — either map the
//     web's priority order onto a CASE expression here, or drop the client-side
//     rank — or severity sort will silently change meaning.
//   - The web also exposes `os` and `approvalStatus` as SortKeys with NO column
//     in this map; they'd need server-side support (osTypes / patch_approvals
//     join) before they can be pushed down.
const PATCH_SORT_COLUMNS: Record<string, Column> = {
  title: patches.title,
  severity: patches.severity,
  source: patches.source,
  releaseDate: patches.releaseDate,
  createdAt: patches.createdAt
};

export const listRoutes = new Hono();

// GET /patches - List available patches
listRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listPatchesSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    // Check org access if specified
    if (query.orgId && !auth.canAccessOrg(query.orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    const { page, limit, offset } = getPagination(query);

    // Build conditions
    const conditions: SQL[] = [];
    let sourcePredicate: SQL | undefined;
    if (query.source) {
      sourcePredicate = eq(patches.source, query.source);
      conditions.push(sourcePredicate);
    }
    if (query.severity) {
      conditions.push(eq(patches.severity, query.severity));
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
    // patches page (apps/web/.../PatchesPage.tsx) fetches a fixed `limit=200`
    // and sorts/paginates entirely client-side, so this server-side ordering is
    // currently exercised only by direct API callers. Wiring the web to send
    // these is a follow-up — see the severity-divergence NOTE on
    // PATCH_SORT_COLUMNS above before doing so.
    const sortColumn = (query.sortBy && PATCH_SORT_COLUMNS[query.sortBy]) || patches.createdAt;
    const sortDirection = query.sortDir ?? (query.sortBy ? 'asc' : 'desc');
    const orderByClause = sortDirection === 'asc' ? asc(sortColumn) : desc(sortColumn);

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
        severity: patches.severity,
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
      .orderBy(orderByClause)
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

      // patch_approvals is partner-axis RLS; org-scoped callers cannot read it
      // in request context (accessiblePartnerIds=[]). The partner is SERVER-DERIVED
      // (from the access-checked org, or from the caller's own token), so system
      // context is safe.
      const approvals = await runOutsideDbContext(() =>
        withSystemDbAccessContext(() =>
          db
            .select({
              patchId: patchApprovals.patchId,
              status: patchApprovals.status
            })
            .from(patchApprovals)
            .where(and(...approvalConditions))
        )
      );

      approvalStatuses = Object.fromEntries(
        approvals.map(a => [a.patchId, a.status])
      );
    }
    // If approvalPartnerId is null (see the scope cases above) no approvals
    // apply — leave approvalStatuses empty.

    const data = patchList.map(patch => ({
      ...patch,
      os: inferPatchOs(patch.osTypes, patch.source, patch.inferredOs),
      approvalStatus: approvalStatuses[patch.id] || 'pending'
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

// GET /patches/:id - Get patch details
listRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
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
