import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import {
  devices,
  peripheralEventTypeEnum,
  peripheralEvents,
  peripheralPolicies
} from '../../db/schema';
import { writeAuditEvent } from '../../services/auditEvents';
import { publishEvent } from '../../services/eventBus';

const submitPeripheralEventsSchema = z.object({
  events: z.array(z.object({
    eventId: z.string().min(1).max(255).optional(),
    policyId: z.string().uuid().optional(),
    eventType: z.enum(peripheralEventTypeEnum.enumValues),
    peripheralType: z.string().min(1).max(40),
    vendor: z.string().max(255).optional(),
    product: z.string().max(255).optional(),
    serialNumber: z.string().max(255).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
    occurredAt: z.string().datetime({ offset: true }),
  })).min(1).max(1000)
});

export const peripheralRoutes = new Hono();

peripheralRoutes.put('/:id/peripherals/events', zValidator('json', submitPeripheralEventsSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');
  const agent = c.get('agent') as { orgId?: string; agentId?: string } | undefined;

  const [device] = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      hostname: devices.hostname
    })
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  if (agent?.orgId && agent.orgId !== device.orgId) {
    return c.json({ error: 'Organization mismatch' }, 403);
  }

  const rows = data.events.map((event) => ({
    orgId: device.orgId,
    deviceId: device.id,
    policyId: event.policyId ?? null,
    sourceEventId: event.eventId ?? null,
    eventType: event.eventType,
    peripheralType: event.peripheralType,
    vendor: event.vendor ?? null,
    product: event.product ?? null,
    serialNumber: event.serialNumber ?? null,
    details: event.details ?? null,
    occurredAt: new Date(event.occurredAt),
  }));

  const policyIds = Array.from(new Set(
    rows
      .map((row) => row.policyId)
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
  ));

  if (policyIds.length > 0) {
    const validPolicies = await db
      .select({ id: peripheralPolicies.id })
      .from(peripheralPolicies)
      .where(
        and(
          eq(peripheralPolicies.orgId, device.orgId),
          inArray(peripheralPolicies.id, policyIds)
        )
      );

    const validIds = new Set(validPolicies.map((row) => row.id));
    const invalidPolicyIds = policyIds.filter((id) => !validIds.has(id));
    if (invalidPolicyIds.length > 0) {
      return c.json({
        error: 'One or more policy IDs do not belong to this device organization',
        invalidPolicyIds
      }, 400);
    }
  }

  let inserted = 0;
  let deduplicated = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    const insertedRows = await db
      .insert(peripheralEvents)
      .values(batch)
      .onConflictDoNothing()
      .returning({ id: peripheralEvents.id });
    inserted += insertedRows.length;
    deduplicated += batch.length - insertedRows.length;
  }

  const blockedEvents = rows.filter((row) => row.eventType === 'blocked');
  let blockedPublishFailures = 0;
  if (blockedEvents.length > 0) {
    const results = await Promise.allSettled(
      blockedEvents.map(async (event) => {
        await publishEvent(
          'peripheral.blocked',
          device.orgId,
          {
            deviceId: device.id,
            policyId: event.policyId,
            peripheralType: event.peripheralType,
            vendor: event.vendor,
            product: event.product,
            serialNumber: event.serialNumber,
            occurredAt: event.occurredAt.toISOString(),
            details: event.details
          },
          'agent-peripheral-events',
          { priority: 'high' }
        );
      })
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        blockedPublishFailures++;
        console.error(
          `[peripherals] Failed to publish peripheral.blocked event for device ${device.id}:`,
          result.reason
        );
      }
    }
  }

  try {
    writeAuditEvent(c, {
      orgId: agent?.orgId ?? device.orgId,
      actorType: 'agent',
      actorId: agent?.agentId ?? agentId,
      action: 'agent.peripheral_events.submit',
      resourceType: 'device',
      resourceId: device.id,
      resourceName: device.hostname,
      details: {
        submittedCount: data.events.length,
        insertedCount: inserted,
        deduplicatedCount: deduplicated,
        blockedCount: blockedEvents.length,
        blockedPublishFailures
      },
    });
  } catch (error) {
    console.error(`[peripherals] Failed to write audit event for device ${device.id}:`, error);
  }

  return c.json({
    success: true,
    count: inserted,
    deduplicatedCount: deduplicated,
    blockedCount: blockedEvents.length,
    ...(blockedPublishFailures > 0 ? { blockedPublishFailures } : {})
  });
});
