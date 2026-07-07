import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { reliabilityMetricsSchema } from '@breeze/shared/validators';

import { db, withDbAccessContext } from '../../db';
import { deviceReliabilityHistory, devices } from '../../db/schema';
import { enqueueDeviceReliabilityComputation } from '../../jobs/reliabilityWorker';
import { writeAuditEvent } from '../../services/auditEvents';
import { computeAndPersistDeviceReliability } from '../../services/reliabilityScoring';
import { captureException } from '../../services/sentry';
import { sanitizeTimestamp } from './helpers';
import { requireAgentRole } from '../../middleware/requireAgentRole';

export const reliabilityRoutes = new Hono();
// Reliability-metric ingest is the main agent's job; reject watchdog-role
// tokens so a weaker credential can't falsify operator-facing device posture (F8).
reliabilityRoutes.use('*', requireAgentRole);

type LookupResult =
  | { ok: true; deviceId: string; orgId: string }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'insert_failed' };

reliabilityRoutes.post('/:id/reliability', zValidator('json', reliabilityMetricsSchema), async (c) => {
  const agentId = c.req.param('id');
  const metrics = c.req.valid('json');
  const agent = c.get('agent') as { orgId?: string; agentId?: string } | undefined;

  // #1105 — this route is in SELF_MANAGED_DB_CONTEXT_ACTIONS (agentAuth.ts), so
  // the request-long org wrap is skipped. Hold an org-scoped context ONLY across
  // the lookup + insert; the BullMQ enqueue and audit write run OUTSIDE it so no
  // pooled connection is pinned idle-in-transaction across Redis/non-DB work.
  const dbContext = {
    scope: 'organization' as const,
    orgId: agent?.orgId ?? '',
    accessibleOrgIds: agent?.orgId ? [agent.orgId] : [],
    accessiblePartnerIds: [],
    currentPartnerId: null,
  };

  const lookup = await withDbAccessContext(dbContext, async (): Promise<LookupResult> => {
    const [device] = await db
      .select({ id: devices.id, orgId: devices.orgId })
      .from(devices)
      .where(eq(devices.agentId, agentId))
      .limit(1);

    if (!device) {
      return { ok: false, reason: 'not_found' };
    }

    try {
      await db.insert(deviceReliabilityHistory).values({
        deviceId: device.id,
        orgId: device.orgId,
        collectedAt: new Date(),
        uptimeSeconds: metrics.uptimeSeconds,
        bootTime: sanitizeTimestamp(metrics.bootTime) ?? new Date(),
        crashEvents: metrics.crashEvents,
        appHangs: metrics.appHangs,
        serviceFailures: metrics.serviceFailures,
        hardwareErrors: metrics.hardwareErrors,
        rawMetrics: metrics,
      });
    } catch (error) {
      console.error(`[agents] failed to insert reliability history device=${device.id} org=${device.orgId}:`, error);
      return { ok: false, reason: 'insert_failed' };
    }

    return { ok: true, deviceId: device.id, orgId: device.orgId };
  });

  if (!lookup.ok) {
    if (lookup.reason === 'not_found') {
      return c.json({ error: 'Device not found' }, 404);
    }
    return c.json({ error: 'Failed to record reliability metrics' }, 500);
  }

  // Outside the transaction: Redis enqueue (with inline compute fallback).
  try {
    await enqueueDeviceReliabilityComputation(lookup.deviceId);
  } catch (error) {
    console.error('[agents] failed to enqueue reliability computation, using inline fallback:', error);
    captureException(error);
    // Redis-outage fallback: computeAndPersistDeviceReliability does bare org-scoped
    // db reads/writes and relies on an ambient RLS context (the worker supplies a
    // system context). This route no longer has the request-long wrap (#1105), so we
    // must give the fallback its own short org-scoped context or the deviceReliability
    // write hits RLS deny. Still outside the lookup/insert transaction — opened fresh here.
    await withDbAccessContext(dbContext, () => computeAndPersistDeviceReliability(lookup.deviceId));
  }

  // Outside the transaction: audit write (fire-and-forget, as before).
  writeAuditEvent(c, {
    orgId: agent?.orgId ?? lookup.orgId,
    actorType: 'agent',
    actorId: agent?.agentId ?? agentId,
    action: 'agent.reliability.submit',
    resourceType: 'device',
    resourceId: lookup.deviceId,
    details: {
      crashes: metrics.crashEvents.length,
      hangs: metrics.appHangs.length,
      serviceFailures: metrics.serviceFailures.length,
      hardwareErrors: metrics.hardwareErrors.length,
    },
  });

  return c.json({ success: true, status: 'received' });
});
