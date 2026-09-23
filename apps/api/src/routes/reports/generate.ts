import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  generateReport,
  StoredArtifactOnlyReportError,
  UnexecutableReportScopeError,
  UnsupportedReportScopeError,
  type ReportResult,
} from '../../services/reportGenerationService';
import { PERMISSIONS } from '../../services/permissions';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
} from '../../services/partnerWideAccess';
import { resolveRequestReportAuthority } from '../../services/siteScope';
import { ensureOrgAccess } from './helpers';
import { generateReportSchema } from './schemas';

export const generateRoutes = new Hono();

generateRoutes.use('*', authMiddleware);

// POST /reports/generate - Generate ad-hoc report
generateRoutes.post(
  '/generate',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.REPORTS_EXPORT.resource, PERMISSIONS.REPORTS_EXPORT.action),
  zValidator('json', generateReportSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    // #3198 W01 — a partner-wide ad-hoc aggregate. Same three gates as a
    // partner-owned create, then refused: no report type has a partner-scope
    // generator this wave (W02 registers them).
    if (data.ownerScope === 'partner') {
      if (auth.scope !== 'partner' || !auth.partnerId) {
        return c.json({ error: 'partner_scope_required' }, 403);
      }
      if (!canManagePartnerWidePolicies(auth)) {
        return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
      }
      return c.json({ error: 'unsupported_report_scope', type: data.type }, 400);
    }

    // Determine orgId
    let orgId = data.orgId;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgId = auth.orgId;
    } else if (auth.scope === 'partner') {
      if (!orgId) {
        const singleOrg = auth.accessibleOrgIds?.[0];
        if (auth.accessibleOrgIds?.length === 1 && singleOrg) {
          orgId = singleOrg;
        } else {
          return c.json({ error: 'orgId is required when partner has multiple organizations' }, 400);
        }
      }
      const hasAccess = await ensureOrgAccess(orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
    } else if (auth.scope === 'system' && !orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    // Generate report data based on type
    const config = data.config || {};
    const authorityResult = await resolveRequestReportAuthority(
      auth,
      orgId!,
      'read',
    );
    if (!authorityResult.ok) {
      return c.json({ error: 'Device not found or access denied' }, 403);
    }

    let reportData: ReportResult;
    try {
      reportData = await generateReport(
        data.type,
        orgId!,
        config,
        authorityResult.authority,
      );
    } catch (error) {
      if (error instanceof UnexecutableReportScopeError) {
        return c.json({ error: 'Device not found or access denied' }, 403);
      }
      // P2-3 (#4190) — unreachable through this route today (the ad-hoc
      // generate schema already rejects the internal type with a 400), but
      // mapped rather than rethrown so a future type whose artifact is stored
      // surfaces as a 409 the first time it is asked for, not a 500.
      if (error instanceof StoredArtifactOnlyReportError) {
        return c.json({ error: 'stored_artifact_only' }, 409);
      }
      // #3198 W01 — a business type generated at org scope before W02 ships
      // its generator.
      if (error instanceof UnsupportedReportScopeError) {
        return c.json({ error: 'unsupported_report_scope', type: data.type }, 400);
      }
      throw error;
    }

    writeRouteAudit(c, {
      orgId: orgId ?? auth.orgId,
      action: 'report.generate.adhoc',
      resourceType: 'report',
      details: { type: data.type, format: data.format }
    });

    return c.json({
      type: data.type,
      format: data.format,
      generatedAt: new Date().toISOString(),
      data: reportData
    });
  }
);
