import { Hono } from 'hono';
import type { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { and, eq, sql } from 'drizzle-orm';
import { db, type Database } from '../../db';
import { devices, patches, devicePatches } from '../../db/schema';
import { enqueueWingetReleaseTest } from '../../jobs/wingetReleaseTestWorker';
import { writeAuditEvent } from '../../services/auditEvents';
import { enrichFromCatalog } from '../../services/thirdPartyEnrichment';
import { submitInstalledPatchesSchema, submitPatchesSchema, submitPendingPatchesSchema } from './schemas';
import { inferPatchOsType, parseDate, sanitizeDate } from './helpers';
import { requireAgentRole } from '../../middleware/requireAgentRole';

type PendingPatchData = z.infer<typeof submitPendingPatchesSchema>['patches'][number];
type InstalledPatchData = z.infer<typeof submitInstalledPatchesSchema>['installed'][number];
type PatchIngestDevice = { id: string; orgId: string; osType: string | null };
type PatchIngestExecutor = Pick<Database, 'insert' | 'update'>;

// Derive vendor from package id; ignore agent-supplied vendor for winget-style ids.
function deriveVendor(packageId: string | null | undefined, fallback: string | null | undefined): string | null {
  if (packageId && /^[^.]+\.[^.]+/.test(packageId)) {
    return packageId.split('.')[0] ?? fallback ?? null;
  }
  return fallback ?? null;
}

async function getDeviceForPatchIngest(agentId: string): Promise<PatchIngestDevice | null> {
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return null;
  }

  return {
    id: device.id,
    orgId: device.orgId,
    osType: device.osType ?? null,
  };
}

function uniqueSourcesFromPendingPatches(patchList: PendingPatchData[]): string[] {
  return [...new Set(patchList.map((patch) => patch.source))];
}

async function markAllDevicePatchesMissing(executor: PatchIngestExecutor, deviceId: string): Promise<void> {
  await executor
    .update(devicePatches)
    .set({ status: 'missing', lastCheckedAt: new Date() })
    .where(eq(devicePatches.deviceId, deviceId));
}

async function markPendingDevicePatchesMissing(
  executor: PatchIngestExecutor,
  deviceId: string,
  sources: string[],
): Promise<void> {
  const conditions = [
    eq(devicePatches.deviceId, deviceId),
    eq(devicePatches.status, 'pending'),
  ];

  if (sources.length > 0) {
    conditions.push(sql`${devicePatches.patchId} IN (
      SELECT ${patches.id}
      FROM ${patches}
      WHERE ${patches.source} IN (${sql.join(sources.map((source) => sql`${source}`), sql`, `)})
    )`);
  }

  await executor
    .update(devicePatches)
    .set({ status: 'missing', lastCheckedAt: new Date() })
    .where(and(...conditions));
}

