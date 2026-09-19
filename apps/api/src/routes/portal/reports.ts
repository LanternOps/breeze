import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import {
  generatePortalReport,
  latestPortalHardwareLifecycleRun,
  listPortalRuns,
  PortalReportNoTabularDataError,
  PortalReportNotFoundError,
  PortalReportRateLimitError,
  renderRunCsv,
  renderRunPdf,
} from '../../services/portal/reportsSelfService';
import {
  applyPortalCacheHeaders,
  buildWeakEtag,
  isEtagFresh,
  validatePortalCookieCsrfRequest,
} from './helpers';
import {
  portalReportGenerateSchema,
  portalReportListSchema,
  portalReportRunParamSchema,
} from './schemas';

// Route hub for the customer-portal reports surface, gated by the
// `enableReports` strict flag (Task 3.3). Mounted at root in
// routes/portal/index.ts under createPortalFeatureGateStrict('enableReports')
// so a later wave can add absolute `/reports/...` handlers here without a
// second mount.
export const portalReportRoutes = new Hono();

portalReportRoutes.get(
  '/reports/runs',
  zValidator('query', portalReportListSchema),
  async (c) => {
    const auth = c.get('portalAuth');
    const query = c.req.valid('query');
    const payload = await listPortalRuns(
      auth.user.orgId,
      auth.timezone,
      query,
    );

    applyPortalCacheHeaders(c, {
      scope: 'private',
      browserMaxAgeSeconds: 30,
      staleWhileRevalidateSeconds: 30,
      vary: ['Authorization', 'Cookie'],
    });
    const etag = buildWeakEtag(payload);
    c.header('ETag', etag);
    if (isEtagFresh(c.req.header('if-none-match'), etag)) {
      return new Response(null, {
        status: 304,
        headers: c.res.headers,
      });
    }
    return c.json(payload);
  },
);

// Mounted under BOTH the /reports/* enableReports gate and the narrower
// /reports/lifecycle/* enableLifecycle gate (routes/portal/index.ts), so the
// handler itself needs no flag check.
portalReportRoutes.get('/reports/lifecycle/latest', async (c) => {
  const auth = c.get('portalAuth');
  try {
    const payload = await latestPortalHardwareLifecycleRun(
      auth.user.orgId,
      auth.timezone,
    );

    applyPortalCacheHeaders(c, {
      scope: 'private',
      browserMaxAgeSeconds: 30,
      staleWhileRevalidateSeconds: 30,
      vary: ['Authorization', 'Cookie'],
    });
    const etag = buildWeakEtag(payload);
    c.header('ETag', etag);
    if (isEtagFresh(c.req.header('if-none-match'), etag)) {
      return new Response(null, { status: 304, headers: c.res.headers });
    }
    return c.json(payload);
  } catch (error) {
    if (error instanceof PortalReportNotFoundError) {
      // Deliberately the same answer an org with the flag off would get from
      // the generic endpoints: "not generated yet", never "not allowed".
      return c.json({
        error: 'No hardware lifecycle report has been generated yet',
        code: 'PORTAL_REPORT_NOT_GENERATED',
      }, 404);
    }
    throw error;
  }
});

portalReportRoutes.post(
  '/reports/generate',
  zValidator('json', portalReportGenerateSchema),
  async (c) => {
    const csrfError = validatePortalCookieCsrfRequest(c);
    if (csrfError) return c.json({ error: csrfError }, 403);

    const auth = c.get('portalAuth');
    try {
      const run = await generatePortalReport({
        orgId: auth.user.orgId,
        portalUserId: auth.user.id,
        type: c.req.valid('json').type,
      });
      return c.json({ data: run }, 201);
    } catch (error) {
      if (error instanceof PortalReportNotFoundError) {
        return c.json({ error: 'Portal report definition not found' }, 404);
      }
      if (error instanceof PortalReportRateLimitError) {
        c.header('Retry-After', String(error.retryAfterSeconds));
        return c.json(
          { error: 'Report generation is temporarily limited' },
          429,
        );
      }
      throw error;
    }
  },
);

portalReportRoutes.get(
  '/reports/runs/:id/pdf',
  zValidator('param', portalReportRunParamSchema),
  async (c) => {
    const auth = c.get('portalAuth');
    const runId = c.req.valid('param').id;
    try {
      const body = await renderRunPdf(runId, auth.user.orgId, auth.timezone);
      c.header('Content-Type', 'application/pdf');
      c.header(
        'Content-Disposition',
        `attachment; filename="portal-report-${runId}.pdf"`,
      );
      c.header('Cache-Control', 'private, max-age=0, no-store');
      c.header('Vary', 'Authorization, Cookie');
      return c.body(new Uint8Array(body));
    } catch (error) {
      if (error instanceof PortalReportNotFoundError) {
        return c.json({ error: 'Report run not found' }, 404);
      }
      console.error('[portal] PDF report render failed', { runId, error });
      return c.json({ error: 'Could not render report' }, 500);
    }
  },
);

portalReportRoutes.get(
  '/reports/runs/:id/csv',
  zValidator('param', portalReportRunParamSchema),
  async (c) => {
    const auth = c.get('portalAuth');
    const runId = c.req.valid('param').id;
    try {
      const body = await renderRunCsv(runId, auth.user.orgId);
      c.header('Content-Type', 'text/csv; charset=utf-8');
      c.header(
        'Content-Disposition',
        `attachment; filename="portal-report-${runId}.csv"`,
      );
      c.header('Cache-Control', 'private, max-age=0, no-store');
      c.header('Vary', 'Authorization, Cookie');
      return c.body(body);
    } catch (error) {
      if (error instanceof PortalReportNotFoundError) {
        return c.json({ error: 'Report run not found' }, 404);
      }
      if (error instanceof PortalReportNoTabularDataError) {
        return c.json(
          { error: 'Report run has no tabular data to download' },
          422,
        );
      }
      console.error('[portal] CSV report render failed', { runId, error });
      return c.json({ error: 'Could not render report' }, 500);
    }
  },
);
