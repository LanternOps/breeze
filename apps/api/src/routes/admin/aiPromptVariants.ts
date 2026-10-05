import { Hono } from 'hono';
import { aiPromptVariantReportQuerySchema } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { buildPromptVariantReport, defaultPromptVariantRange } from '../../services/aiModels/promptVariantReport';
import { QualityQueryTimeoutError } from '../../services/aiModels/qualityQueries';

export const aiPromptVariantAdminRoutes = new Hono();

// AI model registry W11 (#7609). Platform-admin only (adminRoutes mounts
// platformAdminMiddleware on '*'). Cross-tenant by design, like
// /admin/ai/tool-usage: aggregates keyed by prompt variant; no org, partner or
// user identifier leaves this route.
aiPromptVariantAdminRoutes.get('/prompt-variants', zValidator('query', aiPromptVariantReportQuerySchema), async (c) => {
  const q = c.req.valid('query');
  const range = q.from && q.to ? { from: q.from, to: q.to } : defaultPromptVariantRange();
  try {
    const report = await runOutsideDbContext(() => withSystemDbAccessContext(() => buildPromptVariantReport(range), 'aiPromptVariantReport'));
    return c.json(report);
  } catch (error) {
    if (error instanceof QualityQueryTimeoutError) {
      return c.json({ error: 'This range is too large to summarize quickly. Choose a shorter range.', code: 'quality_timeout' }, 503);
    }
    throw error;
  }
});
