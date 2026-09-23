import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, eq, or, sql, desc, inArray, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { reports, reportRuns } from '../../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { auditSensitiveRead } from '../../services/sensitiveReadAudit';
import { PERMISSIONS } from '../../services/permissions';
import { canManagePartnerWidePolicies } from '../../services/partnerWideAccess';
import {
  assertReportExecutionPreflight,
  assertReportOwnerScopeSupported,
  generateReport,
  previousBaselineFor,
  StoredArtifactOnlyReportError,
  UnexecutableReportScopeError,
  UnsupportedReportScopeError,
  type ReportResult,
} from '../../services/reportGenerationService';
import { organizationScope } from '../../services/reportScope';
import { rowsToCsv, rowsToTsv } from '@breeze/shared';
import {
  getPagination, getReportWithOrgCheck, getReportRunWithOrgCheck, isPortalSelfServiceLocked,
  isSystemManagedReportDefinition, PARTNER_OWNED_REPORT, partnerOwnedReportVisibility,
  partnerWideListTarget,
  PORTAL_SELF_SERVICE_REPORT,
} from './helpers';
import { downloadQuerySchema, listRunsSchema } from './schemas';
// Execution plane W05 (spec §6.3) — attach an analysis artifact by reference.
import { z } from 'zod';
import {
  decodeSiteScope,
  intersectSiteScopes,
  isSiteScopeSubset,
  persistedSiteScopeValues,
  reportRunMultiOrgScopeSqlPredicate,
  reportRunScopeSqlPredicate,
  resolveRequestReportAuthority,
  resolveRequestReportAuthorityMap,
  siteScopeFingerprint,
  unrestrictedReportRunScopeSqlPredicate,
  type LiveSiteScopeV1,
  type PersistedSiteScopeColumns,
  type ReportExecutionAuthority,
  type ReportOwner,
} from '../../services/siteScope';

export const runsRoutes = new Hono();

runsRoutes.use('*', authMiddleware);

function asStoredReportResult(value: unknown): ReportResult | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.rows !== undefined && !Array.isArray(candidate.rows)) return null;
  if (
    candidate.summary !== undefined
    && (candidate.summary === null || typeof candidate.summary !== 'object' || Array.isArray(candidate.summary))
  ) {
    return null;
  }
  return candidate as ReportResult;
}

function hasMeaningfulReportContent(result: ReportResult): boolean {
  const hasRows = Array.isArray(result.rows) && result.rows.length > 0;
  const hasSummary = result.summary !== undefined && Object.keys(result.summary).length > 0;
  return hasRows || hasSummary;
}

