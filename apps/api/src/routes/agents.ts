import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

export const agentRoutes = new Hono();

const enrollSchema = z.object({
  enrollmentKey: z.string(),
  hostname: z.string(),
  osType: z.enum(['windows', 'macos', 'linux']),
  osVersion: z.string(),
  architecture: z.string(),
  hardwareInfo: z.object({
    cpuModel: z.string().optional(),
    cpuCores: z.number().optional(),
    ramTotalMb: z.number().optional(),
    serialNumber: z.string().optional(),
    manufacturer: z.string().optional(),
    model: z.string().optional()
  }).optional()
});

const heartbeatSchema = z.object({
  metrics: z.object({
    cpuPercent: z.number(),
    ramPercent: z.number(),
    ramUsedMb: z.number(),
    diskPercent: z.number(),
    diskUsedGb: z.number(),
    networkInBytes: z.number().optional(),
    networkOutBytes: z.number().optional(),
    processCount: z.number().optional()
  }),
  status: z.enum(['ok', 'warning', 'error']),
  agentVersion: z.string(),
  pendingReboot: z.boolean().optional(),
  lastUser: z.string().optional()
});

const commandResultSchema = z.object({
  status: z.enum(['completed', 'failed', 'timeout']),
  exitCode: z.number().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  durationMs: z.number()
});

// Agent enrollment
agentRoutes.post('/enroll', zValidator('json', enrollSchema), async (c) => {
  const data = c.req.valid('json');

  // TODO: Validate enrollment key, create device record
  return c.json({
    agentId: 'agent-uuid',
    authToken: 'agent-auth-token',
    config: {
      heartbeatIntervalSeconds: 60,
      metricsCollectionIntervalSeconds: 30
    }
  });
});

// Agent heartbeat
agentRoutes.post('/:id/heartbeat', zValidator('json', heartbeatSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');

  // TODO: Update device status, metrics; return queued commands
  return c.json({
    commands: [],
    configUpdate: null,
    upgradeTo: null
  });
});

// Submit command result
agentRoutes.post(
  '/:id/commands/:commandId/result',
  zValidator('json', commandResultSchema),
  async (c) => {
    const agentId = c.req.param('id');
    const commandId = c.req.param('commandId');
    const data = c.req.valid('json');

    // TODO: Store command result
    return c.json({ success: true });
  }
);

// Get agent config
agentRoutes.get('/:id/config', async (c) => {
  const agentId = c.req.param('id');

  // TODO: Return agent configuration
  return c.json({
    heartbeatIntervalSeconds: 60,
    metricsCollectionIntervalSeconds: 30,
    enabledCollectors: ['hardware', 'software', 'metrics', 'network']
  });
});
