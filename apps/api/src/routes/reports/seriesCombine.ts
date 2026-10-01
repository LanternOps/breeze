/**
 * Multi-org report series W04 — Combine routes (spec §3.8). Mounted by
 * series.ts BEFORE its `/:id` routes so `combine-candidates` is never read as
 * a series id. Partner scope only; the partner-wide gate applies to the READ
 * too, because the candidate list spans every org of the partner.
 */
import { Hono } from 'hono';
import { db } from '../../db';
import { authMiddleware, requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS } from '../../services/permissions';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
  PartnerWideWriteDeniedError,
} from '../../services/partnerWideAccess';
import { combineIntoSeries, findCombineCandidates } from '../../services/reportSeries/combine';
import { ReportSeriesError } from '../../services/reportSeries/errors';
import { zValidator } from '../../lib/validation';
import { callerMaySetEmailRecipients, RECIPIENTS_NEED_EXPORT_AND_MFA } from './recipientGate';
import { seriesErrorResponse } from './seriesErrors';
import { combineSeriesSchema } from './seriesSchemas';

export const seriesCombineRoutes = new Hono();

seriesCombineRoutes.use('*', authMiddleware);

function partnerWideDenied(auth: AuthContext): boolean {
  return auth.scope !== 'partner' || !auth.partnerId || !canManagePartnerWidePolicies(auth);
}

seriesCombineRoutes.get(
  '/combine-candidates',
  requireScope('partner'),
  requirePermission(PERMISSIONS.REPORTS_READ.resource, PERMISSIONS.REPORTS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    if (partnerWideDenied(auth)) return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    const data = await db.transaction((tx) => findCombineCandidates(auth.partnerId!, tx));
    return c.json({ data });
  },
);

seriesCombineRoutes.post(
  '/combine',
  requireScope('partner'),
  requirePermission(PERMISSIONS.REPORTS_WRITE.resource, PERMISSIONS.REPORTS_WRITE.action),
  zValidator('json', combineSeriesSchema),
  async (c) => {
    const auth = c.get('auth');
    if (partnerWideDenied(auth)) return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    const body = c.req.valid('json');

    let result: Awaited<ReturnType<typeof combineIntoSeries>>;
    try {
      result = await db.transaction((tx) => combineIntoSeries(
        // W02's gate (routes/reports/recipientGate.ts): reports:export + MFA.
        // Server-derived; the body schema cannot carry it.
        { ...body, callerMaySetEmailRecipients: callerMaySetEmailRecipients(auth, c.get('permissions')) },
        auth,
        tx,
      ));
    } catch (err) {
      // The existing export+MFA refusal body, byte for byte (core.ts clients
      // already key on it); every other series/combine error goes through W02's
      // one mapper.
      if (err instanceof ReportSeriesError && err.code === 'recipients_need_export_and_mfa') {
        return c.json(RECIPIENTS_NEED_EXPORT_AND_MFA, 403);
      }
      if (err instanceof PartnerWideWriteDeniedError) {
        return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
      }
      // W02's mapper rethrows anything that is not a series error (→ 500).
      return seriesErrorResponse(c, err);
    }

    writeRouteAudit(c, {
      orgId: null,
      action: 'report_series.combine',
      resourceType: 'report_series',
      resourceId: result.seriesId,
      resourceName: body.name,
      details: {
        partnerId: auth.partnerId,
        groupKey: body.groupKey,
        targetMode: body.targetMode,
        adoptedReportIds: result.adopted.map((a) => a.reportId),
        archivedReportIds: result.archived.map((a) => a.reportId),
        repointedDeliverableIds: result.repointedDeliverableIds,
        ccIncluded: body.ccResolution.include.length,
        ccDropped: body.ccResolution.drop.length,
      },
    });
    for (const adopted of result.adopted) {
      writeRouteAudit(c, {
        orgId: adopted.orgId,
        action: 'report.series_adopt',
        resourceType: 'report',
        resourceId: adopted.reportId,
        details: { seriesId: result.seriesId },
      });
    }
    for (const archived of result.archived) {
      writeRouteAudit(c, {
        orgId: archived.orgId,
        action: 'report.archive',
        resourceType: 'report',
        resourceId: archived.reportId,
        details: { seriesId: result.seriesId, reason: 'combine_duplicate' },
      });
    }
    return c.json(result, 201);
  },
);
