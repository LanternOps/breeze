import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';

import { requireScope } from '../../middleware/auth';
import {
  listThreatsQuerySchema,
  deviceIdParamSchema,
  threatIdParamSchema,
  providerCatalog
} from './schemas';
import {
  getPagination,
  paginate,
  parseDateRange,
  matchDateRange,
  listStatusRows,
  listThreatRows,
  queueThreatAction
} from './helpers';

export const threatsRoutes = new Hono();

threatsRoutes.get(
  '/threats',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listThreatsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);
    const dateRange = parseDateRange(query.startDate, query.endDate);

    if ('error' in dateRange) {
      return c.json({ error: dateRange.error }, 400);
    }

    let threats = await listThreatRows(auth, undefined, query.orgId);

    if (query.severity) {
      threats = threats.filter((threat) => threat.severity === query.severity);
    }

    if (query.status) {
      threats = threats.filter((threat) => threat.status === query.status);
    }

    if (query.category) {
      threats = threats.filter((threat) => threat.threatType.toLowerCase() === query.category);
    }

    if (query.providerId) {
      threats = threats.filter((threat) => threat.provider === query.providerId);
    }

    if (dateRange.start || dateRange.end) {
      threats = threats.filter((threat) => matchDateRange(threat.detectedAt, dateRange.start, dateRange.end));
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      threats = threats.filter((threat) => {
        return (
          threat.threatName.toLowerCase().includes(term) ||
          threat.deviceName.toLowerCase().includes(term) ||
          threat.filePath.toLowerCase().includes(term)
        );
      });
    }

    const mapped = threats.map((threat) => ({
      id: threat.id,
      deviceId: threat.deviceId,
      deviceName: threat.deviceName,
      orgId: threat.orgId,
      providerId: threat.provider,
      provider: providerCatalog[threat.provider],
      name: threat.threatName,
      category: threat.threatType.toLowerCase(),
      severity: threat.severity,
      status: threat.status,
      detectedAt: threat.detectedAt.toISOString(),
      removedAt: threat.resolvedAt?.toISOString() ?? null,
      filePath: threat.filePath
    }));

    const response = paginate(mapped, page, limit);
    return c.json({
      ...response,
      summary: {
        total: threats.length,
        active: threats.filter((t) => t.status === 'active').length,
        quarantined: threats.filter((t) => t.status === 'quarantined').length,
        critical: threats.filter((t) => t.severity === 'critical').length
      }
    });
  }
);

threatsRoutes.get(
  '/threats/:deviceId',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', listThreatsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId } = c.req.valid('param');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);
    const dateRange = parseDateRange(query.startDate, query.endDate);

    if ('error' in dateRange) {
      return c.json({ error: dateRange.error }, 400);
    }

    const statuses = await listStatusRows(auth);
    if (!statuses.some((row) => row.deviceId === deviceId)) {
      return c.json({ error: 'Device not found' }, 404);
    }

    let threats = await listThreatRows(auth, deviceId, query.orgId);

    if (query.severity) {
      threats = threats.filter((threat) => threat.severity === query.severity);
    }

    if (query.status) {
      threats = threats.filter((threat) => threat.status === query.status);
    }

    if (query.category) {
      threats = threats.filter((threat) => threat.threatType.toLowerCase() === query.category);
    }

    if (query.providerId) {
      threats = threats.filter((threat) => threat.provider === query.providerId);
    }

    if (dateRange.start || dateRange.end) {
      threats = threats.filter((threat) => matchDateRange(threat.detectedAt, dateRange.start, dateRange.end));
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      threats = threats.filter((threat) => {
        return (
          threat.threatName.toLowerCase().includes(term) ||
          threat.filePath.toLowerCase().includes(term)
        );
      });
    }

    const response = paginate(threats.map((threat) => ({
      id: threat.id,
      deviceId: threat.deviceId,
      deviceName: threat.deviceName,
      orgId: threat.orgId,
      providerId: threat.provider,
      provider: providerCatalog[threat.provider],
      name: threat.threatName,
      category: threat.threatType.toLowerCase(),
      severity: threat.severity,
      status: threat.status,
      detectedAt: threat.detectedAt.toISOString(),
      removedAt: threat.resolvedAt?.toISOString() ?? null,
      filePath: threat.filePath
    })), page, limit);

    return c.json(response);
  }
);

threatsRoutes.post(
  '/threats/:id/quarantine',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', threatIdParamSchema),
  async (c) => queueThreatAction(c, 'quarantine')
);

threatsRoutes.post(
  '/threats/:id/remove',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', threatIdParamSchema),
  async (c) => queueThreatAction(c, 'remove')
);

threatsRoutes.post(
  '/threats/:id/restore',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', threatIdParamSchema),
  async (c) => queueThreatAction(c, 'restore')
);
