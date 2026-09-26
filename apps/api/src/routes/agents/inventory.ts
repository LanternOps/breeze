import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { vpnPresenceIngestSchema } from '@breeze/shared';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  devices,
  deviceHardware,
} from '../../db/schema';
import { syncDeviceDisks, syncDeviceNetwork, writeHardwareReport } from '../../services/inventoryChildSync';
import {
  agentMemoryInventorySchema,
  agentWarrantyInfoSchema,
  updateHardwareSchema,
  updateSoftwareSchema,
  updateDisksSchema,
  updateNetworkSchema,
  type AgentMemoryInventory,
} from './schemas';
import { sanitizeDate } from './helpers';
import { upsertAgentWarranty } from '../../services/warrantySync';
import { queueWarrantySyncForDevice } from '../../services/warrantyWorker';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import {
  ingestSoftwareInventoryReport,
  SoftwareInventoryLockTimeoutError,
  SoftwareInventoryObservationConflictError,
} from '../../services/softwareInventoryObservations';

export const inventoryRoutes = new Hono();
// Inventory ingest is the main agent's job; reject watchdog-role tokens.
inventoryRoutes.use('*', requireAgentRole);

inventoryRoutes.put('/:id/hardware', bodyLimit({ maxSize: 5 * 1024 * 1024, onError: (c) => c.json({ error: 'Request body too large' }, 413) }), zValidator('json', updateHardwareSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  // Capture the prior warranty-relevant identity so we can detect the
  // empty -> populated transition after the upsert. Warranty sync at
  // enrollment time runs before the first inventory report, so it hits the
  // "no serial/manufacturer" early-return and skips; nothing re-fires it once
  // hardware arrives, leaving the device with no warranty row until the next
  // 6-hour batch sweep or a manual refresh (issue #1732).
  const [priorHw] = await db
    .select({
      serialNumber: deviceHardware.serialNumber,
      manufacturer: deviceHardware.manufacturer,
    })
    .from(deviceHardware)
    .where(eq(deviceHardware.deviceId, device.id))
    .limit(1);

  // #5351: the optional `memory` block is pulled out BEFORE the upsert (the
  // hardware columns are spread from the body) and validated on its own. An
  // invalid block is logged and ignored — the base hardware still saves and
  // stored memory stays untouched; it is never truncated into a partial
  // snapshot. Absent = untouched too (older agents, failed collection).
  const { memory: rawMemory, ...hardware } = data;
  let memory: AgentMemoryInventory | null = null;
  if (rawMemory !== undefined && rawMemory !== null) {
    const parsed = agentMemoryInventorySchema.safeParse(rawMemory);
    if (parsed.success) {
      memory = parsed.data;
    } else {
      const issues = parsed.error.issues.slice(0, 3)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
      console.warn(`[agents.hardware] ignored invalid memory block for device ${device.id}: ${issues}`);
    }
  }

  // One short transaction: the hardware upsert, the memory_* summary columns
  // and the per-slot rows commit together (services/inventoryChildSync.ts).
  await db.transaction((tx) => writeHardwareReport(tx, device, hardware, memory, new Date()));

  // Enqueue a warranty sync only when this report makes both the manufacturer
  // and serial number known for the first time (empty/absent -> populated).
  // queueWarrantySyncForDevice uses a stable jobId so duplicate enqueues are
  // deduplicated by BullMQ, but gating on the transition avoids redundant Dell
  // API calls on every routine hardware re-report. Fire-and-forget.
  const wasIdentified = Boolean(priorHw?.manufacturer && priorHw?.serialNumber);
  const nowIdentified = Boolean(data.manufacturer && data.serialNumber);
  if (!wasIdentified && nowIdentified) {
    queueWarrantySyncForDevice(device.id).catch((err) => {
      console.error(
        `[Inventory] Failed to queue warranty sync on hardware report for device ${device.id}:`,
        err instanceof Error ? err.message : err
      );
    });
  }

  return c.json({ success: true });
});

inventoryRoutes.put('/:id/software', bodyLimit({ maxSize: 5 * 1024 * 1024, onError: (c) => c.json({ error: 'Request body too large' }, 413) }), zValidator('json', updateSoftwareSchema), async (c) => {
  const agentId = c.req.param('id');
  const report = c.req.valid('json');

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  try {
    const decision = await ingestSoftwareInventoryReport({
      device: {
        id: device.id,
        orgId: device.orgId,
        agentVersion: device.agentVersion,
      },
      report,
      receivedAt: new Date(),
    });
    return c.json({ success: true, ...decision });
  } catch (error) {
    if (error instanceof SoftwareInventoryObservationConflictError) {
      return c.json({ error: 'Software inventory observation conflict' }, 409);
    }
    // Lock contention, not a fault: nothing was written and the same report is
    // still valid, so tell the agent to come back rather than 500-ing (#5181).
    // The agent's next 15-minute inventory push re-sends it regardless, so the
    // retryable status is honest either way — 503 is what keeps the give-up out
    // of the error-level 5xx noise.
    //
    // Retry-After is 5s, and the value matters. `sendInventoryData`
    // (agent/internal/heartbeat/heartbeat.go) gives the whole call a 30s
    // context, and `httputil.Do` REPLACES its 1s/2s/4s backoff with any
    // Retry-After we send. This ingest can already have burned ~15s of that
    // budget (3 attempts × a 5s `lock_timeout`), so a large value — 60, say —
    // would be cut short by the context deadline and the agent would get ZERO
    // in-process retries, strictly worse than the 500 path it replaces. 5s
    // leaves room for one real retry while still giving the contending
    // `correlateOrg` pass time to release its locks; httputil jitters it, so a
    // fleet-wide contention event does not re-synchronise on the way back.
    if (error instanceof SoftwareInventoryLockTimeoutError) {
      c.header('Retry-After', '5');
      return c.json({
        error: 'Software inventory ingest is contended; retry this report later',
        code: 'software_inventory_lock_timeout',
      }, 503);
    }
    throw error;
  }
});