// POST /reports/:id/generate - Generate report now
runsRoutes.post(
  '/:id/generate',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.REPORTS_WRITE.resource, PERMISSIONS.REPORTS_WRITE.action),
  async (c) => {
    const auth = c.get('auth');
    const reportId = c.req.param('id')!;

    const report = await getReportWithOrgCheck(reportId, auth);
    if (!report) {
      return c.json({ error: 'Report not found' }, 404);
    }

    // P2-3 (#4190) — a system-managed definition has NO acting user to execute
    // as, and the agent scheduler owns when it runs. Refused before the
    // authority resolution below, which would otherwise resolve the CALLER as
    // the principal for a report they do not own. 409, not 403: the caller's
    // permissions are fine (they can read and download this very report) —
    // it is the report that cannot be generated on request.
    if (isSystemManagedReportDefinition(report)) {
      return c.json({ error: 'system_managed_report' }, 409);
    }

    // #3198 W01 — a partner-owned definition reached here only through
    // getReportWithOrgCheck's partner-wide gate + live partner authority.
    // No type has a partner-scope generator this wave, so it is refused
    // before any run row is created.
    if (report.owner.partnerId !== undefined) {
      // Defense in depth: getReportWithOrgCheck already returns null for a
      // partner-owned row unless the caller may administer partner-wide state.
      if (!canManagePartnerWidePolicies(auth)) {
        return c.json({ error: 'Report not found' }, 404);
      }
      try {
        assertReportOwnerScopeSupported(report.type, report.owner);
      } catch (error) {
        if (error instanceof UnsupportedReportScopeError) {
          return c.json({ error: 'unsupported_report_scope', type: report.type }, 400);
        }
        throw error;
      }
      // W02 lands partner-owned generation here; until then the guard above
      // always throws, and this refusal only keeps the org path below typed.
      return c.json({ error: 'unsupported_report_scope', type: report.type }, 400);
    }
    const orgId = report.owner.orgId;

    // #4562 W10 — the canonical customer-portal definition is generated only
    // by the customer, under a `portal_user` authority that is always
    // org-unrestricted. A run created HERE would carry this caller's (possibly
    // site-restricted) scope and still be listed by the portal as the
    // customer's own report. Refused while the portal exposes reports.
    if (await isPortalSelfServiceLocked(db, report)) {
      return c.json(PORTAL_SELF_SERVICE_REPORT, 409);
    }

    const liveResult = await resolveRequestReportAuthority(
      auth,
      orgId,
      'read',
    );
    if (!liveResult.ok || liveResult.authority.scope.kind === 'legacy_unscoped') {
      return c.json({ error: 'Access to report scope denied' }, 403);
    }

    let executionAuthority: ReportExecutionAuthority;
    try {
      const persistedScope = decodeSiteScope(
        report as unknown as PersistedSiteScopeColumns,
        orgId,
      );
      const effectiveScope = intersectSiteScopes(
        persistedScope,
        liveResult.authority.scope,
      );
      if (
        !effectiveScope
        || effectiveScope.kind === 'legacy_unscoped'
        || (effectiveScope.kind === 'restricted' && effectiveScope.siteIds.length === 0)
      ) {
        return c.json({ error: 'Access to report scope denied' }, 403);
      }
      executionAuthority = {
        principalKind: 'user',
        scope: effectiveScope,
        principalUserId: liveResult.authority.principalUserId,
        capturedAt: liveResult.authority.capturedAt,
        fingerprint: siteScopeFingerprint(effectiveScope),
      };
    } catch {
      return c.json({ error: 'Report not found' }, 404);
    }

    const config = (report.config ?? {}) as Record<string, unknown>;
    try {
      assertReportExecutionPreflight({ orgId }, config, executionAuthority);
    } catch (error) {
      if (error instanceof UnexecutableReportScopeError) {
        return c.json({ error: 'Access to report scope denied' }, 403);
      }
      throw error;
    }

    // Create a new report run
    const [run] = await db
      .insert(reportRuns)
      .values({
        reportId: report.id,
        status: 'pending',
        startedAt: new Date(),
        requestedByKind: 'user',
        requestedByUserId: auth.user.id,
        requestedByPortalUserId: null,
        ...persistedSiteScopeValues(executionAuthority),
      })
      .returning();

    if (!run) {
      return c.json({ error: 'Failed to create report run' }, 500);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'report.generate',
      resourceType: 'report_run',
      resourceId: run.id,
      resourceName: report.name,
      details: { reportId: report.id }
    });

    await db
      .update(reports)
      .set({ lastGeneratedAt: new Date(), updatedAt: new Date() })
      .where(eq(reports.id, reportId));

    try {
      const result = await generateReport(
        report.type,
        organizationScope(orgId),
        config,
        executionAuthority,
      );
      const previous = await previousBaselineFor(
        report.id,
        executionAuthority.fingerprint,
      );
      if (previous) result.previous = previous;
      const rowCount = result.rowCount ?? (Array.isArray(result.rows) ? result.rows.length : 0);
      await db
        .update(reportRuns)
        .set({
          status: 'completed',
          completedAt: new Date(),
          outputUrl: `/api/reports/runs/${run.id}/download`,
          result,
          rowCount
        })
        .where(eq(reportRuns.id, run.id));
      return c.json({ message: 'Report generated', runId: run.id, status: 'completed' });
    } catch (err) {
      await db
        .update(reportRuns)
        .set({
          status: 'failed',
          completedAt: new Date(),
          // #3198 W01 — same stable reason the schedule worker records.
          errorMessage: err instanceof UnsupportedReportScopeError
            ? 'unsupported_report_scope'
            : err instanceof Error ? err.message : 'Failed to generate report'
        })
        .where(eq(reportRuns.id, run.id));
      // P2-3 (#4190) — belt to the braces of the `isSystemManagedReportDefinition`
      // gate above, which today refuses every stored-artifact type before this
      // point (its `type` leg matches `ai_org_narrative` regardless of
      // principal). Kept so a FUTURE stored-artifact type that is not
      // system-managed surfaces as a 409 the first time someone presses
      // Generate, instead of a 500 with "Invalid report type" in the run row.
      if (err instanceof StoredArtifactOnlyReportError) {
        return c.json({ error: 'stored_artifact_only' }, 409);
      }
      // #3198 W01 — an org-owned business-type definition before W02 ships
      // its generator. The run row records the failure; the caller gets 400.
      if (err instanceof UnsupportedReportScopeError) {
        return c.json({ error: 'unsupported_report_scope', type: report.type, runId: run.id }, 400);
      }
      return c.json({ message: 'Report generation failed', runId: run.id, status: 'failed' }, 500);
    }
  }
);

