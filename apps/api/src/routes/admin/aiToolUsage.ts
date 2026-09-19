import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { buildToolUsageReport } from '../../services/aiToolUsageReport';

export const aiToolUsageAdminRoutes = new Hono();

// Platform-admin only (adminRoutes mounts platformAdminMiddleware on '*').
// Cross-tenant by design: it aggregates tool names, never tool inputs/outputs.
aiToolUsageAdminRoutes.get(
  '/tool-usage',
  zValidator('query', z.object({ days: z.coerce.number().int().min(1).max(365).default(90) })),
  async (c) => {
    const { days } = c.req.valid('query');
    const report = await runOutsideDbContext(() => withSystemDbAccessContext(() => buildToolUsageReport(days), 'aiToolUsageReport'));
    return c.json(report);
  },
);
