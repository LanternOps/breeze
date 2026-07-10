import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq } from 'drizzle-orm';
import { reliabilityMetricsSchema } from '@breeze/shared/validators';

import { db, withDbAccessContext, withSystemDbAccessContext, runOutsideDbContext } from '../../db';
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
  | { ok: false; reason: 'not_found' | 'insert_failed' };

reliabilityRoutes.post('/:id/reliability', zValidator('json', reliabilityMetricsSchema), async (c) => {
  const agentId = c.req.param('id');
  const metrics = c.req.valid('json');
  const agent = c.get('agent') as { orgId?: string; agentId?: string } | undefined;

  // Fail fast on a token that authenticated but carries no org. Building a vacuous
  // org-scoped RLS context (orgId '', accessibleOrgIds []) would make the device
  // lookup RLS-deny and masquerade as a 404 with no signal — surface it instead.
  if (!agent?.orgId) {
    console.error(`[agents] reliability post with no org context agent=${agentId}`);
    captureException(new Error('reliability ingest missing agent orgId'));
    return c.json({ error: 'Agent context missing organization' }, 401);
  }
  const orgId = agent.orgId;

  // #1105 — this route is in SELF_MANAGED_DB_CONTEXT_ACTIONS (agentAuth.ts), so
  // the request-long org wrap is skipped. Hold an org-scoped context ONLY across
  // the lookup + insert; the BullMQ enqueue and audit write run OUTSIDE it so no
  // pooled connection is pinned idle-in-transaction across Redis/non-DB work.
  const dbContext = {
    scope: 'organization' as const,
    orgId,
    accessibleOrgIds: [orgId],
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
      // Parity with the enqueue catch below: a persistent insert failure (e.g. an
      // RLS misconfiguration) must reach Sentry, not just stdout.
      captureException(error);
      return { ok: false, reason: 'insert_failed' };
    }

    return { ok: true, deviceId: device.id, orgId: device.orgId };
  });

  if (!lookup.ok) {
    if (lookup.reason === 'not_found') {
      return c.json({ error: 'Device not found' }, 404);
    }
    if (lookup.reason === 'insert_failed') {
      return c.json({ error: 'Failed to record reliability metrics' }, 500);
    }
    // Exhaustiveness: a new LookupResult failure reason must be handled above.
    const unhandled: never = lookup.reason;
    throw new Error(`unhandled reliability lookup reason: ${String(unhandled)}`);
  }

  // Outside the transaction: Redis enqueue (with inline compute fallback).
  try {
    await enqueueDeviceReliabilityComputation(lookup.deviceId);
  } catch (error) {
    console.error('[agents] failed to enqueue reliability computation, using inline fallback:', error);
    captureException(error);
    // Redis-outage fallback. computeAndPersistDeviceReliability relies on an ambient
    // RLS context: it reads the ml-feature-flag gate (an `organizations INNER JOIN
    // partners` — needs partner-axis visibility) AND writes deviceReliability. An
    // org context can't see the partners row, so the flag gate silently resolves
    // `org_not_found` and the whole compute no-ops. Mirror the worker exactly: run
    // OUTSIDE any context, then open a fresh SYSTEM context (system sees the partner
    // row and every org). runOutsideDbContext is required because
    // withSystemDbAccessContext short-circuits to a no-op if a context is already
    // active (db/index.ts). The metrics row is already committed and the recompute
    // is best-effort (same as the enqueue path), so a fallback failure must NOT flip
    // this request to 500 — that would trigger agent retries and duplicate inserts.
    try {
      await runOutsideDbContext(() =>
        withSystemDbAccessContext(() => computeAndPersistDeviceReliability(lookup.deviceId))
      );
    } catch (fallbackError) {
      console.error(`[agents] inline reliability fallback failed device=${lookup.deviceId}:`, fallbackError);
      captureException(fallbackError);
    }
  }

  // Outside the transaction: audit write (fire-and-forget, as before).
  writeAuditEvent(c, {
    orgId,
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
