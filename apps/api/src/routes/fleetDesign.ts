/**
 * Fleet Designer W01 (#5651), Task 12 — the human-facing surface for a Fleet
 * Design: start one manually, list the org's stored designs, and read one
 * back for the report-detail page / PDF download.
 *
 * This is a NEW permission surface, so it mirrors `routes/aiAgents.ts`'s
 * `POST /:id/runs` manual-trigger route as closely as the shapes allow
 * (same scope/permission/MFA gates, same `createAndEnqueueAgentRun` admission
 * call, same audit-every-outcome posture) rather than inventing a new
 * pattern. Differences from that route, and why:
 *
 *  - There is no `:id` agent row to load first — a Fleet Design always runs
 *    the ORG's effective `designer` agent, resolved the same way the
 *    schedule fan-out and every other kind-scoped admission path does
 *    (`resolveEffectiveAgent`). `createAndEnqueueAgentRun` (via
 *    `resolveEffectiveAgentSystem`) re-resolves and enforces `enabled` /
 *    `mode !== 'off'` again at admission time — the same
 *    check-then-admit gap every other manual-trigger route already lives
 *    with (the row can flip between the read here and the row
 *    `createAndEnqueueAgentRun` reads). Because `designer` is restricted to
 *    `off|act` only (`packages/shared/src/types/aiAgents.ts`'s
 *    `supportedModesForKind`), a `mode !== 'off'` designer agent is
 *    ALWAYS `act` — there is no separate `mode === 'act'` check to add here;
 *    the existing `mode_off` skip already is the act-only gate for this kind.
 *  - The route's own stated interface (spec/plan Task 12) answers a declined
 *    admission with 200 `{skipped}`, not the 409 `run_skipped` the device
 *    manual-trigger route uses — a Fleet Design has no device-scoped retry
 *    story, so "nothing was queued, here is why" is treated as a normal
 *    (non-error) outcome for this route specifically.
 *  - Device-bound routes 404 to hide access denial from a cross-tenant
 *    probe; the same posture applies here to `orgId` (and, when supplied,
 *    `siteId` — verified to belong to `orgId` before it is trusted into
 *    `triggerRef.siteId`, which `runLoop.ts` reads to scope the design's
 *    evidence bundle).
 */
import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import {
  enableFleetDesignerSchema,
  fleetDesignApprovalSchema,
  triggerFleetDesignRunSchema,
  type FleetDesignReportSummary,
} from '@breeze/shared';
import { zValidator } from '../lib/validation';
import { db } from '../db';
import { reportRuns, reports, sites } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { PERMISSIONS, hasPermission, type UserPermissions } from '../services/permissions';
import { PartnerWideWriteDeniedError } from '../services/partnerWideAccess';
import { applyFleetDesign } from '../services/fleetDesign/apply';
import { loadLedger, toLedgerItem } from '../services/fleetDesign/ledger';
import { FleetDesignApplyError, previewFleetDesignApply } from '../services/fleetDesign/preview';
import { rollbackFleetDesign } from '../services/fleetDesign/rollback';
import { fileFleetDesignDocument } from '../services/fleetDesign/documents';
import { DesignerEnableError, describeDesignerSetup, enableDesigner } from '../services/fleetDesign/designerSetup';
import { resolveEffectiveAgent } from '../services/aiAgents/effectivePolicy';
import { createAndEnqueueAgentRun } from '../services/aiAgents/runService';
import { FLEET_DESIGN_REPORT_TYPE, loadFleetDesignReport } from '../services/aiAgents/fleetDesignReport';
import { writeRouteAudit } from '../services/auditEvents';
import { captureException } from '../services/sentry';

export const fleetDesignRoutes = new Hono();
fleetDesignRoutes.use('*', authMiddleware);

const UUID = z.string().uuid();

/** Same posture as `routes/aiAgents.ts`'s `uuidParam`: an unparseable id reads
 *  as `null`, which every caller here maps to the same 404 a valid-but-
 *  inaccessible id gets — never a distinct "malformed" signal. */
function uuidParam(c: Context, name: string): string | null {
  const parsed = UUID.safeParse(c.req.param(name));
  return parsed.success ? parsed.data : null;
}