// GET /reports/runs - List recent report runs
runsRoutes.get(
  '/runs',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.REPORTS_READ.resource, PERMISSIONS.REPORTS_READ.action),
  zValidator('query', listRunsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const conditions: SQL<unknown>[] = [];
    let runScopePredicate: SQL<unknown>;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      const result = await resolveRequestReportAuthority(auth, auth.orgId, 'read');
      if (!result.ok || result.authority.scope.kind === 'legacy_unscoped') {
        return c.json({ data: [], pagination: { page, limit, total: 0 } });
      }
      conditions.push(eq(reports.orgId, auth.orgId));
      runScopePredicate = reportRunScopeSqlPredicate(
        reportRuns,
        result.authority.scope,
      );
    } else if (auth.scope === 'partner') {
      const orgIds = auth.accessibleOrgIds ?? [];
      const authorityMap = await resolveRequestReportAuthorityMap(
        auth,
        orgIds,
        'read',
      );
      const scopes: LiveSiteScopeV1[] = [];
      for (const result of authorityMap.values()) {
        if (result.ok && result.authority.scope.kind !== 'legacy_unscoped') {
          scopes.push(result.authority.scope);
        }
      }
      const orgCondition = orgIds.length > 0
        ? inArray(reports.orgId, orgIds)
        : sql<unknown>`FALSE`;
      // #3198 W01: partner-owned runs join the list only for a caller who may
      // administer partner-wide state (same rule as the definition list).
      const partnerWide = partnerWideListTarget(auth);
      conditions.push(
        partnerWide
          ? or(orgCondition, partnerOwnedReportVisibility(auth))!
          : orgCondition,
      );
      runScopePredicate = reportRunMultiOrgScopeSqlPredicate(
        reports.orgId,
        reportRuns,
        scopes,
        // Spread, not a trailing `undefined`: an org-axis caller's call is
        // exactly the pre-W01 three-argument call.
        ...(partnerWide ? [partnerWide] : []),
      );
    } else {
      runScopePredicate = unrestrictedReportRunScopeSqlPredicate(reportRuns);
    }

    conditions.push(runScopePredicate);

    // Additional filters
    if (query.reportId) {
      conditions.push(eq(reportRuns.reportId, query.reportId));
    }

    if (query.status) {
      conditions.push(eq(reportRuns.status, query.status));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(reportRuns)
      .innerJoin(reports, eq(reportRuns.reportId, reports.id))
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get runs with report info
    const runsList = await db
      .select({
        id: reportRuns.id,
        reportId: reportRuns.reportId,
        status: reportRuns.status,
        startedAt: reportRuns.startedAt,
        completedAt: reportRuns.completedAt,
        outputUrl: reportRuns.outputUrl,
        errorMessage: reportRuns.errorMessage,
        rowCount: reportRuns.rowCount,
        createdAt: reportRuns.createdAt,
        reportName: reports.name,
        reportType: reports.type
      })
      .from(reportRuns)
      .innerJoin(reports, eq(reportRuns.reportId, reports.id))
      .where(whereCondition)
      .orderBy(desc(reportRuns.createdAt), desc(reportRuns.id))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: runsList,
      pagination: { page, limit, total }
    });
  }
);

