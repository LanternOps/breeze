import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

export const userRoutes = new Hono();

const inviteUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  roleId: z.string().uuid(),
  orgAccess: z.enum(['all', 'selected', 'none']).optional(),
  orgIds: z.array(z.string().uuid()).optional(),
  siteIds: z.array(z.string().uuid()).optional(),
  deviceGroupIds: z.array(z.string().uuid()).optional()
});

const createRoleSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  scope: z.enum(['partner', 'organization']),
  permissions: z.array(z.string())
});

const createApiKeySchema = z.object({
  name: z.string().min(1),
  permissions: z.array(z.string()).optional(),
  expiresAt: z.string().optional()
});

// --- Users ---

userRoutes.get('/', async (c) => {
  const { page = '1', limit = '50', orgId, search } = c.req.query();
  return c.json({
    data: [],
    pagination: { page: parseInt(page), limit: parseInt(limit), total: 0 }
  });
});

userRoutes.post('/', zValidator('json', inviteUserSchema), async (c) => {
  const data = c.req.valid('json');
  return c.json({ id: 'user-uuid', status: 'invited', ...data }, 201);
});

userRoutes.get('/me', async (c) => {
  return c.json({
    id: 'user-uuid',
    email: 'john@acme.com',
    name: 'John Doe',
    mfaEnabled: true,
    partners: [],
    organizations: []
  });
});

userRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  return c.json({ id, email: 'user@example.com', name: 'User', status: 'active' });
});

userRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const data = await c.req.json();
  return c.json({ id, ...data });
});

userRoutes.delete('/:id', async (c) => {
  return c.json({ success: true });
});

// --- Roles ---

userRoutes.get('/roles', async (c) => {
  return c.json({
    data: [
      { id: 'role-1', name: 'Partner Admin', scope: 'partner', isSystem: true },
      { id: 'role-2', name: 'Partner Technician', scope: 'partner', isSystem: true },
      { id: 'role-3', name: 'Org Admin', scope: 'organization', isSystem: true },
      { id: 'role-4', name: 'Org Viewer', scope: 'organization', isSystem: true }
    ]
  });
});

userRoutes.post('/roles', zValidator('json', createRoleSchema), async (c) => {
  const data = c.req.valid('json');
  return c.json({ id: 'role-uuid', isSystem: false, ...data }, 201);
});

userRoutes.get('/roles/:id', async (c) => {
  const id = c.req.param('id');
  return c.json({ id, name: 'Custom Role', permissions: [] });
});

userRoutes.patch('/roles/:id', async (c) => {
  const id = c.req.param('id');
  const data = await c.req.json();
  return c.json({ id, ...data });
});

userRoutes.delete('/roles/:id', async (c) => {
  return c.json({ success: true });
});

// --- API Keys ---

userRoutes.get('/api-keys', async (c) => {
  return c.json({ data: [] });
});

userRoutes.post('/api-keys', zValidator('json', createApiKeySchema), async (c) => {
  const data = c.req.valid('json');
  return c.json({
    id: 'apikey-uuid',
    key: 'brz_sk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    ...data
  }, 201);
});

userRoutes.delete('/api-keys/:id', async (c) => {
  return c.json({ success: true });
});

// --- Permissions ---

userRoutes.get('/permissions', async (c) => {
  return c.json({
    data: [
      { id: 'perm-1', resource: 'devices', action: 'read' },
      { id: 'perm-2', resource: 'devices', action: 'write' },
      { id: 'perm-3', resource: 'scripts', action: 'read' },
      { id: 'perm-4', resource: 'scripts', action: 'execute' },
      { id: 'perm-5', resource: 'alerts', action: 'read' },
      { id: 'perm-6', resource: 'alerts', action: 'write' },
      { id: 'perm-7', resource: 'users', action: 'admin' }
    ]
  });
});