const scopes = requireScope('organization', 'partner', 'system');
const requireAiRead = requirePermission(PERMISSIONS.AI_AGENTS_READ.resource, PERMISSIONS.AI_AGENTS_READ.action);
const requireAiWrite = requirePermission(PERMISSIONS.AI_AGENTS_WRITE.resource, PERMISSIONS.AI_AGENTS_WRITE.action);
// Apply writes configuration policies and device groups — both gated on
// devices:write everywhere else (routes/configurationPolicies/crud.ts,
// routes/groups.ts). Step 4 (W04) also creates scripts, so an approval that
// carries automation refs additionally needs scripts:write — the permission
// POST /scripts and the bundle importer require (see canWriteScripts).
const requireDevicesWrite = requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);
// Filing the design in the org's document library writes an org_documents
// row — the same gate `routes/orgDocuments.ts` puts on an upload.
const requireDocumentsWrite = requirePermission(PERMISSIONS.DOCUMENTS_WRITE.resource, PERMISSIONS.DOCUMENTS_WRITE.action);

/**
 * scripts:write, read from the permissions `requireDevicesWrite` just resolved
 * for this org/partner. Absent permissions read as "no" (fail closed).
 */
function canWriteScripts(c: Context): boolean {
  const perms = c.get('permissions') as UserPermissions | undefined;
  return !!perms && hasPermission(perms, PERMISSIONS.SCRIPTS_WRITE.resource, PERMISSIONS.SCRIPTS_WRITE.action);
}

/**
 * Apply and rollback touch every device a function names, so they need an
 * org-unrestricted site authority: a site-restricted caller
 * (`permissions.allowedSiteIds` set) is refused before any service call —
 * the same read the groups route makes at routes/groups.ts:447.
 */
/**
 * Whether the caller carries `contracts:write` — the permission every other
 * deliverable-evidence route requires. `requirePermission` already resolved
 * and cached the caller's org-scoped permissions on the context, so this is a
 * pure read, never a second lookup.
 */
function callerCanWriteContracts(c: Context): boolean {
  const perms = c.get('permissions') as UserPermissions | undefined;
  return perms
    ? hasPermission(perms, PERMISSIONS.CONTRACTS_WRITE.resource, PERMISSIONS.CONTRACTS_WRITE.action)
    : false;
}

function siteRestricted(c: Context): boolean {
  const perms = c.get('permissions') as UserPermissions | undefined;
  return Array.isArray(perms?.allowedSiteIds);
}

/** #6214: every refusal the enable path can raise, by HTTP class. `detail`
 *  (the `missing` list, the invalid recipient ids) is spread so the page
 *  can say what to fix rather than just that something is wrong. */
const DESIGNER_ENABLE_STATUS: Record<DesignerEnableError['code'], 403 | 409 | 422> = {
  partner_scope_required: 403,
  partner_admin_required: 403,
  kill_switch_off: 409,
  agent_kind_exists: 409,
  act_prerequisites_not_met: 422,
  invalid_recipients: 422,
};

function mapDesignerEnableError(c: Context, err: unknown) {
  if (err instanceof DesignerEnableError) {
    return c.json({ error: err.code, ...err.detail }, DESIGNER_ENABLE_STATUS[err.code]);
  }
  if (err instanceof PartnerWideWriteDeniedError) return c.json({ error: 'partner_admin_required', message: err.message }, 403);
  throw err;
}

function mapApplyError(c: Context, err: unknown) {
  if (err instanceof FleetDesignApplyError) {
    if (err.code === 'not_found' || err.code === 'no_outcome') return c.json({ error: 'not_found' }, 404);
    if (err.code === 'blocked') return c.json({ error: 'blocked', ...(err.payload ?? {}) }, 409);
  }
  if (err instanceof PartnerWideWriteDeniedError) return c.json({ error: err.message }, 403);
  throw err;
}

/**
 * Counts sections out of a stored `FleetDesignReportSummary` for the list/
 * detail projections below. Every field on the summary is optional
 * (persisted jsonb, old snapshots must still render) — an incomplete or
 * pre-outcome row projects to zero counts rather than throwing.
 */
function sectionCounts(summary: FleetDesignReportSummary | null | undefined) {
  const sections = summary?.fleetDesign?.outcome?.sections;
  const watchCount = sections?.monitoring.reduce((n, m) => n + m.watches.length, 0) ?? 0;
  const ruleCount = sections?.monitoring.reduce((n, m) => n + m.alertRules.length, 0) ?? 0;
  return {
    functionCount: sections?.functions.length ?? 0,
    watchCount,
    ruleCount,
    evidenceTruncated: summary?.fleetDesign?.evidenceTruncated ?? false,
    generatedAt: summary?.fleetDesign?.generatedAt ?? null,
    runId: summary?.fleetDesign?.runId ?? null,
  };
}

