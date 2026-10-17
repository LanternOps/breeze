import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import {
  HISTORY_PAGE_MAX,
  decodeHistoryCursor,
  getEndpointMessageDetail,
  listEndpointMessages,
} from '../../services/endpointMessaging/history';

// Endpoint message history (#8742 W02): batch list and per-device status.
// Read-only; `endpoint_messages:read`.
export const listRoutes = new Hono();

const listQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(HISTORY_PAGE_MAX).default(50),
  cursor: z.string().max(512).optional(),
});

const idParamSchema = z.object({ id: z.string().uuid() });

listRoutes.get(
  '/',
  authMiddleware,
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ENDPOINT_MESSAGES_READ.resource, PERMISSIONS.ENDPOINT_MESSAGES_READ.action),
  zValidator('query', listQuerySchema),
  async (c) => {
    const query = c.req.valid('query');
    const cursor = decodeHistoryCursor(query.cursor);
    if (cursor === 'invalid') return c.json({ error: 'invalid_cursor' }, 400);
    const page = await listEndpointMessages({
      auth: c.get('auth') as AuthContext,
      permissions: c.get('permissions') as UserPermissions | undefined,
      orgId: query.orgId,
      limit: query.limit,
      cursor,
    });
    return c.json(page);
  },
);

listRoutes.get(
  '/:id',
  authMiddleware,
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ENDPOINT_MESSAGES_READ.resource, PERMISSIONS.ENDPOINT_MESSAGES_READ.action),
  zValidator('param', idParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const detail = await getEndpointMessageDetail({
      auth: c.get('auth') as AuthContext,
      permissions: c.get('permissions') as UserPermissions | undefined,
      messageRowId: id,
    });
    if (!detail) return c.json({ error: 'not_found' }, 404);
    return c.json(detail);
  },
);
