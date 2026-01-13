import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

export const alertRoutes = new Hono();

const createRuleSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  targets: z.any(),
  conditions: z.any(),
  cooldownMinutes: z.number().default(15),
  escalationPolicyId: z.string().uuid().optional(),
  notificationChannels: z.array(z.any()).optional(),
  autoResolve: z.boolean().default(true)
});

// --- Alert Rules ---

alertRoutes.get('/rules', async (c) => {
  return c.json({ data: [] });
});

alertRoutes.post('/rules', zValidator('json', createRuleSchema), async (c) => {
  const data = c.req.valid('json');
  return c.json({ id: 'rule-uuid', ...data }, 201);
});

alertRoutes.get('/rules/:id', async (c) => {
  const id = c.req.param('id');
  return c.json({ id, name: 'High CPU Alert', severity: 'high', enabled: true });
});

alertRoutes.patch('/rules/:id', async (c) => {
  const id = c.req.param('id');
  const data = await c.req.json();
  return c.json({ id, ...data });
});

alertRoutes.delete('/rules/:id', async (c) => {
  return c.json({ success: true });
});

// --- Alerts (instances) ---

alertRoutes.get('/', async (c) => {
  const { status, severity, deviceId, page = '1', limit = '50' } = c.req.query();
  return c.json({
    data: [],
    pagination: { page: parseInt(page), limit: parseInt(limit), total: 0 }
  });
});

alertRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  return c.json({
    id,
    ruleId: 'rule-uuid',
    deviceId: 'device-uuid',
    status: 'active',
    severity: 'high',
    title: 'High CPU on SERVER-01',
    triggeredAt: new Date().toISOString()
  });
});

alertRoutes.post('/:id/acknowledge', async (c) => {
  const id = c.req.param('id');
  return c.json({
    id,
    status: 'acknowledged',
    acknowledgedAt: new Date().toISOString()
  });
});

alertRoutes.post('/:id/resolve', async (c) => {
  const id = c.req.param('id');
  const { note } = await c.req.json().catch(() => ({}));
  return c.json({
    id,
    status: 'resolved',
    resolvedAt: new Date().toISOString(),
    resolutionNote: note
  });
});

alertRoutes.post('/:id/suppress', async (c) => {
  const id = c.req.param('id');
  const { durationMinutes } = await c.req.json().catch(() => ({ durationMinutes: 60 }));
  return c.json({
    id,
    status: 'suppressed',
    suppressedUntil: new Date(Date.now() + durationMinutes * 60000).toISOString()
  });
});

// --- Notification Channels ---

alertRoutes.get('/channels', async (c) => {
  return c.json({ data: [] });
});

alertRoutes.post('/channels', async (c) => {
  const data = await c.req.json();
  return c.json({ id: 'channel-uuid', ...data }, 201);
});

alertRoutes.delete('/channels/:id', async (c) => {
  return c.json({ success: true });
});

// --- Escalation Policies ---

alertRoutes.get('/escalation-policies', async (c) => {
  return c.json({ data: [] });
});

alertRoutes.post('/escalation-policies', async (c) => {
  const data = await c.req.json();
  return c.json({ id: 'policy-uuid', ...data }, 201);
});
