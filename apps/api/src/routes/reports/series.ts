/**
 * Multi-org report series routes (spec §3.6), mounted at /reports/series
 * BEFORE the core /:id routes (routes/reports/index.ts). Thin: rules live in
 * services/reportSeries/*; this file gates, validates, maps errors through
 * seriesErrorResponse and audits. Every route requires partner scope with
 * org_access = 'all' (reads included — a series spans orgs a 'selected'
 * user cannot open).
 */
import { Hono, type Context } from 'hono';
import type { z } from 'zod';
import { db } from '../../db';
import { formatZodError, zValidator } from '../../lib/validation';
import { authMiddleware, requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/partnerWideAccess';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { missingReportTypePermission, REPORT_TYPE_PERMISSION_DENIED } from '../../services/reportTypePermissions';
import { ReportSeriesError } from '../../services/reportSeries/errors';
import {
  createSeries,
  deleteSeries,
  getSeriesDetail,
  listSeries,
  loadOwnSeries,
  previewSavedSeriesRecipients,
  previewSeriesRecipients,
  replaceSeriesTargets,
  seriesWriteAllowed,
  transferSeriesOwner,
  updateSeries,
} from '../../services/reportSeries/store';
import type { ReportSeriesRow } from '../../services/reportSeries/types';
import { assertSeriesConfigOrgAgnostic, assertSeriesTypeSupported } from '../../services/reportSeries/validation';
import { callerMaySetEmailRecipients } from './recipientGate';
import { parseStoredReportConfig } from './schemas';
import { seriesErrorResponse } from './seriesErrors';
import {
  createSeriesSchema,
  previewSeriesRecipientsSchema,
  replaceSeriesTargetsSchema,
  seriesIdParamSchema,
  transferSeriesOwnerSchema,
  updateSeriesSchema,
} from './seriesSchemas';

export const reportSeriesRoutes = new Hono();

reportSeriesRoutes.use('*', authMiddleware);

const read = requirePermission(PERMISSIONS.REPORTS_READ.resource, PERMISSIONS.REPORTS_READ.action);
const write = requirePermission(PERMISSIONS.REPORTS_WRITE.resource, PERMISSIONS.REPORTS_WRITE.action);
const remove = requirePermission(PERMISSIONS.REPORTS_DELETE.resource, PERMISSIONS.REPORTS_DELETE.action);

function gate(auth: AuthContext): void {
  if (!seriesWriteAllowed(auth)) {
    throw new ReportSeriesError('series_write_denied', 403, { message: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
  }
}

function assertTargetsAccessible(auth: AuthContext, orgIds: readonly string[]): void {
  const inaccessible = orgIds.filter((orgId) => !auth.canAccessOrg(orgId));
  if (inaccessible.length > 0) {
    throw new ReportSeriesError('series_target_org_inaccessible', 400, { orgIds: inaccessible });
  }
}

/** Same body shape as core.ts's stored-config refusal (path prefixed with `config`). */
function configValidationBody(error: z.ZodError) {
  return formatZodError({
    issues: error.issues.map((issue) => ({ ...issue, path: ['config', ...issue.path] })),
  });
}

function mayAddDelivery(c: Context, auth: AuthContext): boolean {
  return callerMaySetEmailRecipients(auth, c.get('permissions') as UserPermissions | undefined);
}

function auditSeries(c: Context, action: string, series: ReportSeriesRow, details: Record<string, unknown>): void {
  writeRouteAudit(c, {
    orgId: null,
    action,
    resourceType: 'report_series',
    resourceId: series.id,
    resourceName: series.name,
    details: { partnerId: series.partnerId, ...details },
  });
}

reportSeriesRoutes.get('/', requireScope('partner'), read, async (c) => {
  try {
    const auth = c.get('auth');
    gate(auth);
    return c.json({ data: await listSeries(auth) });
  } catch (err) {
    return seriesErrorResponse(c, err);
  }
});

reportSeriesRoutes.post(
  '/recipients/preview',
  requireScope('partner'),
  read,
  zValidator('json', previewSeriesRecipientsSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      gate(auth);
      const body = c.req.valid('json');
      assertTargetsAccessible(auth, body.orgIds);
      return c.json(await previewSeriesRecipients({ ...body, seriesId: null }, auth));
    } catch (err) {
      return seriesErrorResponse(c, err);
    }
  },
);

reportSeriesRoutes.post('/', requireScope('partner'), write, zValidator('json', createSeriesSchema), async (c) => {
  try {
    const auth = c.get('auth');
    gate(auth);
    const body = c.req.valid('json');
    assertSeriesTypeSupported(body.type);
    // Same check and body as core.ts create: the type's underlying read permissions.
    if (missingReportTypePermission(body.type as ReportSeriesRow['type'], c.get('permissions') as UserPermissions | undefined)) {
      return c.json(REPORT_TYPE_PERMISSION_DENIED, 403);
    }
    const parsed = parseStoredReportConfig(body.type, body.config);
    if (!parsed.success) return c.json(configValidationBody(parsed.error), 400);
    assertSeriesConfigOrgAgnostic(parsed.data);
    assertTargetsAccessible(auth, body.orgIds);

    const created = await db.transaction((tx) => createSeries({
      ...body,
      type: body.type as ReportSeriesRow['type'],
      config: parsed.data,
      ownerUserId: body.ownerUserId ?? auth.user.id,
    }, auth, tx, { mayAddDelivery: mayAddDelivery(c, auth) }));

    auditSeries(c, 'report_series.create', created.series, {
      type: created.series.type,
      targetMode: created.series.targetMode,
      revision: created.series.revision,
      reconcile: created.reconcile,
    });
    return c.json(await getSeriesDetail(created.series.id, auth), 201);
  } catch (err) {
    return seriesErrorResponse(c, err);
  }
});

reportSeriesRoutes.get('/:id', requireScope('partner'), read, zValidator('param', seriesIdParamSchema), async (c) => {
  try {
    const auth = c.get('auth');
    gate(auth);
    return c.json(await getSeriesDetail(c.req.valid('param').id, auth));
  } catch (err) {
    return seriesErrorResponse(c, err);
  }
});

reportSeriesRoutes.get(
  '/:id/recipients/preview',
  requireScope('partner'),
  read,
  zValidator('param', seriesIdParamSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      gate(auth);
      return c.json(await previewSavedSeriesRecipients(c.req.valid('param').id, auth));
    } catch (err) {
      return seriesErrorResponse(c, err);
    }
  },
);

reportSeriesRoutes.patch(
  '/:id',
  requireScope('partner'),
  write,
  zValidator('param', seriesIdParamSchema),
  zValidator('json', updateSeriesSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      gate(auth);
      const { id } = c.req.valid('param');
      const patch = c.req.valid('json');
      // The series type is immutable, so reading it before the write
      // transaction cannot race.
      const current = await loadOwnSeries(id, auth);
      // Same check and body as core.ts edit: any edit needs the STORED type's
      // underlying read permissions (a config edit can redirect delivery).
      if (missingReportTypePermission(current.type, c.get('permissions') as UserPermissions | undefined)) {
        return c.json(REPORT_TYPE_PERMISSION_DENIED, 403);
      }
      let config: Record<string, unknown> | undefined;
      if (patch.config !== undefined) {
        const parsed = parseStoredReportConfig(current.type, patch.config);
        if (!parsed.success) return c.json(configValidationBody(parsed.error), 400);
        assertSeriesConfigOrgAgnostic(parsed.data);
        config = parsed.data;
      }
      const updated = await db.transaction((tx) => updateSeries(
        id,
        { ...patch, ...(config !== undefined ? { config } : {}) },
        auth,
        tx,
        { mayAddDelivery: mayAddDelivery(c, auth) },
      ));
      auditSeries(c, 'report_series.update', updated.series, {
        changedFields: Object.keys(patch),
        revision: updated.series.revision,
        reconcile: updated.reconcile,
      });
      return c.json(await getSeriesDetail(id, auth));
    } catch (err) {
      return seriesErrorResponse(c, err);
    }
  },
);