// Triggering a Fleet Design run is at least as consequential as any other
// autonomous agent trigger, so it carries the same write-permission + MFA
// gates as `POST /ai/agents/:id/runs`.
fleetDesignRoutes.post(
  '/runs',
  scopes,
  requireAiWrite,
  requireMfa(),
  zValidator('json', triggerFleetDesignRunSchema),
  async (c) => {
    const auth = c.get('auth');
    const { orgId, siteId } = c.req.valid('json');

    // 404, not 403: a cross-tenant probe must read identically to a typo'd
    // org id (same posture `loadFleetDesignReport` documents for report ids).
    if (!auth.canAccessOrg(orgId)) return c.json({ error: 'not_found' }, 404);

    if (siteId) {
      const [site] = await db
        .select({ id: sites.id })
        .from(sites)
        .where(and(eq(sites.id, siteId), eq(sites.orgId, orgId)))
        .limit(1);
      if (!site) return c.json({ error: 'not_found' }, 404);
    }

    const resolved = await resolveEffectiveAgent(auth, orgId, 'designer');
    if (!resolved) return c.json({ error: 'no_designer_agent' }, 404);

    const result = await createAndEnqueueAgentRun({
      orgId,
      kind: 'designer',
      triggerKind: 'manual',
      deviceId: null,
      profile: 'design',
      // A human pressing "run now" twice means twice — same posture as the
      // device manual-trigger route's dedupe key.
      dedupeKey: `design-manual-${randomUUID()}`,
      triggerRef: { requestedByUserId: auth.user.id, agentId: resolved.agentId, siteId: siteId ?? null },
    });

    // Every outcome is audited: createAndEnqueueAgentRun writes no audit row
    // of its own, so this is the only record of which human asked for a
    // design run — including when the answer was "no".
    writeRouteAudit(c, {
      orgId,
      action: 'ai_fleet_design.run.manual_trigger',
      resourceType: 'ai_agent',
      resourceId: resolved.agentId,
      details: {
        siteId: siteId ?? null,
        ...(result.created ? { runId: result.run.id } : { skipped: result.skipped }),
      },
      result: result.created ? 'success' : 'failure',
    });

    // A declined admission is not an error — the caller asked for a design and
    // the admission rules said not now (mode off, cap reached, budget). It is
    // also not a success: `success: false` is exactly the HTTP-200 failure
    // shape the web's runAction detector reads (apps/web/src/lib/apiError.ts),
    // so a "Run now" button can never toast "queued" for a run that never was.
    if (!result.created) return c.json({ success: false, skipped: result.skipped }, 200);
    return c.json({ runId: result.run.id }, 202);
  },
);

// #6214: the Fleet Design page's setup probe. Registered before `/:reportRunId`
// so the literal segment wins the match; a read, so ai_agents:read suffices
// (same gate as the list/detail routes below).
fleetDesignRoutes.get('/designer', scopes, requireAiRead, async (c) => {
  const auth = c.get('auth');
  const rawOrgId = c.req.query('orgId');
  if (!rawOrgId) return c.json({ error: 'orgId is required' }, 400);
  const parsed = UUID.safeParse(rawOrgId);
  // Same 404 posture as the run trigger: a malformed id and a cross-tenant
  // id read identically.
  if (!parsed.success || !auth.canAccessOrg(parsed.data)) return c.json({ error: 'not_found' }, 404);
  return c.json({ data: await describeDesignerSetup(auth, parsed.data) });
});

// #6214: one click that creates the partner's designer agent (or turns an
// existing one on). Same gates as creating/patching the agent by hand in
// Settings → AI Agents (`POST/PATCH /ai/agents`: ai_agents:write + MFA) —
// this is that write, reached from the page that needs it.
fleetDesignRoutes.post(
  '/designer/enable',
  scopes,
  requireAiWrite,
  requireMfa(),
  zValidator('json', enableFleetDesignerSchema),
  async (c) => {
    const auth = c.get('auth');
    const { orgId } = c.req.valid('json');
    if (!auth.canAccessOrg(orgId)) return c.json({ error: 'not_found' }, 404);

    try {
      const setup = await enableDesigner(auth, orgId);
      // createAgent/updateAgent each write their own agent-mutation audit
      // row; this one records that the change came from the Fleet Design
      // page's enable button, and for which org — the same "who asked"
      // record the manual trigger above keeps.
      writeRouteAudit(c, {
        orgId,
        action: 'ai_fleet_design.designer.enable',
        resourceType: 'ai_agent',
        resourceId: setup.agentId ?? orgId,
        details: { status: setup.status },
        result: 'success',
      });
      return c.json({ data: setup });
    } catch (err) {
      const code = err instanceof DesignerEnableError ? err.code
        : err instanceof PartnerWideWriteDeniedError ? 'partner_admin_required'
        : 'error';
      writeRouteAudit(c, {
        orgId,
        action: 'ai_fleet_design.designer.enable',
        resourceType: 'ai_agent',
        resourceId: orgId,
        details: { error: code },
        result: 'failure',
      });
      return mapDesignerEnableError(c, err);
    }
  },
);