// GET /reports/runs/:id/download - Download a completed run's stored snapshot
runsRoutes.get(
  '/runs/:id/download',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.REPORTS_EXPORT.resource, PERMISSIONS.REPORTS_EXPORT.action),
  zValidator('query', downloadQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const runId = c.req.param('id')!;
    const { format: requestedFormat } = c.req.valid('query');

    const access = await getReportRunWithOrgCheck(runId, auth, 'export');
    if (!access) {
      return c.json({ error: 'Report run not found' }, 404);
    }

    const [row] = await db
      .select({
        id: reportRuns.id,
        reportId: reportRuns.reportId,
        orgId: reports.orgId,
        partnerId: reports.partnerId,
        status: reportRuns.status,
        result: reportRuns.result,
        reportType: reports.type,
        reportName: reports.name,
        reportFormat: reports.format,
        executionScopeVersion: reportRuns.executionScopeVersion,
        executionScopeKind: reportRuns.executionScopeKind,
        executionScopeSiteIds: reportRuns.executionScopeSiteIds,
        executionScopeUserId: reportRuns.executionScopeUserId,
        executionScopeFingerprint: reportRuns.executionScopeFingerprint,
        executionScopeCapturedAt: reportRuns.executionScopeCapturedAt,
        executionScopePrincipalKind: reportRuns.executionScopePrincipalKind,
      })
      .from(reportRuns)
      .innerJoin(reports, eq(reportRuns.reportId, reports.id))
      .where(and(
        eq(reportRuns.id, runId),
        access.ownerCondition,
        access.runScopePredicate,
      ))
      .limit(1);

    if (!row || !runPayloadMatchesAuthority(row, access.owner, access.authority.scope)) {
      return c.json({ error: 'Report run not found' }, 404);
    }
    if (row.status !== 'completed') {
      return c.json({ error: 'Report run is not completed' }, 409);
    }

    const result = asStoredReportResult(row?.result);
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    const format = requestedFormat ?? row?.reportFormat ?? 'csv';
    const dateStr = new Date().toISOString().split('T')[0];
    const baseName = `${row?.reportType ?? 'report'}-report-${dateStr}`;

    // PDF / JSON: hand the snapshot to the client to render (avoids a server PDF engine).
    if (format === 'pdf' || format === 'json') {
      if (!result || !hasMeaningfulReportContent(result)) {
        return c.json({ error: 'Report run has no result data to download' }, 409);
      }
      const payload = { type: row?.reportType, format, data: result };
      const body = JSON.stringify(payload);
      c.header('Content-Type', 'application/json; charset=UTF-8');
      auditSensitiveRead(c, {
        action: 'report.run.download',
        orgId: row.orgId,
        ...(row.partnerId ? { partnerId: row.partnerId } : {}),
        resourceType: 'report_run',
        resourceId: runId,
        format,
        rowCount: rows.length,
        byteCount: Buffer.byteLength(body, 'utf8'),
      });
      return c.body(body);
    }

    if (rows.length === 0) {
      return c.json({ error: 'Report run has no tabular data to download' }, 409);
    }

    if (format === 'excel') {
      const body = rowsToTsv(rows);
      c.header('Content-Type', 'application/vnd.ms-excel');
      c.header('Content-Disposition', `attachment; filename="${baseName}.xls"`);
      auditSensitiveRead(c, {
        action: 'report.run.download',
        orgId: row.orgId,
        ...(row.partnerId ? { partnerId: row.partnerId } : {}),
        resourceType: 'report_run',
        resourceId: runId,
        format,
        rowCount: rows.length,
        byteCount: Buffer.byteLength(body, 'utf8'),
      });
      return c.body(body);
    }

    const body = rowsToCsv(rows);
    c.header('Content-Type', 'text/csv;charset=utf-8;');
    c.header('Content-Disposition', `attachment; filename="${baseName}.csv"`);
    auditSensitiveRead(c, {
      action: 'report.run.download',
      orgId: row.orgId,
      ...(row.partnerId ? { partnerId: row.partnerId } : {}),
      resourceType: 'report_run',
      resourceId: runId,
      format,
      rowCount: rows.length,
      byteCount: Buffer.byteLength(body, 'utf8'),
    });
    return c.body(body);
  }
);

// GET /reports/runs/:id - Get run with download URL
runsRoutes.get(
  '/runs/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.REPORTS_READ.resource, PERMISSIONS.REPORTS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const runId = c.req.param('id')!;

    const access = await getReportRunWithOrgCheck(runId, auth, 'read');
    if (!access) {
      return c.json({ error: 'Report run not found' }, 404);
    }

    const [run] = await db
      .select({
        id: reportRuns.id,
        reportId: reportRuns.reportId,
        orgId: reports.orgId,
        partnerId: reports.partnerId,
        status: reportRuns.status,
        startedAt: reportRuns.startedAt,
        completedAt: reportRuns.completedAt,
        outputUrl: reportRuns.outputUrl,
        errorMessage: reportRuns.errorMessage,
        rowCount: reportRuns.rowCount,
        createdAt: reportRuns.createdAt,
        executionScopeVersion: reportRuns.executionScopeVersion,
        executionScopeKind: reportRuns.executionScopeKind,
        executionScopeSiteIds: reportRuns.executionScopeSiteIds,
        executionScopeUserId: reportRuns.executionScopeUserId,
        executionScopeFingerprint: reportRuns.executionScopeFingerprint,
        executionScopeCapturedAt: reportRuns.executionScopeCapturedAt,
        executionScopePrincipalKind: reportRuns.executionScopePrincipalKind,
        reportName: reports.name,
        reportType: reports.type,
        reportFormat: reports.format,
      })
      .from(reportRuns)
      .innerJoin(reports, eq(reportRuns.reportId, reports.id))
      .where(and(
        eq(reportRuns.id, runId),
        access.ownerCondition,
        access.runScopePredicate,
      ))
      .limit(1);

    if (!run || !runPayloadMatchesAuthority(run, access.owner, access.authority.scope)) {
      return c.json({ error: 'Report run not found' }, 404);
    }

    return c.json({
      ...run,
      report: {
        id: run.reportId,
        name: run.reportName,
        type: run.reportType,
        format: run.reportFormat,
      },
    });
  }
);

