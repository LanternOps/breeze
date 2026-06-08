import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, sql } from 'drizzle-orm';
import { db, type Database } from '../../db';
import { devices, patches, devicePatches } from '../../db/schema';
import { enqueueWingetReleaseTest } from '../../jobs/wingetReleaseTestWorker';
import { writeAuditEvent } from '../../services/auditEvents';
import { enrichFromCatalog } from '../../services/thirdPartyEnrichment';
import { submitPatchesSchema } from './schemas';
import { inferPatchOsType, parseDate, sanitizeDate } from './helpers';

// Derive vendor from package id; ignore agent-supplied vendor for winget-style ids.
function deriveVendor(packageId: string | null | undefined, fallback: string | null | undefined): string | null {
  if (packageId && /^[^.]+\.[^.]+/.test(packageId)) {
    return packageId.split('.')[0] ?? fallback ?? null;
  }
  return fallback ?? null;
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

patchesRoutes.put('/:id/patches', zValidator('json', submitPatchesSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');
  const agent = c.get('agent') as { orgId?: string; agentId?: string } | undefined;
  const installedCount = data.installed?.length || 0;
  console.log(`[PATCHES] Agent ${agentId} submitting ${data.patches.length} pending, ${installedCount} installed`);

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
      .update(devicePatches)
      .set({ status: 'missing', lastCheckedAt: new Date() })
      .where(eq(devicePatches.deviceId, device.id));

    for (const patchData of data.patches) {
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

      const [patch] = await tx
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

      if (patch) {
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

        await tx
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

    if (data.installed && data.installed.length > 0) {
      for (const patchData of data.installed) {
        const externalId = patchData.externalId ||
          patchData.kbNumber ||
          `${patchData.source}:${patchData.name}:${patchData.version || 'latest'}`;
        const inferredOsType = inferPatchOsType(patchData.source, device.osType);

        const [patch] = await tx
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

        if (patch) {
          const installedAt = parseDate(patchData.installedAt);
          await tx
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
                status: 'installed',
                installedAt: installedAt,
                installedVersion: patchData.version || null,
                lastCheckedAt: new Date(),
                updatedAt: new Date()
              }
            });
        }
      }
    }
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
    },
  });

  return c.json({ success: true, pending: data.patches.length, installed: installedCount });
});