fleetDesignRoutes.get('/', scopes, requireAiRead, async (c) => {
  const auth = c.get('auth');
  const queryOrgId = c.req.query('orgId');

  if (queryOrgId && !auth.canAccessOrg(queryOrgId)) return c.json({ items: [] });

  const conditions = [eq(reports.type, FLEET_DESIGN_REPORT_TYPE), eq(reportRuns.status, 'completed')];
  const orgCond = auth.orgCondition(reports.orgId);
  if (orgCond) conditions.push(orgCond);
  if (queryOrgId) conditions.push(eq(reports.orgId, queryOrgId));

  const rows = await db
    .select({
      reportRunId: reportRuns.id,
      reportId: reports.id,
      orgId: reports.orgId,
      summary: reportRuns.result,
    })
    .from(reportRuns)
    .innerJoin(reports, eq(reportRuns.reportId, reports.id))
    .where(and(...conditions))
    .orderBy(desc(reportRuns.completedAt))
    .limit(100);

  return c.json({
    items: rows.map((row) => {
      const counts = sectionCounts((row.summary as { summary?: FleetDesignReportSummary } | null)?.summary);
      return {
        reportRunId: row.reportRunId,
        reportId: row.reportId,
        orgId: row.orgId,
        generatedAt: counts.generatedAt,
        runId: counts.runId,
        functionCount: counts.functionCount,
        watchCount: counts.watchCount,
        ruleCount: counts.ruleCount,
        evidenceTruncated: counts.evidenceTruncated,
      };
    }),
  });
});

fleetDesignRoutes.get('/:reportRunId', scopes, requireAiRead, async (c) => {
  const auth = c.get('auth');
  const reportRunId = uuidParam(c, 'reportRunId');
  if (!reportRunId) return c.json({ error: 'not_found' }, 404);
  const row = await loadFleetDesignReport(reportRunId, (col) => auth.orgCondition(col));
  // loadFleetDesignReport returns null for "does not exist", "not a Fleet
  // Design report" and "fails the caller's org condition" alike, by design
  // (see its docstring) — never leak which of the three it was.
  if (!row) return c.json({ error: 'not_found' }, 404);

  return c.json({
    reportRunId: row.reportRunId,
    reportId: row.reportId,
    orgId: row.orgId,
    summary: row.summary,
    markdown: row.summary?.fleetDesign?.outcome?.markdown ?? '',
    downloadPath: `/api/reports/runs/${row.reportRunId}/download`,
  });
});

// ---------------------------------------------------------------------------
// W03: apply preview, apply, rollback, ledger
// ---------------------------------------------------------------------------

fleetDesignRoutes.post(
  '/:reportRunId/apply/preview',
  scopes,
  requireDevicesWrite,
  requireMfa(),
  zValidator('json', fleetDesignApprovalSchema),
  async (c) => {
    const auth = c.get('auth');
    const reportRunId = uuidParam(c, 'reportRunId');
    if (!reportRunId) return c.json({ error: 'not_found' }, 404);
    if (siteRestricted(c)) return c.json({ error: 'site_restricted' }, 403);
    const approval = c.req.valid('json');
    if (approval.automation.length > 0 && !canWriteScripts(c)) return c.json({ error: 'scripts_write_required' }, 403);
    try {
      const preview = await previewFleetDesignApply(auth, reportRunId, approval);
      return c.json(preview);
    } catch (err) {
      return mapApplyError(c, err);
    }
  },
);

fleetDesignRoutes.post(
  '/:reportRunId/apply',
  scopes,
  requireDevicesWrite,
  requireMfa(),
  zValidator('json', fleetDesignApprovalSchema),
  async (c) => {
    const auth = c.get('auth');
    const reportRunId = uuidParam(c, 'reportRunId');
    if (!reportRunId) return c.json({ error: 'not_found' }, 404);
    if (siteRestricted(c)) return c.json({ error: 'site_restricted' }, 403);
    const approval = c.req.valid('json');
    if (approval.automation.length > 0 && !canWriteScripts(c)) return c.json({ error: 'scripts_write_required' }, 403);
    try {
      const result = await applyFleetDesign(auth, reportRunId, approval, c);
      writeRouteAudit(c, {
        orgId: auth.orgId ?? null,
        action: 'fleet_design.apply',
        resourceType: 'report_run',
        resourceId: reportRunId,
        details: { reportRunId, applied: result.applied.length, skipped: result.skipped.length, partial: result.partial },
        result: result.partial ? 'failure' : 'success',
      });
      return c.json(result);
    } catch (err) {
      if (err instanceof FleetDesignApplyError && err.code === 'blocked') {
        writeRouteAudit(c, {
          orgId: auth.orgId ?? null,
          action: 'fleet_design.apply',
          resourceType: 'report_run',
          resourceId: reportRunId,
          details: { reportRunId, applied: 0, blocked: true },
          result: 'failure',
        });
      }
      return mapApplyError(c, err);
    }
  },
);