async function upsertPendingPatches(
  executor: PatchIngestExecutor,
  device: PatchIngestDevice,
  patchList: PendingPatchData[],
): Promise<void> {
  for (const patchData of patchList) {
    const externalId = patchData.externalId ||
      patchData.kbNumber ||
      `${patchData.source}:${patchData.name}:${patchData.version || 'latest'}`;
    const inferredOsType = inferPatchOsType(patchData.source, device.osType);
    const derivedVendor = deriveVendor(patchData.packageId, patchData.vendor);
    const enriched = await enrichFromCatalog({
      source: patchData.source,
      packageId: patchData.packageId ?? null,
      title: patchData.name,
      vendor: derivedVendor,
      severity: patchData.severity ?? null,
      category: patchData.category ?? null,
    });

    const [patch] = await executor
      .insert(patches)
      .values({
        source: patchData.source,
        externalId: externalId,
        title: enriched.title,
        description: patchData.description || null,
        severity: enriched.severity ?? 'unknown',
        category: enriched.category,
        releaseDate: sanitizeDate(patchData.releaseDate),
        requiresReboot: patchData.requiresRestart || false,
        downloadSizeMb: patchData.size ? Math.ceil(patchData.size / (1024 * 1024)) : null,
        vendor: enriched.vendor,
        packageId: patchData.packageId ?? null,
        version: patchData.version ?? null,
        ...(inferredOsType ? { osTypes: [inferredOsType] } : {})
      })
      .onConflictDoUpdate({
        target: [patches.source, patches.externalId],
        set: {
          title: enriched.title,
          description: patchData.description || null,
          severity: enriched.severity ?? 'unknown',
          category: enriched.category,
          requiresReboot: patchData.requiresRestart || false,
          vendor: enriched.vendor ?? sql`${patches.vendor}`,
          packageId: patchData.packageId ?? sql`${patches.packageId}`,
          version: patchData.version ?? sql`${patches.version}`,
          ...(inferredOsType
            ? {
                osTypes: sql`CASE
                  WHEN ${inferredOsType} = ANY(COALESCE(${patches.osTypes}, ARRAY[]::text[]))
                  THEN COALESCE(${patches.osTypes}, ARRAY[]::text[])
                  ELSE COALESCE(${patches.osTypes}, ARRAY[]::text[]) || ARRAY[${inferredOsType}]::text[]
                END`
              }
            : {}),
          updatedAt: new Date()
        }
      })
      .returning();

    if (!patch) {
      continue;
    }

    if (
      enriched.matchedCatalogId &&
      patchData.version &&
      process.env.ENABLE_AI_PATCH_TESTING === '1'
    ) {
      // Fire-and-forget - don't block the patch submit on test queueing.
      enqueueWingetReleaseTest({
        catalogId: enriched.matchedCatalogId,
        version: patchData.version,
      }).catch((err) => {
        console.error('[ReleaseTest] enqueue failed', err);
      });
    }

    await executor
      .insert(devicePatches)
      .values({
        deviceId: device.id,
        orgId: device.orgId,
        patchId: patch.id,
        status: 'pending',
        lastCheckedAt: new Date()
      })
      .onConflictDoUpdate({
        target: [devicePatches.deviceId, devicePatches.patchId],
        set: {
          status: 'pending',
          lastCheckedAt: new Date(),
          updatedAt: new Date()
        }
      });
  }
}

async function upsertInstalledPatches(
  executor: PatchIngestExecutor,
  device: PatchIngestDevice,
  patchList: InstalledPatchData[],
): Promise<number> {
  let processed = 0;
  for (const patchData of patchList) {
    // Linux package-manager inventories are owned by software_inventory. They
    // are not installed patch/update records and must not be allowed to flip
    // actionable Linux update rows from pending to installed.
    if (patchData.source === 'linux') {
      continue;
    }

    const externalId = patchData.externalId ||
      patchData.kbNumber ||
      `${patchData.source}:${patchData.name}:${patchData.version || 'latest'}`;
    const inferredOsType = inferPatchOsType(patchData.source, device.osType);

    const [patch] = await executor
      .insert(patches)
      .values({
        source: patchData.source,
        externalId: externalId,
        title: patchData.name,
        severity: 'unknown',
        category: patchData.category || null,
        vendor: deriveVendor(patchData.packageId, patchData.vendor),
        packageId: patchData.packageId ?? null,
        version: patchData.version ?? null,
        ...(inferredOsType ? { osTypes: [inferredOsType] } : {})
      })
      .onConflictDoUpdate({
        target: [patches.source, patches.externalId],
        set: {
          title: patchData.name,
          category: patchData.category || null,
          vendor: deriveVendor(patchData.packageId, patchData.vendor) ?? sql`${patches.vendor}`,
          packageId: patchData.packageId ?? sql`${patches.packageId}`,
          version: patchData.version ?? sql`${patches.version}`,
          ...(inferredOsType
            ? {
                osTypes: sql`CASE
                  WHEN ${inferredOsType} = ANY(COALESCE(${patches.osTypes}, ARRAY[]::text[]))
                  THEN COALESCE(${patches.osTypes}, ARRAY[]::text[])
                  ELSE COALESCE(${patches.osTypes}, ARRAY[]::text[]) || ARRAY[${inferredOsType}]::text[]
                END`
              }
            : {}),
          updatedAt: new Date()
        }
      })
      .returning();

    if (!patch) {
      continue;
    }

    const installedAt = parseDate(patchData.installedAt);
    // Installed inventory must not downgrade an actionable 'pending' row.
    // Package managers report a pending upgrade and the installed package under
    // the SAME (source, externalId) — e.g. `winget list` includes every package
    // that `winget upgrade` just reported — so an unconditional flip erased all
    // pending third-party rows moments after the pending submit wrote them.
    // installedVersion still updates: it's the currently-installed version
    // either way. A row whose upgrade completed self-heals on the next scan
    // (pending sweep → 'missing' → this upsert → 'installed').
    await executor
      .insert(devicePatches)
      .values({
        deviceId: device.id,
        orgId: device.orgId,
        patchId: patch.id,
        status: 'installed',
        installedAt: installedAt,
        installedVersion: patchData.version || null,
        lastCheckedAt: new Date()
      })
      .onConflictDoUpdate({
        target: [devicePatches.deviceId, devicePatches.patchId],
        set: {
          status: sql`CASE WHEN ${devicePatches.status} = 'pending' THEN ${devicePatches.status} ELSE 'installed' END`,
          installedAt: sql`CASE WHEN ${devicePatches.status} = 'pending' THEN ${devicePatches.installedAt} ELSE ${installedAt} END`,
          installedVersion: patchData.version || null,
          lastCheckedAt: new Date(),
          updatedAt: new Date()
        }
      });
    processed++;
  }
  return processed;
}