/**
 * POST /reports/runs/:id/attachments/from-artifact — link an AI run artifact to
 * a report run (execution-plane spec §6.3).
 *
 * `report_runs` stores no file of its own today: it keeps the data snapshot in
 * `result` jsonb and renders PDF/CSV on demand. This link is therefore the FIRST
 * way a report run can carry a produced file, and it carries it by reference —
 * the artifact's own 30-day retention applies, and `ON DELETE SET NULL` means an
 * expired artifact leaves the run readable with nothing attached.
 *
 * Tenancy rides `getReportRunWithOrgCheck`, the same guard every other run route
 * here uses: `report_runs` has no `org_id` of its own, and that helper is what
 * joins to `reports`, applies the caller's org axis AND re-checks the run's
 * persisted site scope against the caller's live authority. An ad-hoc join would
 * have reproduced the org half and silently dropped the site half.
 *
 * Gated on REPORTS_WRITE, and the authority is resolved for the `write` action:
 * attaching a file to a run is a change to what that report shows a customer.
 */
runsRoutes.post(
  '/runs/:id/attachments/from-artifact',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.REPORTS_WRITE.resource, PERMISSIONS.REPORTS_WRITE.action),
  zValidator('json', z.object({ handle: z.string().guid() })),
  async (c) => {
    const auth = c.get('auth');
    const runId = c.req.param('id')!;
    const { handle } = c.req.valid('json');

    const access = await getReportRunWithOrgCheck(runId, auth, 'write');
    if (!access) {
      return c.json({ error: 'Report run not found' }, 404);
    }
    // #3198 W01 — AI run artifacts are org-scoped (`resolveArtifact` keys on
    // an org), so a partner-owned run has nothing it could attach.
    if (access.owner.partnerId !== undefined) {
      return c.json(PARTNER_OWNED_REPORT, 409);
    }
    const { metadata } = access;
    const orgId = access.owner.orgId;

    // Imported LAZILY: `artifactService` reads `aiRunArtifacts` off the
    // `db/schema` barrel, and this module is in the static graph of the whole
    // reports route surface. A top-level import puts that table into every
    // reports suite's module graph and breaks the ones whose partial
    // `vi.mock('../../db/schema')` factories do not declare it. Same reason
    // routes/tickets/attachments.ts and ticketAttachmentStorage defer it.
    const { resolveArtifact } = await import('../../services/artifacts/artifactService');
    const artifact = await resolveArtifact(handle, { orgId });
    if (!artifact) {
      return c.json(
        { error: 'No such artifact is available to this organization', code: 'ARTIFACT_NOT_FOUND' },
        404,
      );
    }

    await db
      .update(reportRuns)
      .set({ artifactId: artifact.id })
      .where(eq(reportRuns.id, metadata.id));

    writeRouteAudit(c, {
      orgId,
      action: 'report_run.artifact.attach',
      resourceType: 'report_run',
      resourceId: metadata.id,
      details: { artifactId: artifact.id, runId: artifact.runId, byteSize: artifact.bytes },
    });

    return c.json({ data: { runId: metadata.id, artifactId: artifact.id } });
  },
);

function runPayloadMatchesAuthority(
  row: object,
  owner: ReportOwner,
  currentScope: LiveSiteScopeV1,
): boolean {
  try {
    return isSiteScopeSubset(
      decodeSiteScope(
        row as unknown as PersistedSiteScopeColumns,
        owner.partnerId !== undefined ? owner : owner.orgId,
      ),
      currentScope,
    );
  } catch {
    return false;
  }
}