fleetDesignRoutes.post('/:reportRunId/rollback', scopes, requireDevicesWrite, requireMfa(), async (c) => {
  const auth = c.get('auth');
  const reportRunId = uuidParam(c, 'reportRunId');
  if (!reportRunId) return c.json({ error: 'not_found' }, 404);
  if (siteRestricted(c)) return c.json({ error: 'site_restricted' }, 403);
  try {
    // A caller without scripts:write still rolls back everything else; the
    // service refuses only the script rows (scripts_write_required).
    const result = await rollbackFleetDesign(auth, reportRunId, c, { canWriteScripts: canWriteScripts(c) });
    writeRouteAudit(c, {
      orgId: auth.orgId ?? null,
      action: 'fleet_design.rollback',
      resourceType: 'report_run',
      resourceId: reportRunId,
      details: { reportRunId, rolledBack: result.rolledBack.length, refused: result.refused.length },
      result: result.refused.length === 0 ? 'success' : 'failure',
    });
    return c.json(result);
  } catch (err) {
    return mapApplyError(c, err);
  }
});

fleetDesignRoutes.get('/:reportRunId/applied', scopes, requireAiRead, async (c) => {
  const auth = c.get('auth');
  const reportRunId = uuidParam(c, 'reportRunId');
  if (!reportRunId) return c.json({ error: 'not_found' }, 404);
  const row = await loadFleetDesignReport(reportRunId, (col) => auth.orgCondition(col));
  if (!row) return c.json({ error: 'not_found' }, 404);
  const rows = await loadLedger(reportRunId, row.orgId);
  return c.json({ items: rows.map(toLedgerItem) });
});

// ---------------------------------------------------------------------------
// W05: file the design PDF in the org's document library
// ---------------------------------------------------------------------------

fleetDesignRoutes.post('/:reportRunId/document', scopes, requireDocumentsWrite, async (c) => {
  const auth = c.get('auth');
  const reportRunId = uuidParam(c, 'reportRunId');
  if (!reportRunId) return c.json({ error: 'not_found' }, 404);
  // Same three-way-blind 404 as GET /:reportRunId — the org is the run's own,
  // never a body/query value.
  const row = await loadFleetDesignReport(reportRunId, (col) => auth.orgCondition(col));
  if (!row) return c.json({ error: 'not_found' }, 404);
  let result: Awaited<ReturnType<typeof fileFleetDesignDocument>>;
  try {
    result = await fileFleetDesignDocument({
      orgId: row.orgId,
      reportRunId,
      actor: { userId: auth.user?.id ?? null, partnerId: auth.partnerId ?? null, accessibleOrgIds: auth.accessibleOrgIds },
      // Attaching the filed document to a deliverable occurrence can move that
      // occurrence to `delivered` — a contract-adjacent write every other
      // evidence route gates on `contracts:write`
      // (routes/serviceDeliverables.ts). A documents-only caller still files
      // the document; it just does not get a side door into deliverables.
      linkDeliverableEvidence: callerCanWriteContracts(c),
    });
  } catch (err) {
    // The document/deliverable services carry their own structural
    // `status`/`code` (DeliverableServiceError, BlobStorageError) — map them
    // the way routes/orgDocuments.ts does rather than letting a legitimate
    // 404/409/503 surface as an opaque 500 from the global handler.
    if (
      err && typeof err === 'object' && 'status' in err && 'code' in err
      && typeof (err as { status: unknown }).status === 'number' && typeof (err as { code: unknown }).code === 'string'
    ) {
      const e = err as { status: number; code: string; message?: string };
      if (e.status >= 500) captureException(err);
      return c.json({ error: e.message ?? e.code, code: e.code }, e.status as 400);
    }
    throw err;
  }
  writeRouteAudit(c, {
    orgId: row.orgId,
    action: 'fleet_design.document.file',
    resourceType: 'org_document',
    resourceId: result.documentId,
    details: { reportRunId, alreadyFiled: result.alreadyFiled, evidence: result.evidence },
    result: 'success',
  });
  return c.json(result);
});
