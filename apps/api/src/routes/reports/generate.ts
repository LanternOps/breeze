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
import {
  organizationScope,
  reportScopeFromAuthority,
  type ReportScope,
} from '../../services/reportScope';
import { reportTypeDef } from '../../services/reportRegistry';
import {
  missingReportTypePermission,
  REPORT_TYPE_PERMISSION_DENIED,
} from '../../services/reportTypePermissions';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
} from '../../services/partnerWideAccess';
import {
  resolveRequestPartnerReportAuthority,
  resolveRequestReportAuthority,
  type ReportExecutionAuthority,
} from '../../services/siteScope';
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
    const permissions = c.get('permissions') as UserPermissions | undefined;

    let scope: ReportScope;
    let authority: ReportExecutionAuthority;
    let auditOrgId: string | null | undefined;

    if (data.ownerScope === 'partner') {
      // #3198 — a partner-wide ad-hoc aggregate over every active org of the
      // caller's own token partner. Carved out AHEAD of the multi-org 400
      // below: a partner-wide report is precisely the request that legitimately
      // omits orgId (spec §3.1). W01's two 403 bodies stay (ruling P12).
      if (auth.scope !== 'partner' || !auth.partnerId) {
        return c.json({ error: 'partner_scope_required' }, 403);
      }
      if (!canManagePartnerWidePolicies(auth)) {
        return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
      }
      // Before any authority lookup: an org-only type is a malformed request,
      // not an access question.
      if (!reportTypeDef(data.type).supportedScopes.includes('partner')) {
        return c.json({ error: 'unsupported_report_scope', type: data.type }, 400);
      }
      // #3198 W02 (spec §2, ruling P8): a business type also needs the
      // underlying read permissions its registry entry lists — the route's
      // reports:* grant is necessary but not sufficient. After W01's pinned
      // token gates (ruling P12), before any authority lookup or write.
      if (missingReportTypePermission(data.type, permissions)) {
        return c.json(REPORT_TYPE_PERMISSION_DENIED, 403);
      }
      const partnerResult = await resolveRequestPartnerReportAuthority(
        auth,
        auth.partnerId,
        'read',
      );
      // Condition 1: the caller's LIVE partner authority refuses (demoted,
      // selected org access, ...) — core.ts create's body (ruling T11a).
      if (!partnerResult.ok) {
        return c.json(
          { error: 'Report scope is not authorized', reason: partnerResult.reason },
          403,
        );
      }
      authority = partnerResult.authority;
      try {
        // Resolves the partner's live org list in THIS request's DB context
        // (runInReportScope, ruling P6) — never a nested system context.
        scope = await reportScopeFromAuthority({ partnerId: auth.partnerId }, authority);
      } catch (error) {
        // Condition 2 (distinct): authority granted, but THIS request's DB
        // context cannot execute it (ReportScopeMismatchError) — the body
        // runs.ts POST /:id/generate uses for the same execution failure.
        if (error instanceof UnexecutableReportScopeError) {
          return c.json({ error: 'Access to report scope denied' }, 403);
        }
        throw error;
      }
      auditOrgId = null;
    } else {
      // #3198 W02 (ruling P8): same per-type permission gate on the org arm.
      if (missingReportTypePermission(data.type, permissions)) {
        return c.json(REPORT_TYPE_PERMISSION_DENIED, 403);
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

      const authorityResult = await resolveRequestReportAuthority(
        auth,
        orgId!,
        'read',
      );
      if (!authorityResult.ok) {
        return c.json({ error: 'Device not found or access denied' }, 403);
      }
      authority = authorityResult.authority;
      scope = organizationScope(orgId!);
      auditOrgId = orgId ?? auth.orgId;
    }

    // Generate report data based on type
    const config = data.config || {};
    let reportData: ReportResult;
    try {
      reportData = await generateReport(
        data.type,
        scope,
        config,
        authority,
      );
    } catch (error) {
      // Also maps ReportScopeMismatchError (a subclass, ruling P11).
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
      // #3198 — the dispatcher's own supportedScopes refusal (a type whose
      // registry entry does not run under the requested owner axis).
      if (error instanceof UnsupportedReportScopeError) {
        return c.json({ error: 'unsupported_report_scope', type: data.type }, 400);
      }
      throw error;
    }

    writeRouteAudit(c, {
      orgId: auditOrgId,
      action: 'report.generate.adhoc',
      resourceType: 'report',
      details: scope.kind === 'partner'
        ? { type: data.type, format: data.format, ownerScope: 'partner', partnerId: scope.partnerId }
        : { type: data.type, format: data.format }
    });

    return c.json({
      type: data.type,
      format: data.format,
      generatedAt: new Date().toISOString(),
      data: reportData
    });
  }
);