inventoryRoutes.put('/:id/disks', bodyLimit({ maxSize: 5 * 1024 * 1024, onError: (c) => c.json({ error: 'Request body too large' }, 413) }), zValidator('json', updateDisksSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  // Diff + upsert, not delete + re-insert: an unchanged report must not take
  // the partner-export org lock (#6698, services/inventoryChildSync.ts).
  await db.transaction((tx) => syncDeviceDisks(tx, device, data.disks, new Date()));

  return c.json({ success: true, count: data.disks.length });
});

inventoryRoutes.put('/:id/network', bodyLimit({ maxSize: 5 * 1024 * 1024, onError: (c) => c.json({ error: 'Request body too large' }, 413) }), zValidator('json', updateNetworkSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  const now = new Date();

  // Active-VPN-client presence snapshot (#2139). Only present when the agent
  // successfully collected VPN state — a failed collection OMITS the key (see
  // sendNetworkInventory) so we DON'T overwrite the stored snapshot and clobber
  // a live tunnel to "no VPN". We stamp reportedAt server-side per entry.
  // Semantics of the stored column: null = never successfully reported (old
  // agent or every collection failed); [] = reported with no active VPN.
  // #3550: validate VPN entries PER-ENTRY here, not in the request schema, so a
  // single malformed entry can't 400 the whole payload and discard the valid
  // adapter inventory in the same request. Bad entries are dropped and counted.
  const rawVpns = data.vpns;
  const salvagedVpns: z.infer<typeof vpnPresenceIngestSchema>[] = [];
  let droppedVpnCount = 0;
  if (rawVpns !== undefined) {
    for (const entry of rawVpns) {
      const parsed = vpnPresenceIngestSchema.safeParse(entry);
      if (parsed.success) salvagedVpns.push(parsed.data);
      else droppedVpnCount += 1;
    }
  }
  if (droppedVpnCount > 0) {
    console.warn(
      `[agents.network] dropped ${droppedVpnCount} malformed VPN ` +
        `entr${droppedVpnCount === 1 ? 'y' : 'ies'} for agent ${agentId}; ` +
        `kept ${salvagedVpns.length}, adapters preserved`,
    );
  }
  // Treat an all-malformed report like a FAILED collection: leave the stored
  // snapshot untouched rather than overwriting a live tunnel to "no VPN". A
  // genuinely empty report (agent sent [], nothing dropped) is still honored as
  // "reported, no active VPN".
  const vpnProvided = rawVpns !== undefined && !(salvagedVpns.length === 0 && droppedVpnCount > 0);
  const activeVpns = vpnProvided
    ? salvagedVpns.map((vpn) => ({
        provider: vpn.provider,
        active: vpn.active,
        interfaceName: vpn.interfaceName,
        ipv4: vpn.ipv4,
        ipv6: vpn.ipv6,
        dnsName: vpn.dnsName,
        detectionSource: vpn.detectionSource,
        reportedAt: now.toISOString()
      }))
    : null;

  await db.transaction(async (tx) => {
    // Lock ordering: take the devices-row lock BEFORE touching device_network.
    // Every other writer that spans both tables (re-enrollment, site move,
    // moveOrg) locks devices first, then child tables — updating devices last
    // here inverted that order and deadlocked against a concurrent re-enroll
    // (Postgres 40P01, Sentry BREEZE-1S).
    //
    // Leave devices.activeVpns untouched when the agent didn't report VPN
    // state, so an old agent (or a transient collection failure) never
    // overwrites last-known-good.
    if (vpnProvided) {
      await tx
        .update(devices)
        .set({ activeVpns, updatedAt: now })
        .where(eq(devices.id, device.id));
    }

    await syncDeviceNetwork(tx, device, data.adapters, now);
  });

  return c.json({
    success: true,
    count: data.adapters.length,
    vpnCount: vpnProvided ? activeVpns!.length : null,
    // Machine-readable partial-ingest signal (#3550): how many VPN entries were
    // dropped as malformed. 0 on a clean ingest; lets a future agent surface a
    // persistent serialization regression instead of it hiding behind a 200.
    droppedVpnCount
  });
});

// PUT /:id/warranty-info — agent reports locally-collected warranty data (e.g. Apple plist)
inventoryRoutes.put(
  '/:id/warranty-info',
  bodyLimit({ maxSize: 1 * 1024 * 1024, onError: (c) => c.json({ error: 'Request body too large' }, 413) }),
  zValidator('json', agentWarrantyInfoSchema),
  async (c) => {
    const agentId = c.req.param('id');
    const data = c.req.valid('json');

    const [device] = await db
      .select({ id: devices.id, orgId: devices.orgId })
      .from(devices)
      .where(eq(devices.agentId, agentId))
      .limit(1);

    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // Get serial number from hardware table for the warranty record
    const [hw] = await db
      .select({ serialNumber: deviceHardware.serialNumber })
      .from(deviceHardware)
      .where(eq(deviceHardware.deviceId, device.id))
      .limit(1);

    await upsertAgentWarranty(device.id, device.orgId, {
      source: data.source,
      manufacturer: data.manufacturer,
      serialNumber: hw?.serialNumber ?? null,
      coverageEndDate: data.coverageEndDate ?? null,
      coverageStartDate: data.coverageStartDate ?? null,
      coverageType: data.coverageType ?? null,
      coverageKind: data.coverageKind ?? null,
    });

    return c.json({ success: true });
  }
);
