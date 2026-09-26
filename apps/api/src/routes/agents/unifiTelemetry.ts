import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import { parseUnifiTopologyV1 } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../../db';
import { listCollectorsForDevice } from '../../services/unifi/unifiCollectorService';
import { enqueueUnifiTelemetry } from '../../jobs/unifiTelemetryWorker';
import { redactOptionalSecretText } from '../../services/secretRedaction';
import { captureException } from '../../services/sentry';
import { adaptUnifiTopology, type UnifiTopologyReceipt } from '../../services/topology/unifiAdapter';
import { loadUnifiCollector, unifiTopologyAdvertisement } from '../../services/topology/unifiAuthority';

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
  sites: z.array(z.object({ id: z.string().min(1), name: z.string().nullable().optional() })).optional(),
  error: z.string().optional(),
  // Optional typed companion (M2 Task 5). Validated separately with the shared
  // unifiTopologyV1 wire schema (size-bounded) so a malformed companion is
  // rejected in its own receipt and never costs the legacy telemetry.
  topologyV1: z.unknown().optional(),
});

/**
 * Synchronous topology ingest for the optional companion, in its own system DB
 * context + transaction (like the heartbeat topology path). Any failure is
 * reported in the receipt; the caller always continues to the legacy enqueue.
 */
async function ingestTopologyCompanion(deviceId: string, collectorId: string, value: unknown): Promise<UnifiTopologyReceipt> {
  const claimed = value && typeof value === 'object' && 'sequence' in value ? (value as { sequence: unknown }).sequence : undefined;
  const reportSequence = typeof claimed === 'string' && /^(0|[1-9]\d{0,19})$/.test(claimed) ? { reportSequence: claimed } : {};
  const parsed = parseUnifiTopologyV1(value);
  if (!parsed.accepted) return { accepted: false, reason: parsed.reason, ...reportSequence, resources: [] };
  try {
    return await withSystemDbAccessContext(() => db.transaction(async () => {
      const collector = await loadUnifiCollector(collectorId);
      if (!collector || collector.collectorDeviceId !== deviceId) return { accepted: false, reason: 'collector_not_owned', ...reportSequence, resources: [] };
      return adaptUnifiTopology(deviceId, collector, parsed.report);
    }));
  } catch (error) {
    console.error('[unifi-telemetry] topology companion ingest failed; legacy telemetry continues:', error instanceof Error ? error.message : error);
    captureException(error);
    return { accepted: false, reason: 'collection_unavailable', ...reportSequence, resources: [] };
  }
}

// GET /agents/:id/unifi-collectors — the collector configs assigned to THIS
// agent's device (decrypted local keys). System context: the agent path is
// unprivileged-pool but reads org-scoped config rows it owns by construction.
unifiTelemetryRoutes.get('/:id/unifi-collectors', async (c) => {
  const agent = c.get('agent') as { deviceId?: string } | undefined;
  if (!agent?.deviceId) return c.json({ error: 'agent device context missing' }, 403);
  const deviceId = agent.deviceId;
  const collectors = await withSystemDbAccessContext(() => listCollectorsForDevice(db, deviceId, {
    topologyAdvertisement: (collectorId) => unifiTopologyAdvertisement(deviceId, collectorId),
  }));
  return c.json({ collectors });
});

// POST /agents/:id/unifi-telemetry — ingest a batched poll; enqueue, don't write inline.
// The optional topologyV1 companion is the one exception: it is ingested
// synchronously BEFORE the legacy enqueue so its receipts (per controller-site
// resource: accepted digest or reason) can be returned for acknowledgement.
unifiTelemetryRoutes.post('/:id/unifi-telemetry', zValidator('json', telemetrySchema), async (c) => {
  const agent = c.get('agent') as { deviceId?: string } | undefined;
  if (!agent?.deviceId) return c.json({ error: 'agent device context missing' }, 403);
  const { topologyV1, ...payload } = c.req.valid('json');
  const topology = topologyV1 === undefined ? undefined : await ingestTopologyCompanion(agent.deviceId, payload.collectorId, topologyV1);
  // Stamp the token-resolved deviceId server-side (never trust a client value);
  // the worker enforces it matches the collector's owner before any write.
  //
  // #2434: `error` is the UniFi controller's own failure text, persisted to
  // unifi_collectors.lastPollError and rendered in the collectors UI — a
  // controller HTTP error can embed the controller API key / bearer token, so
  // redact at this trust boundary before it is enqueued.
  await enqueueUnifiTelemetry({
    ...payload,
    error: redactOptionalSecretText(payload.error),
    deviceId: agent.deviceId,
  });
  return c.json({ accepted: true, ...(topology ? { topology } : {}) }, 202);
});