/**
 * Bound tombstone growth (#1004): delete device_patches rows that have stayed
 * 'missing' (absent from every scan) longer than the grace window.
 *
 * `updatedAt` is bumped only when a scan actually reports the patch — the bulk
 * mark-missing in the scan ingest sets `status='missing'` + `lastCheckedAt` but
 * leaves `updatedAt` untouched — so `updatedAt` dates the patch's last real
 * sighting. A transient partial-provider failure (e.g. winget fails while
 * chocolatey succeeds under the shared 'third_party' source bucket) self-heals:
 * the row is re-upserted on the next clean scan inside the window, so only
 * genuinely-removed packages age out. The window is generous (default 7 days,
 * `PATCH_TOMBSTONE_PRUNE_AFTER_HOURS`) so a missed scan never prunes prematurely.
 * Scoped to a single device + org (cross-tenant safe).
 */
export async function pruneStaleTombstones(
  executor: Database,
  deviceId: string,
  orgId: string,
  pruneAfterHours = Number(process.env.PATCH_TOMBSTONE_PRUNE_AFTER_HOURS) || 168,
): Promise<void> {
  await executor
    .delete(devicePatches)
    .where(
      and(
        eq(devicePatches.deviceId, deviceId),
        eq(devicePatches.orgId, orgId),
        eq(devicePatches.status, 'missing'),
        sql`${devicePatches.updatedAt} < now() - make_interval(hours => ${pruneAfterHours})`,
      ),
    );
}

export const patchesRoutes = new Hono();
// Patch/compliance scan ingest is the main agent's job; reject watchdog-role
// tokens so a weaker credential can't falsify operator-facing patch posture (F3).
patchesRoutes.use('*', requireAgentRole);

