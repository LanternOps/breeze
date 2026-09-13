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
import { triggerFleetDesignRunSchema, type FleetDesignReportSummary } from '@breeze/shared';
import { zValidator } from '../lib/validation';
import { db } from '../db';
import { reportRuns, reports, sites } from '../db/schema';
import { requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { resolveEffectiveAgent } from '../services/aiAgents/effectivePolicy';
import { createAndEnqueueAgentRun } from '../services/aiAgents/runService';
import { FLEET_DESIGN_REPORT_TYPE, loadFleetDesignReport } from '../services/aiAgents/fleetDesignReport';
import { writeRouteAudit } from '../services/auditEvents';

export const fleetDesignRoutes = new Hono();

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

    if (!result.created) return c.json({ skipped: result.skipped }, 200);
    return c.json({ runId: result.run.id }, 202);
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
