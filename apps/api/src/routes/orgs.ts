import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

export const orgRoutes = new Hono();

const createOrgSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['customer', 'internal']).default('customer'),
  maxDevices: z.number().optional(),
  contractStart: z.string().optional(),
  contractEnd: z.string().optional(),
  billingContact: z.any().optional()
});

const createSiteSchema = z.object({
  name: z.string().min(1),
  address: z.any().optional(),
  timezone: z.string().default('UTC'),
  contact: z.any().optional()
});

// --- Partner (MSP) ---

orgRoutes.get('/partner', async (c) => {
  return c.json({
    id: 'partner-uuid',
    name: 'Acme IT Solutions',
    type: 'msp',
    plan: 'enterprise',
    maxOrganizations: null,
    maxDevices: null
  });
});

orgRoutes.patch('/partner', async (c) => {
  const data = await c.req.json();
  return c.json({ id: 'partner-uuid', ...data });
});

// --- Organizations (Customers) ---

orgRoutes.get('/', async (c) => {
  const { page = '1', limit = '50', status, search } = c.req.query();
  return c.json({
    data: [],
    pagination: { page: parseInt(page), limit: parseInt(limit), total: 0 }
  });
});

orgRoutes.post('/', zValidator('json', createOrgSchema), async (c) => {
  const data = c.req.valid('json');
  return c.json({ id: 'org-uuid', partnerId: 'partner-uuid', status: 'active', ...data }, 201);
});

orgRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  return c.json({
    id,
    partnerId: 'partner-uuid',
    name: 'Sample Customer',
    type: 'customer',
    status: 'active'
  });
});

orgRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const data = await c.req.json();
  return c.json({ id, ...data });
});

orgRoutes.delete('/:id', async (c) => {
  return c.json({ success: true });
});

// --- Sites ---

orgRoutes.get('/:orgId/sites', async (c) => {
  const orgId = c.req.param('orgId');
  return c.json({ data: [] });
});

orgRoutes.post('/:orgId/sites', zValidator('json', createSiteSchema), async (c) => {
  const orgId = c.req.param('orgId');
  const data = c.req.valid('json');
  return c.json({ id: 'site-uuid', orgId, ...data }, 201);
});

orgRoutes.get('/:orgId/sites/:siteId', async (c) => {
  const { orgId, siteId } = c.req.param();
  return c.json({ id: siteId, orgId, name: 'HQ Office', timezone: 'America/New_York' });
});

orgRoutes.patch('/:orgId/sites/:siteId', async (c) => {
  const { orgId, siteId } = c.req.param();
  const data = await c.req.json();
  return c.json({ id: siteId, orgId, ...data });
});

orgRoutes.delete('/:orgId/sites/:siteId', async (c) => {
  return c.json({ success: true });
});

// --- Enrollment Keys ---

orgRoutes.get('/:orgId/enrollment-keys', async (c) => {
  return c.json({ data: [] });
});

orgRoutes.post('/:orgId/enrollment-keys', async (c) => {
  const orgId = c.req.param('orgId');
  const { name, siteId, expiresAt } = await c.req.json();
  return c.json({
    id: 'key-uuid',
    orgId,
    key: 'BREEZE-XXXX-XXXX-XXXX',
    name,
    siteId,
    expiresAt
  }, 201);
});

orgRoutes.delete('/:orgId/enrollment-keys/:keyId', async (c) => {
  return c.json({ success: true });
});
