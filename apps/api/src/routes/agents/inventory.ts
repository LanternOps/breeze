import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { zValidator } from '../../lib/validation';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import {
  devices,
  deviceHardware,
  deviceDisks,
  deviceNetwork,
  deviceVulnerabilities,
  softwareInventory,
} from '../../db/schema';
import {
  agentWarrantyInfoSchema,
  updateHardwareSchema,
  updateSoftwareSchema,
  updateDisksSchema,
  updateNetworkSchema,
} from './schemas';
import { sanitizeDate } from './helpers';
import { upsertAgentWarranty } from '../../services/warrantySync';
import { queueWarrantySyncForDevice } from '../../services/warrantyWorker';
import { requireAgentRole } from '../../middleware/requireAgentRole';

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

  await db
    .insert(deviceHardware)
    .values({
      deviceId: device.id,
      orgId: device.orgId,
      ...data,
      updatedAt: new Date()
    })
    .onConflictDoUpdate({
      target: deviceHardware.deviceId,
      set: {
        ...data,
        updatedAt: new Date()
      }
    });

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
  const data = c.req.valid('json');

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  await db.transaction(async (tx) => {
    // The wipe-and-reinsert below churns software_inventory row ids, and
    // device_vulnerabilities.software_inventory_id references them (ON DELETE
    // SET NULL). The fleet aggregation layer displays a NULL-linked finding as
    // an OS finding (vulnerabilityFleetAggregation.ts groupKey), so without
    // repair every software report would misclassify the device's software
    // findings in the UI until the next correlation run. Capture what each
    // finding pointed at, then re-link to the replacement row.
    const linkedFindings = await tx
      .select({
        findingId: deviceVulnerabilities.id,
        name: softwareInventory.name,
        vendor: softwareInventory.vendor,
      })
      .from(deviceVulnerabilities)
      .innerJoin(softwareInventory, eq(deviceVulnerabilities.softwareInventoryId, softwareInventory.id))
      .where(and(
        eq(deviceVulnerabilities.deviceId, device.id),
        eq(softwareInventory.deviceId, device.id)
      ));

    await tx
      .delete(softwareInventory)
      .where(eq(softwareInventory.deviceId, device.id));

    let inserted: { id: string; name: string; vendor: string | null }[] = [];
    if (data.software.length > 0) {
      const now = new Date();
      const rows = data.software.map((item) => ({
        deviceId: device.id,
        orgId: device.orgId,
        name: item.name,
        version: item.version || null,
        vendor: item.vendor || null,
        installDate: sanitizeDate(item.installDate),
        installLocation: item.installLocation || null,
        uninstallString: item.uninstallString || null,
        fileHash: item.fileHash || null,
        hashAlgorithm: item.hashAlgorithm || null,
        lastSeen: now
      }));
      // .returning() serializes up to 10k rows back over the wire — only pay
      // for it when there are findings to re-link.
      if (linkedFindings.length > 0) {
        inserted = await tx.insert(softwareInventory).values(rows).returning({
          id: softwareInventory.id,
          name: softwareInventory.name,
          vendor: softwareInventory.vendor,
        });
      } else {
        await tx.insert(softwareInventory).values(rows);
      }
    }

    if (linkedFindings.length > 0 && inserted.length > 0) {
      // Match by (name, vendor), normalized the same way the correlation
      // layer matches products (lower(trim(...)) — see the
      // softwareProductResolutions join in vulnerabilityCorrelation.ts), so a
      // casing/whitespace change between reports doesn't drop the link.
      // Version is deliberately ignored: upgrades keep the link and the
      // correlation job re-evaluates version ranges on its next run. First
      // row wins for duplicate keys. Findings whose software is gone keep a
      // NULL link; correlateOrg's resolve pass closes them.
      const relinkKey = (name: string, vendor: string | null) =>
        JSON.stringify([name.trim().toLowerCase(), (vendor ?? '').trim().toLowerCase()]);

      const newRowByKey = new Map<string, string>();
      for (const row of inserted) {
        const key = relinkKey(row.name, row.vendor);
        if (!newRowByKey.has(key)) newRowByKey.set(key, row.id);
      }

      const findingIdsByNewRow = new Map<string, string[]>();
      let severed = 0;
      for (const finding of linkedFindings) {
        const newRowId = newRowByKey.get(relinkKey(finding.name, finding.vendor));
        if (!newRowId) {
          severed++;
          continue;
        }
        const ids = findingIdsByNewRow.get(newRowId) ?? [];
        ids.push(finding.findingId);
        findingIdsByNewRow.set(newRowId, ids);
      }

      for (const [newRowId, findingIds] of findingIdsByNewRow) {
        await tx
          .update(deviceVulnerabilities)
          .set({ softwareInventoryId: newRowId, updatedAt: new Date() })
          .where(inArray(deviceVulnerabilities.id, findingIds));
      }

      if (severed > 0) {
        // Expected for genuinely uninstalled software (the next correlation
        // pass resolves those findings), but a spike of these fleet-wide is
        // the signature of truncated agent-side collection silently converting
        // open findings to patched — keep the trail.
        console.warn(
          `[Inventory] Software report for device ${device.id} severed ${severed} vuln finding link(s) with no replacement row (uninstalled or renamed software)`
        );
      }
    }

    if (linkedFindings.length > 0 && inserted.length === 0) {
      // An empty report against a device with linked findings just severed
      // every link in one statement. Legitimate only if all software was
      // actually removed — it is also the signature of a truncated agent-side
      // collection, so leave a trail.
      console.warn(
        `[Inventory] Software report for device ${device.id} emptied the inventory and detached ${linkedFindings.length} vuln finding link(s)`
      );
    }
  });

  return c.json({ success: true, count: data.software.length });
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

  await db.transaction(async (tx) => {
    await tx
      .delete(deviceDisks)
      .where(eq(deviceDisks.deviceId, device.id));

    if (data.disks.length > 0) {
      const now = new Date();
      await tx.insert(deviceDisks).values(
        data.disks.map((disk) => ({
          deviceId: device.id,
          orgId: device.orgId,
          mountPoint: disk.mountPoint,
          device: disk.device || null,
          fsType: disk.fsType || null,
          totalGb: disk.totalGb,
          usedGb: disk.usedGb,
          freeGb: disk.freeGb,
          usedPercent: disk.usedPercent,
          health: disk.health || 'healthy',
          updatedAt: now
        }))
      );
    }
  });

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
  const vpnProvided = data.vpns !== undefined;
  const activeVpns = vpnProvided
    ? data.vpns!.map((vpn) => ({
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
    await tx
      .delete(deviceNetwork)
      .where(eq(deviceNetwork.deviceId, device.id));

    if (data.adapters.length > 0) {
      await tx.insert(deviceNetwork).values(
        data.adapters.map((adapter) => ({
          deviceId: device.id,
          orgId: device.orgId,
          interfaceName: adapter.interfaceName,
          macAddress: adapter.macAddress || null,
          ipAddress: adapter.ipAddress || null,
          ipType: adapter.ipType || 'ipv4',
          isPrimary: adapter.isPrimary || false,
          updatedAt: now
        }))
      );
    }

    // Leave devices.activeVpns untouched when the agent didn't report VPN
    // state, so an old agent (or a transient collection failure) never
    // overwrites last-known-good.
    if (vpnProvided) {
      await tx
        .update(devices)
        .set({ activeVpns, updatedAt: now })
        .where(eq(devices.id, device.id));
    }
  });

  return c.json({
    success: true,
    count: data.adapters.length,
    vpnCount: vpnProvided ? activeVpns!.length : null
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