patchesRoutes.put('/:id/patches/pending', zValidator('json', submitPendingPatchesSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');
  const agent = c.get('agent') as { orgId?: string; agentId?: string } | undefined;
  console.log(`[PATCHES] Agent ${agentId} submitting ${data.patches.length} pending`);

  const device = await getDeviceForPatchIngest(agentId);
  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  const sources = data.source ? [data.source] : uniqueSourcesFromPendingPatches(data.patches);

  await db.transaction(async (tx) => {
    if (data.full) {
      if (data.coveredSources === undefined) {
        // Legacy agents send full scans without coverage info: sweep all sources.
        // Log the path so an operator can tell a legacy sweep-all from a
        // coverage-scoped sweep when diagnosing lingering-pending rows (#2217).
        console.log(`[PATCHES] Agent ${agentId} full scan (legacy, no coverage): sweeping ALL pending sources`);
        await markPendingDevicePatchesMissing(tx, device.id, []);
      } else if (data.coveredSources.length > 0) {
        // Coverage-aware full scan (#2217): only sweep sources whose providers
        // actually ran. Skipped providers (e.g. winget without a helper
        // session) keep their pending rows instead of being tombstoned.
        console.log(`[PATCHES] Agent ${agentId} full scan (coverage-scoped): sweeping only [${data.coveredSources.join(', ')}]`);
        await markPendingDevicePatchesMissing(tx, device.id, data.coveredSources);
      } else {
        // full with coveredSources: [] means EVERY registered provider on the
        // device was skipped or failed — a genuinely degraded agent. We sweep
        // nothing (correct: don't tombstone rows nothing looked at), but warn so
        // "why are this device's pending patches never reconciled?" is greppable
        // instead of a silent no-op (#2217).
        console.warn(`[PATCHES] Agent ${agentId} full scan covered ZERO sources — every provider skipped/failed; no tombstoning performed`);
      }
    } else if (sources.length > 0) {
      await markPendingDevicePatchesMissing(tx, device.id, sources);
    }
    await upsertPendingPatches(tx, device, data.patches);
  });

  await pruneStaleTombstones(db, device.id, device.orgId);

  writeAuditEvent(c, {
    orgId: agent?.orgId ?? device.orgId,
    actorType: 'agent',
    actorId: agent?.agentId ?? agentId,
    action: 'agent.patches.pending.submit',
    resourceType: 'device',
    resourceId: device.id,
    details: {
      pendingCount: data.patches.length,
      source: data.source ?? null,
      full: data.full,
      coveredSources: data.coveredSources ?? null,
    },
  });

  return c.json({ success: true, pending: data.patches.length });
});

patchesRoutes.put('/:id/patches/installed', zValidator('json', submitInstalledPatchesSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');
  const agent = c.get('agent') as { orgId?: string; agentId?: string } | undefined;
  console.log(`[PATCHES] Agent ${agentId} submitting ${data.installed.length} installed`);

  const device = await getDeviceForPatchIngest(agentId);
  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  let installedCount = 0;
  await db.transaction(async (tx) => {
    installedCount = await upsertInstalledPatches(tx, device, data.installed);
  });

  writeAuditEvent(c, {
    orgId: agent?.orgId ?? device.orgId,
    actorType: 'agent',
    actorId: agent?.agentId ?? agentId,
    action: 'agent.patches.installed.submit',
    resourceType: 'device',
    resourceId: device.id,
    details: {
      installedCount,
      ignoredLinuxPackageCount: data.installed.length - installedCount,
    },
  });

  return c.json({ success: true, installed: installedCount, ignored: data.installed.length - installedCount });
});

patchesRoutes.put('/:id/patches', zValidator('json', submitPatchesSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');
  const agent = c.get('agent') as { orgId?: string; agentId?: string } | undefined;
  const submittedInstalledCount = data.installed?.length || 0;
  console.log(`[PATCHES] Agent ${agentId} submitting ${data.patches.length} pending, ${submittedInstalledCount} installed`);

  const device = await getDeviceForPatchIngest(agentId);
  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  let installedCount = 0;
  await db.transaction(async (tx) => {
    await markAllDevicePatchesMissing(tx, device.id);
    await upsertPendingPatches(tx, device, data.patches);
    installedCount = await upsertInstalledPatches(tx, device, data.installed ?? []);
  });

  // Prune stale tombstones after the scan commits. Outside the txn on purpose:
  // it reads the just-committed state, and a crash before it runs is harmless
  // (the next scan prunes). Runs in the same request DB context as the ingest.
  await pruneStaleTombstones(db, device.id, device.orgId);

  writeAuditEvent(c, {
    orgId: agent?.orgId ?? device.orgId,
    actorType: 'agent',
    actorId: agent?.agentId ?? agentId,
    action: 'agent.patches.submit',
    resourceType: 'device',
    resourceId: device.id,
    details: {
      pendingCount: data.patches.length,
      installedCount,
      ignoredLinuxPackageCount: submittedInstalledCount - installedCount,
    },
  });

  return c.json({
    success: true,
    pending: data.patches.length,
    installed: installedCount,
    ignored: submittedInstalledCount - installedCount
  });
});
