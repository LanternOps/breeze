import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { devices, patches, devicePatches } from '../../db/schema';
import { writeAuditEvent } from '../../services/auditEvents';
import { parseDate, inferPatchOsType } from './helpers';
import type { AgentContext } from './helpers';

export const patchesRoutes = new Hono();

const submitPatchesSchema = z.object({
  patches: z.array(z.object({
    name: z.string().min(1),
    version: z.string().optional(),
    currentVersion: z.string().optional(),
    kbNumber: z.string().optional(),
    category: z.string().optional(),
    severity: z.enum(['critical', 'important', 'moderate', 'low', 'unknown']).optional(),
    size: z.number().int().optional(),
    requiresRestart: z.boolean().optional(),
    releaseDate: z.string().optional(),
    description: z.string().optional(),
    source: z.enum(['microsoft', 'apple', 'linux', 'third_party', 'custom']).default('custom')
  })),
  installed: z.array(z.object({
    name: z.string().min(1),
    version: z.string().optional(),
    category: z.string().optional(),
    source: z.enum(['microsoft', 'apple', 'linux', 'third_party', 'custom']).default('custom'),
    installedAt: z.string().optional()
  })).optional()
});

patchesRoutes.put('/:id/patches', zValidator('json', submitPatchesSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');
  const agent = c.get('agent') as AgentContext | undefined;
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
      const externalId = patchData.kbNumber ||
        `${patchData.source}:${patchData.name}:${patchData.version || 'latest'}`;
      const inferredOsType = inferPatchOsType(patchData.source, device.osType);

      const [patch] = await tx
        .insert(patches)
        .values({
          source: patchData.source,
          externalId: externalId,
          title: patchData.name,
          description: patchData.description || null,
          severity: patchData.severity || 'unknown',
          category: patchData.category || null,
          releaseDate: patchData.releaseDate || null,
          requiresReboot: patchData.requiresRestart || false,
          downloadSizeMb: patchData.size ? Math.ceil(patchData.size / (1024 * 1024)) : null,
          ...(inferredOsType ? { osTypes: [inferredOsType] } : {})
        })
        .onConflictDoUpdate({
          target: [patches.source, patches.externalId],
          set: {
            title: patchData.name,
            description: patchData.description || null,
            severity: patchData.severity || 'unknown',
            category: patchData.category || null,
            requiresReboot: patchData.requiresRestart || false,
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
        await tx
          .insert(devicePatches)
          .values({
            deviceId: device.id,
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
        const externalId = `${patchData.source}:${patchData.name}:${patchData.version || 'installed'}`;
        const inferredOsType = inferPatchOsType(patchData.source, device.osType);

        const [patch] = await tx
          .insert(patches)
          .values({
            source: patchData.source,
            externalId: externalId,
            title: patchData.name,
            severity: 'unknown',
            category: patchData.category || null,
            ...(inferredOsType ? { osTypes: [inferredOsType] } : {})
          })
          .onConflictDoUpdate({
            target: [patches.source, patches.externalId],
            set: {
              title: patchData.name,
              category: patchData.category || null,
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