reportSeriesRoutes.put(
  '/:id/targets',
  requireScope('partner'),
  write,
  zValidator('param', seriesIdParamSchema),
  zValidator('json', replaceSeriesTargetsSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      gate(auth);
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      assertTargetsAccessible(auth, body.orgIds);
      const replaced = await db.transaction((tx) =>
        replaceSeriesTargets(id, body, auth, tx, { mayAddDelivery: mayAddDelivery(c, auth) }));
      auditSeries(c, 'report_series.targets.replace', replaced.series, {
        targetMode: body.targetMode,
        orgCount: body.orgIds.length,
        revision: replaced.series.revision,
        reconcile: replaced.reconcile,
      });
      return c.json(await getSeriesDetail(id, auth));
    } catch (err) {
      return seriesErrorResponse(c, err);
    }
  },
);

reportSeriesRoutes.post(
  '/:id/transfer-owner',
  requireScope('partner'),
  write,
  zValidator('param', seriesIdParamSchema),
  zValidator('json', transferSeriesOwnerSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      gate(auth);
      const { id } = c.req.valid('param');
      const { ownerUserId } = c.req.valid('json');
      const moved = await db.transaction((tx) => transferSeriesOwner(id, ownerUserId, auth, tx));
      auditSeries(c, 'report_series.owner.transfer', moved.series, {
        previousOwnerUserId: moved.previousOwnerUserId,
        ownerUserId,
        reconcile: moved.reconcile,
      });
      return c.json(await getSeriesDetail(id, auth));
    } catch (err) {
      return seriesErrorResponse(c, err);
    }
  },
);

reportSeriesRoutes.delete('/:id', requireScope('partner'), remove, zValidator('param', seriesIdParamSchema), async (c) => {
  try {
    const auth = c.get('auth');
    gate(auth);
    const { id } = c.req.valid('param');
    const deleted = await db.transaction((tx) => deleteSeries(id, auth, tx));
    auditSeries(c, 'report_series.delete', deleted.series, { archivedChildren: deleted.archivedChildren });
    return c.json({ success: true, archivedChildren: deleted.archivedChildren });
  } catch (err) {
    return seriesErrorResponse(c, err);
  }
});
