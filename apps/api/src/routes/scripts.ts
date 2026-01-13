import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

export const scriptRoutes = new Hono();

const createScriptSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  osTypes: z.array(z.enum(['windows', 'macos', 'linux'])),
  language: z.enum(['powershell', 'bash', 'python', 'cmd']),
  content: z.string(),
  parameters: z.any().optional(),
  timeoutSeconds: z.number().default(300),
  runAs: z.enum(['system', 'user', 'elevated']).default('system')
});

const executeScriptSchema = z.object({
  deviceIds: z.array(z.string().uuid()).optional(),
  groupId: z.string().uuid().optional(),
  parameters: z.record(z.any()).optional()
});

// List scripts
scriptRoutes.get('/', async (c) => {
  const { page = '1', limit = '50', category, search, osType } = c.req.query();

  return c.json({
    data: [],
    pagination: { page: parseInt(page), limit: parseInt(limit), total: 0 }
  });
});

// Create script
scriptRoutes.post('/', zValidator('json', createScriptSchema), async (c) => {
  const data = c.req.valid('json');
  return c.json({ id: 'script-uuid', ...data }, 201);
});

// Get script
scriptRoutes.get('/:id', async (c) => {
  const scriptId = c.req.param('id');
  return c.json({ id: scriptId, name: 'Sample Script', language: 'bash', content: 'echo "Hello"' });
});

// Update script
scriptRoutes.patch('/:id', async (c) => {
  const scriptId = c.req.param('id');
  const data = await c.req.json();
  return c.json({ id: scriptId, ...data });
});

// Delete script
scriptRoutes.delete('/:id', async (c) => {
  const scriptId = c.req.param('id');
  return c.json({ success: true });
});

// Execute script
scriptRoutes.post('/:id/execute', zValidator('json', executeScriptSchema), async (c) => {
  const scriptId = c.req.param('id');
  const data = c.req.valid('json');

  return c.json({
    executionId: 'exec-uuid',
    scriptId,
    status: 'queued',
    devicesTargeted: data.deviceIds?.length || 0
  });
});

// Get script execution history
scriptRoutes.get('/:id/executions', async (c) => {
  const scriptId = c.req.param('id');
  return c.json({ data: [] });
});
