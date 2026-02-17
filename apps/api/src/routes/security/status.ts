import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';

import { requireScope } from '../../middleware/auth';
import { listStatusQuerySchema, deviceIdParamSchema } from './schemas';
import { getPagination, paginate, listStatusRows, toStatusResponse } from './helpers';

export const statusRoutes = new Hono();

statusRoutes.get(
  '/status',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listStatusQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);

    const statuses = (await listStatusRows(auth, query.orgId)).map(toStatusResponse);

    let results = statuses;

    if (query.providerId) {
      results = results.filter((status) => status.providerId === query.providerId);
    }

    if (query.status) {
      results = results.filter((status) => status.status === query.status);
    }

    if (query.riskLevel) {
      results = results.filter((status) => status.riskLevel === query.riskLevel);
    }

    if (query.os) {
      results = results.filter((status) => status.os === query.os);
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      results = results.filter((status) => {
        const providerName = status.provider.name.toLowerCase();
        return (
          status.deviceName.toLowerCase().includes(term) ||
          status.deviceId.toLowerCase().includes(term) ||
          providerName.includes(term)
        );
      });
    }

    const response = paginate(results, page, limit);
    return c.json(response);
  }
);

statusRoutes.get(
  '/status/:deviceId',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId } = c.req.valid('param');

    const statuses = (await listStatusRows(auth)).map(toStatusResponse);
    const status = statuses.find((item) => item.deviceId === deviceId);

    if (!status) {
      return c.json({ error: 'Device not found' }, 404);
    }

    return c.json({ data: status });
  }
);
