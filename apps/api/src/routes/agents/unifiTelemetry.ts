import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import { db, withSystemDbAccessContext } from '../../db';
import { listCollectorsForDevice } from '../../services/unifi/unifiCollectorService';
import { enqueueUnifiTelemetry } from '../../jobs/unifiTelemetryWorker';

/**
 * UniFi Phase 2a agent-side telemetry endpoints. Mounted under `/agents`, so the
 * agent reaches them at `/agents/:id/unifi-collectors` and
 * `/agents/:id/unifi-telemetry`. `agentAuthMiddleware` (applied by the parent
 * agentRoutes on `/:id/*`) sets `c.get('agent')` with the token-resolved
 * `deviceId`; we key off that, NOT the `:id` path param, so an agent can only
 * ever see/ingest for its own device. `requireAgentRole` blocks the watchdog
 * credential (telemetry is the main agent's job, not the watchdog's).
 */
export const unifiTelemetryRoutes = new Hono();

unifiTelemetryRoutes.use('/:id/unifi-collectors', requireAgentRole);
unifiTelemetryRoutes.use('/:id/unifi-telemetry', requireAgentRole);

const deviceDto = z.object({
  // Non-empty: the telemetry upsert key is (collectorId, unifiDeviceId); an empty
  // id would collapse multiple devices to one row, last-write-wins.
  unifiDeviceId: z.string().min(1),
  unifiSiteId: z.string().nullable().optional(),
  mac: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  uptimeSeconds: z.number().nullable().optional(),
  cpuPct: z.number().nullable().optional(),
  memPct: z.number().nullable().optional(),
  txBytes: z.number().nullable().optional(),
  rxBytes: z.number().nullable().optional(),
  numClients: z.number().nullable().optional(),
  poePorts: z.unknown().optional(),
  raw: z.unknown(),
});
const clientDto = z.object({
  mac: z.string(),
  unifiSiteId: z.string().nullable().optional(),
  hostname: z.string().nullable().optional(),
  ip: z.string().nullable().optional(),
  connectedDeviceId: z.string().nullable().optional(),
  uplinkPortIdx: z.number().nullable().optional(),
  isWired: z.boolean().nullable().optional(),
  ssid: z.string().nullable().optional(),
  vlan: z.number().nullable().optional(),
  signalDbm: z.number().nullable().optional(),
  txBytes: z.number().nullable().optional(),
  rxBytes: z.number().nullable().optional(),
  uptimeSeconds: z.number().nullable().optional(),
  raw: z.unknown(),
});
const telemetrySchema = z.object({
  collectorId: z.string().min(1),
  polledAt: z.string(),
  firmwareOk: z.boolean(),
  devices: z.array(deviceDto),
  clients: z.array(clientDto),
  error: z.string().optional(),
});

// GET /agents/:id/unifi-collectors — the collector configs assigned to THIS
// agent's device (decrypted local keys). System context: the agent path is
// unprivileged-pool but reads org-scoped config rows it owns by construction.
unifiTelemetryRoutes.get('/:id/unifi-collectors', async (c) => {
  const agent = c.get('agent') as { deviceId?: string } | undefined;
  if (!agent?.deviceId) return c.json({ error: 'agent device context missing' }, 403);
  const collectors = await withSystemDbAccessContext(() => listCollectorsForDevice(db, agent.deviceId as string));
  return c.json({ collectors });
});

// POST /agents/:id/unifi-telemetry — ingest a batched poll; enqueue, don't write inline.
unifiTelemetryRoutes.post('/:id/unifi-telemetry', zValidator('json', telemetrySchema), async (c) => {
  const agent = c.get('agent') as { deviceId?: string } | undefined;
  if (!agent?.deviceId) return c.json({ error: 'agent device context missing' }, 403);
  const payload = c.req.valid('json');
  // Stamp the token-resolved deviceId server-side (never trust a client value);
  // the worker enforces it matches the collector's owner before any write.
  await enqueueUnifiTelemetry({ ...payload, deviceId: agent.deviceId });
  return c.json({ accepted: true }, 202);
});
