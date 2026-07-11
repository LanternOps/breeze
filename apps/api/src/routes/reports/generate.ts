import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { generateReport, siteScopeRequestAllowed, type ReportResult } from '../../services/reportGenerationService';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
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
    const perms = c.get('permissions') as UserPermissions | undefined;

    if (!(await siteScopeRequestAllowed(orgId!, config, perms))) {
      return c.json({ error: 'Device not found or access denied' }, 403);
    }

    const reportData: ReportResult = await generateReport(data.type, orgId!, config, perms);

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
