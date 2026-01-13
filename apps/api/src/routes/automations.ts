import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

export const automationRoutes = new Hono();

const createAutomationSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  trigger: z.object({
    type: z.enum(['schedule', 'event', 'webhook', 'manual']),
    cron: z.string().optional(),
    timezone: z.string().optional(),
    event: z.string().optional()
  }),
  conditions: z.any().optional(),
  actions: z.array(z.any()),
  onFailure: z.enum(['stop', 'continue', 'notify']).default('stop'),
  notificationTargets: z.any().optional()
});

const createPolicySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  targets: z.any(),
  rules: z.array(z.any()),
  enforcement: z.enum(['monitor', 'warn', 'enforce']).default('monitor'),
  checkIntervalMinutes: z.number().default(60),
  remediationScriptId: z.string().uuid().optional()
});

// List automations
automationRoutes.get('/', async (c) => {
  return c.json({ data: [] });
});

// Create automation
automationRoutes.post('/', zValidator('json', createAutomationSchema), async (c) => {
  const data = c.req.valid('json');
  return c.json({ id: 'automation-uuid', ...data }, 201);
});

// Get automation
automationRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  return c.json({ id, name: 'Sample Automation', enabled: true });
});

// Update automation
automationRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const data = await c.req.json();
  return c.json({ id, ...data });
});

// Delete automation
automationRoutes.delete('/:id', async (c) => {
  return c.json({ success: true });
});

// Manual trigger
automationRoutes.post('/:id/run', async (c) => {
  const id = c.req.param('id');
  return c.json({ runId: 'run-uuid', automationId: id, status: 'running' });
});

// Get runs
automationRoutes.get('/:id/runs', async (c) => {
  return c.json({ data: [] });
});

// --- Policies ---

automationRoutes.get('/policies', async (c) => {
  return c.json({ data: [] });
});

automationRoutes.post('/policies', zValidator('json', createPolicySchema), async (c) => {
  const data = c.req.valid('json');
  return c.json({ id: 'policy-uuid', ...data }, 201);
});

automationRoutes.get('/policies/:id', async (c) => {
  const id = c.req.param('id');
  return c.json({ id, name: 'Sample Policy', enabled: true });
});

automationRoutes.patch('/policies/:id', async (c) => {
  const id = c.req.param('id');
  const data = await c.req.json();
  return c.json({ id, ...data });
});

automationRoutes.delete('/policies/:id', async (c) => {
  return c.json({ success: true });
});

automationRoutes.get('/policies/:id/compliance', async (c) => {
  const id = c.req.param('id');
  return c.json({
    policyId: id,
    summary: { compliant: 0, nonCompliant: 0, pending: 0, error: 0 },
    devices: []
  });
});
