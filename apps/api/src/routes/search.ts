import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, ilike, or } from 'drizzle-orm';
import { db } from '../db';
import { alerts, devices, scripts } from '../db/schema';
import { authMiddleware } from '../middleware/auth';

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(50).optional()
});

const SETTINGS_ENTRIES = [
  { id: 'settings-profile', type: 'settings', title: 'Profile settings', description: 'Manage your profile', href: '/settings/profile' },
  { id: 'settings-security', type: 'settings', title: 'Security settings', description: 'Manage MFA and account security', href: '/settings/security' },
  { id: 'settings-users', type: 'settings', title: 'User management', description: 'Manage users and roles', href: '/settings/users' }
] as const;

export const searchRoutes = new Hono();

searchRoutes.use('*', authMiddleware);

searchRoutes.get('/', zValidator('query', searchQuerySchema), async (c) => {
  const auth = c.get('auth') as { orgCondition?: ((column: unknown) => unknown) | undefined };
  const { q, limit = 20 } = c.req.valid('query');
  const perCategoryLimit = Math.max(1, Math.min(8, Math.ceil(limit / 4)));
  const searchTerm = `%${q}%`;

  const orgConditionFor = (column: unknown) => {
    if (typeof auth?.orgCondition !== 'function') {
      return undefined;
    }
    return auth.orgCondition(column);
  };

  const deviceQuery = or(
    ilike(devices.hostname, searchTerm),
    ilike(devices.displayName, searchTerm)
  );
  const scriptQuery = or(
    ilike(scripts.name, searchTerm),
    ilike(scripts.description, searchTerm)
  );
  const alertQuery = or(
    ilike(alerts.title, searchTerm),
    ilike(alerts.message, searchTerm)
  );

  const [deviceRows, scriptRows, alertRows] = await Promise.all([
    db
      .select({
        id: devices.id,
        title: devices.displayName,
        hostname: devices.hostname,
        status: devices.status
      })
      .from(devices)
      .where(orgConditionFor(devices.orgId) ? and(orgConditionFor(devices.orgId) as never, deviceQuery as never) : deviceQuery)
      .limit(perCategoryLimit),
    db
      .select({
        id: scripts.id,
        title: scripts.name,
        description: scripts.description
      })
      .from(scripts)
      .where(orgConditionFor(scripts.orgId) ? and(orgConditionFor(scripts.orgId) as never, scriptQuery as never) : scriptQuery)
      .limit(perCategoryLimit),
    db
      .select({
        id: alerts.id,
        title: alerts.title,
        message: alerts.message,
        severity: alerts.severity
      })
      .from(alerts)
      .where(orgConditionFor(alerts.orgId) ? and(orgConditionFor(alerts.orgId) as never, alertQuery as never) : alertQuery)
      .limit(perCategoryLimit)
  ]);

  const results: Array<Record<string, unknown>> = [
    ...deviceRows.map((row) => ({
      id: row.id,
      type: 'devices',
      title: row.title || row.hostname,
      description: row.status || undefined
    })),
    ...scriptRows.map((row) => ({
      id: row.id,
      type: 'scripts',
      title: row.title,
      description: row.description || undefined
    })),
    ...alertRows.map((row) => ({
      id: row.id,
      type: 'alerts',
      title: row.title,
      description: row.severity || row.message || undefined
    }))
  ];

  const loweredQuery = q.toLowerCase();
  for (const entry of SETTINGS_ENTRIES) {
    const haystack = `${entry.title} ${entry.description}`.toLowerCase();
    if (haystack.includes(loweredQuery)) {
      results.push({
        id: entry.id,
        type: entry.type,
        title: entry.title,
        description: entry.description,
        href: entry.href
      });
    }
  }

  return c.json({ results: results.slice(0, limit) });
});

