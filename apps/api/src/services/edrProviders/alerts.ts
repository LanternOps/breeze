/**
 * EDR provider framework — Phase 4 notifier (#8166 W02, spec §4.4, D10).
 *
 * Runs AFTER a sync's Phase 3 transaction commits, over PERSISTED rows, never
 * inside the sync transaction: `createSourcedAlert` and `publishEvent` publish
 * immediately. The sync job wraps every entry point here in its own try/catch —
 * an alert-path outage must never fail the sync or mark the connection errored.
 *
 * Detections (`evaluateEdrAlerts`): a row publishes when `notified_severity`
 * differs from `severity`. First-sync back-fill is stamped notified at PERSIST
 * time (persist.ts), so a new connection's 30-day back-fill never reaches this
 * evaluator as unnotified. As a second guard, a never-notified row first seen
 * longer ago than the notify horizon (24 h) is stamped silently — the horizon
 * applies to FIRST publication only; an escalation always publishes.
 * `notified_severity` is stamped only after the publish succeeded, row by row,
 * so a failed row retries on the next run and never blocks the others.
 *
 * Alerts require a device: an unlinked detection raises the event only. A
 * detection alert resolves once its detection is closed, tombstoned or gone.
 */
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { EdrSeverity } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { alerts, devices, edrConnections, edrDetections, edrEndpoints, edrTenants } from '../../db/schema';
import { createSourcedAlert, resolveAlert } from '../alertService';
import { EVENT_TYPES, publishEvent } from '../eventBus';
import { captureException } from '../sentry';
import { getRedis } from '../redis';
import { edrProviderLabel } from './providerKeys';
import { notInHoldingOrgCondition } from '../unassignedPool/selectorPredicate';

/** `alerts.context->>'source'` for every alert this module writes. */
export const EDR_ALERT_SOURCE = 'edr_provider';
/** `publisher` / event source. */
export const EDR_ALERT_PUBLISHER = 'edr-provider-sync';
export const EDR_ALERT_CONFIG_ITEM = 'edr_provider';
export const EDR_NOTIFY_HORIZON_MS = 24 * 60 * 60 * 1000;
export const EDR_TENANT_STALE_MS = 24 * 60 * 60 * 1000;
const ADVISORY_LOCK_NAMESPACE = 'edr-provider-alerts';
const RESOLUTION_NOTE = 'Condition cleared by EDR provider sync';

const SEVERITY_RANK: Record<EdrSeverity, number> = {
  critical: 5, high: 4, medium: 3, low: 2, info: 1, unknown: 0,
};
const REPORTABLE: ReadonlySet<EdrSeverity> = new Set(['critical', 'high', 'medium']);

function logFailure(operation: string, error: unknown, extra: Record<string, unknown>): void {
  console.error(`[EdrProviderAlerts] ${operation} failed:`, error);
  captureException(error instanceof Error ? error : new Error(String(error)), undefined, {
    service: 'edrProviders', operation, ...extra,
  });
}

// ---------------------------------------------------------------------------
// Detections
// ---------------------------------------------------------------------------

export interface DetectionCandidate {
  id: string;
  orgId: string;
  tenantId: string | null;
  endpointId: string | null;
  breezeDeviceId: string | null;
  provider: string;
  severity: EdrSeverity;
  notifiedSeverity: EdrSeverity | null;
  detectedAt: Date | null;
  createdAt: Date;
  /** Vendor text: alert rows only, never event payloads. */
  title: string | null;
  threatName: string | null;
  deviceName: string | null;
}

export type DetectionDecision = 'detected' | 'escalated' | 'suppress' | 'silent';

/** PURE: what to do with one unnotified (notified ≠ severity) live open row. */
export function decideDetection(row: DetectionCandidate, now: Date, horizonMs: number): DetectionDecision {
  const current = SEVERITY_RANK[row.severity] ?? 0;
  if (row.notifiedSeverity !== null) {
    const previous = SEVERITY_RANK[row.notifiedSeverity] ?? 0;
    return current > previous && REPORTABLE.has(row.severity) ? 'escalated' : 'silent';
  }
  if (!REPORTABLE.has(row.severity)) return 'silent';
  const firstSeen = row.detectedAt ?? row.createdAt;
  return firstSeen.getTime() < now.getTime() - horizonMs ? 'suppress' : 'detected';
}

export interface EdrAlertDeps {
  loadCandidates(connectionId: string): Promise<DetectionCandidate[]>;
  hasOpenDetectionAlert(detectionId: string, severity: EdrSeverity): Promise<boolean>;
  createAlert(params: Parameters<typeof createSourcedAlert>[0]): Promise<string | null>;
  publish(type: string, orgId: string, payload: Record<string, unknown>): Promise<void>;
  /** Compare-and-set stamp; false when the row moved on (severity changed / tombstoned). */
  stamp(detectionId: string, severity: EdrSeverity): Promise<boolean>;
  stampMany(detectionIds: string[]): Promise<number>;
  /** Resolve this connection's open detection alerts whose detection closed, was tombstoned or is gone. */
  resolveClosedDetectionAlerts(connectionId: string): Promise<number>;
}

const system = <T>(fn: () => Promise<T>, label: string): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

export const defaultEdrAlertDeps: EdrAlertDeps = {
  loadCandidates: (connectionId) => system(async () => {
    const rows = await db
      .select({
        id: edrDetections.id,
        orgId: edrDetections.orgId,
        tenantId: edrDetections.tenantId,
        endpointId: edrDetections.endpointId,
        breezeDeviceId: edrDetections.breezeDeviceId,
        provider: edrDetections.provider,
        severity: edrDetections.severity,
        notifiedSeverity: edrDetections.notifiedSeverity,
        detectedAt: edrDetections.detectedAt,
        createdAt: edrDetections.createdAt,
        title: edrDetections.title,
        threatName: edrDetections.threatName,
        deviceName: sql<string | null>`coalesce(${devices.displayName}, ${devices.hostname})`,
      })
      .from(edrDetections)
      .leftJoin(devices, eq(devices.id, edrDetections.breezeDeviceId))
      .where(and(
        eq(edrDetections.connectionId, connectionId),
        isNull(edrDetections.detachedAt),
        // No EDR alert or event is raised under the holding org (backupProviders precedent).
        notInHoldingOrgCondition(edrDetections.orgId),
        sql`${edrDetections.status} IN ('open', 'in_progress', 'unknown')`,
        sql`${edrDetections.notifiedSeverity} IS DISTINCT FROM ${edrDetections.severity}`,
      ))
      .orderBy(sql`coalesce(${edrDetections.detectedAt}, ${edrDetections.createdAt})`, edrDetections.id);
    return rows as DetectionCandidate[];
  }, 'edrProviderAlerts.loadCandidates'),

  hasOpenDetectionAlert: (detectionId, severity) => system(async () => {
    const [row] = await db
      .select({ id: alerts.id })
      .from(alerts)
      .where(and(
        inArray(alerts.status, ['active', 'acknowledged', 'suppressed']),
        sql`${alerts.context}->>'source' = ${EDR_ALERT_SOURCE}`,
        sql`${alerts.context}->>'detectionId' = ${detectionId}`,
        sql`${alerts.context}->>'severity' = ${severity}`,
      ))
      .limit(1);
    return !!row;
  }, 'edrProviderAlerts.dedupe'),

  createAlert: (params) => system(() => createSourcedAlert(params), 'edrProviderAlerts.createAlert'),

  publish: async (type, orgId, payload) => {
    await publishEvent(type as Parameters<typeof publishEvent>[0], orgId, payload, EDR_ALERT_PUBLISHER);
  },

  stamp: (detectionId, severity) => system(async () => {
    const updated = await db
      .update(edrDetections)
      .set({ notifiedSeverity: severity })
      .where(and(
        eq(edrDetections.id, detectionId),
        eq(edrDetections.severity, severity),
        isNull(edrDetections.detachedAt),
      ))
      .returning({ id: edrDetections.id });
    return updated.length > 0;
  }, 'edrProviderAlerts.stamp'),

  stampMany: (detectionIds) => system(async () => {
    if (detectionIds.length === 0) return 0;
    const updated = await db
      .update(edrDetections)
      .set({ notifiedSeverity: sql`${edrDetections.severity}` })
      .where(inArray(edrDetections.id, detectionIds))
      .returning({ id: edrDetections.id });
    return updated.length;
  }, 'edrProviderAlerts.stampMany'),

  resolveClosedDetectionAlerts: (connectionId) => system(async () => {
    const stale = await db
      .select({ id: alerts.id, status: alerts.status, suppressedUntil: alerts.suppressedUntil })
      .from(alerts)
      .where(and(
        inArray(alerts.status, ['active', 'acknowledged', 'suppressed']),
        sql`${alerts.context}->>'source' = ${EDR_ALERT_SOURCE}`,
        sql`${alerts.context}->>'kind' = 'detection'`,
        sql`${alerts.context}->>'connectionId' = ${connectionId}`,
        sql`NOT EXISTS (
          SELECT 1 FROM edr_detections d
          WHERE d.id::text = ${alerts.context}->>'detectionId'
            AND d.detached_at IS NULL
            AND d.status IN ('open', 'in_progress', 'unknown')
        )`,
      ));
    let resolved = 0;
    for (const a of stale) {
      // An indefinitely-suppressed alert keeps its mute (backupProviders precedent).
      if (a.status === 'suppressed' && a.suppressedUntil === null) continue;
      if (await resolveAlert(a.id, RESOLUTION_NOTE, undefined, false, 'condition_cleared')) resolved += 1;
    }
    return resolved;
  }, 'edrProviderAlerts.resolveClosed'),
};

function alertSeverity(severity: EdrSeverity): 'critical' | 'high' | 'medium' {
  return severity === 'critical' ? 'critical' : severity === 'high' ? 'high' : 'medium';
}

/**
 * Publish events/alerts for one connection's newly reportable detections.
 * Never throws: a loader failure returns zero counts (logged), a per-row
 * failure leaves that row unstamped for the next run.
 */
export async function evaluateEdrAlerts(
  connectionId: string,
  opts: { now: Date; notifyHorizonMs?: number },
  deps: EdrAlertDeps = defaultEdrAlertDeps,
): Promise<{ published: number; suppressed: number }> {
  const horizon = opts.notifyHorizonMs ?? EDR_NOTIFY_HORIZON_MS;
  let candidates: DetectionCandidate[];
  try {
    candidates = await deps.loadCandidates(connectionId);
  } catch (error) {
    logFailure('loadCandidates', error, { connectionId });
    return { published: 0, suppressed: 0 };
  }

  const silent: string[] = [];
  const suppressedIds: string[] = [];
  let published = 0;

  for (const row of candidates) {
    const decision = decideDetection(row, opts.now, horizon);
    if (decision === 'silent') { silent.push(row.id); continue; }
    if (decision === 'suppress') { suppressedIds.push(row.id); continue; }
    try {
      // 1. Alert (linked rows only), deduped so a retry after a failed
      //    publish/stamp does not raise a second alert.
      if (row.breezeDeviceId && !(await deps.hasOpenDetectionAlert(row.id, row.severity))) {
        const label = edrProviderLabel(row.provider);
        const what = row.title ?? row.threatName ?? 'EDR detection';
        const alertId = await deps.createAlert({
          deviceId: row.breezeDeviceId,
          // A detection's org IS its linked device's org (composite FK).
          orgId: row.orgId,
          severity: alertSeverity(row.severity),
          title: `${label}: ${row.severity} detection on ${row.deviceName ?? 'device'}`.slice(0, 500),
          message: `${label} reported a ${row.severity} detection: ${what}`.slice(0, 2000),
          context: {
            source: EDR_ALERT_SOURCE,
            kind: 'detection',
            connectionId,
            provider: row.provider,
            detectionId: row.id,
            endpointId: row.endpointId,
            severity: row.severity,
          },
          configItemName: EDR_ALERT_CONFIG_ITEM,
          publisher: EDR_ALERT_PUBLISHER,
          eventPayload: { connectionId, provider: row.provider, detectionId: row.id, severity: row.severity },
        });
        if (!alertId) {
          console.error(`[EdrProviderAlerts] alert for detection ${row.id} was not created; the next run retries`);
          continue;
        }
      }
      // 2. Event — ids, provider key and severities only.
      await deps.publish(
        decision === 'escalated' ? EVENT_TYPES.EDR_DETECTION_ESCALATED : EVENT_TYPES.EDR_DETECTION_DETECTED,
        row.orgId,
        {
          connectionId,
          tenantId: row.tenantId,
          orgId: row.orgId,
          detectionId: row.id,
          endpointId: row.endpointId,
          deviceId: row.breezeDeviceId,
          provider: row.provider,
          severity: row.severity,
          ...(decision === 'escalated' ? { previousSeverity: row.notifiedSeverity } : {}),
        },
      );
      // 3. Stamp only after the publish succeeded.
      await deps.stamp(row.id, row.severity);
      published += 1;
    } catch (error) {
      logFailure('publishDetection', error, { connectionId, detectionId: row.id });
    }
  }

  try {
    await deps.stampMany([...silent, ...suppressedIds]);
  } catch (error) {
    logFailure('stampMany', error, { connectionId });
  }
  try {
    // The vendor closed (or a remap tombstoned) a detection: its alert clears.
    await deps.resolveClosedDetectionAlerts(connectionId);
  } catch (error) {
    logFailure('resolveClosedDetectionAlerts', error, { connectionId });
  }
  if (suppressedIds.length > 0) {
    console.info(
      `[EdrProviderAlerts] connection ${connectionId}: ${suppressedIds.length} detection(s) older than the `
      + 'notify horizon stamped without publishing',
    );
  }
  return { published, suppressed: suppressedIds.length };
}

// ---------------------------------------------------------------------------
// Endpoint health (linked endpoints only)
// ---------------------------------------------------------------------------

/**
 * Raise one alert per LINKED endpoint the vendor reports `unhealthy`, and
 * resolve it once the endpoint is `healthy` again (or vanished/unlinked).
 * The open alert IS the state (no edr_* state column in W02), so unlinked
 * endpoints — which have no alert to hold state — raise nothing, and there is
 * no two-poll hysteresis: `degraded` / `unknown` neither raise nor resolve.
 */
export async function evaluateEdrEndpointHealth(connectionId: string): Promise<{ raised: number; resolved: number }> {
  return system(async () => {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ADVISORY_LOCK_NAMESPACE}), hashtext(${connectionId}))`);
    const endpoints = await db
      .select({
        id: edrEndpoints.id,
        orgId: edrEndpoints.orgId,
        provider: edrEndpoints.provider,
        health: edrEndpoints.health,
        breezeDeviceId: edrEndpoints.breezeDeviceId,
        deviceName: sql<string | null>`coalesce(${devices.displayName}, ${devices.hostname})`,
      })
      .from(edrEndpoints)
      .leftJoin(devices, eq(devices.id, edrEndpoints.breezeDeviceId))
      .where(and(
        eq(edrEndpoints.connectionId, connectionId),
        isNotNull(edrEndpoints.breezeDeviceId),
        notInHoldingOrgCondition(edrEndpoints.orgId),
      ));
    const open = await db
      .select({
        id: alerts.id,
        status: alerts.status,
        suppressedUntil: alerts.suppressedUntil,
        endpointId: sql<string | null>`${alerts.context}->>'endpointId'`,
      })
      .from(alerts)
      .where(and(
        inArray(alerts.status, ['active', 'acknowledged', 'suppressed']),
        sql`${alerts.context}->>'source' = ${EDR_ALERT_SOURCE}`,
        sql`${alerts.context}->>'kind' = 'endpoint_health'`,
        sql`${alerts.context}->>'connectionId' = ${connectionId}`,
      ));
    const openByEndpoint = new Map(open.map((a) => [a.endpointId ?? '', a]));
    const byId = new Map(endpoints.map((e) => [e.id, e]));

    let raised = 0;
    let resolved = 0;
    const events: Array<{ type: string; orgId: string; payload: Record<string, unknown> }> = [];

    for (const e of endpoints) {
      if (e.health !== 'unhealthy' || openByEndpoint.has(e.id)) continue;
      const label = edrProviderLabel(e.provider);
      const alertId = await createSourcedAlert({
        deviceId: e.breezeDeviceId!,
        orgId: e.orgId,
        severity: 'high',
        title: `${label}: protection unhealthy on ${e.deviceName ?? 'device'}`.slice(0, 500),
        message: `${label} reports the endpoint protection agent on this device as unhealthy.`,
        context: { source: EDR_ALERT_SOURCE, kind: 'endpoint_health', connectionId, provider: e.provider, endpointId: e.id },
        configItemName: EDR_ALERT_CONFIG_ITEM,
        publisher: EDR_ALERT_PUBLISHER,
        eventPayload: { connectionId, provider: e.provider, endpointId: e.id },
      });
      if (!alertId) continue;
      raised += 1;
      events.push({
        type: EVENT_TYPES.EDR_ENDPOINT_UNHEALTHY,
        orgId: e.orgId,
        payload: { connectionId, orgId: e.orgId, endpointId: e.id, deviceId: e.breezeDeviceId, provider: e.provider },
      });
    }

    for (const a of open) {
      const e = a.endpointId ? byId.get(a.endpointId) : undefined;
      const cleared = !e || e.health === 'healthy';
      if (!cleared) continue;
      // An indefinitely-suppressed alert keeps its mute (backupProviders precedent).
      if (a.status === 'suppressed' && a.suppressedUntil === null) continue;
      if (await resolveAlert(a.id, RESOLUTION_NOTE, undefined, false, 'condition_cleared')) {
        resolved += 1;
        if (e) {
          events.push({
            type: EVENT_TYPES.EDR_ENDPOINT_RECOVERED,
            orgId: e.orgId,
            payload: { connectionId, orgId: e.orgId, endpointId: e.id, deviceId: e.breezeDeviceId, provider: e.provider },
          });
        }
      }
    }

    for (const ev of events) {
      try {
        await publishEvent(ev.type as Parameters<typeof publishEvent>[0], ev.orgId, ev.payload, EDR_ALERT_PUBLISHER);
      } catch (error) {
        logFailure('publishEndpointEvent', error, { connectionId });
      }
    }
    return { raised, resolved };
  }, 'edrProviderAlerts.endpointHealth');
}

// ---------------------------------------------------------------------------
// D10 stale tenants (from the sync-all tick)
// ---------------------------------------------------------------------------

export interface StaleTenantRow {
  id: string;
  connectionId: string;
  orgId: string;
  provider: string;
  lastDetectionSyncAt: Date | null;
  lastInventorySyncAt: Date | null;
  createdAt: Date;
}

/** PURE: a mapped tenant whose detection or inventory sync is older than 24 h (or never ran 24 h after creation). */
export function isTenantStale(t: Pick<StaleTenantRow, 'lastDetectionSyncAt' | 'lastInventorySyncAt' | 'createdAt'>, now: Date): boolean {
  const cutoff = now.getTime() - EDR_TENANT_STALE_MS;
  const detection = (t.lastDetectionSyncAt ?? t.createdAt).getTime();
  const inventory = (t.lastInventorySyncAt ?? t.createdAt).getTime();
  return detection < cutoff || inventory < cutoff;
}

export interface StaleTenantDeps {
  loadMappedTenants(): Promise<StaleTenantRow[]>;
  /** Set-if-absent; true when this call created the mark (= first stale tick). */
  markStale(tenantId: string): Promise<boolean>;
  clearStale(tenantId: string): Promise<void>;
  publish(type: string, orgId: string, payload: Record<string, unknown>): Promise<void>;
}

const STALE_KEY = (tenantId: string) => `edr:tenant-stale:${tenantId}`;
const STALE_MARK_TTL_SECONDS = 30 * 24 * 60 * 60;

export const defaultStaleTenantDeps: StaleTenantDeps = {
  loadMappedTenants: () => system(async () => {
    const rows = await db
      .select({
        id: edrTenants.id,
        connectionId: edrTenants.connectionId,
        orgId: edrTenants.orgId,
        provider: edrConnections.provider,
        lastDetectionSyncAt: edrTenants.lastDetectionSyncAt,
        lastInventorySyncAt: edrTenants.lastInventorySyncAt,
        createdAt: edrTenants.createdAt,
      })
      .from(edrTenants)
      .innerJoin(edrConnections, eq(edrConnections.id, edrTenants.connectionId))
      .where(and(
        eq(edrConnections.isActive, true),
        isNotNull(edrTenants.orgId),
        isNull(edrTenants.vendorMissingSince),
      ));
    return rows as StaleTenantRow[];
  }, 'edrProviderAlerts.staleTenants'),
  markStale: async (tenantId) => {
    const redis = getRedis();
    // No Redis: fail quiet (no event) rather than publish on every tick.
    if (!redis) return false;
    return (await redis.set(STALE_KEY(tenantId), '1', 'EX', STALE_MARK_TTL_SECONDS, 'NX')) === 'OK';
  },
  clearStale: async (tenantId) => {
    const redis = getRedis();
    if (redis) await redis.del(STALE_KEY(tenantId));
  },
  publish: async (type, orgId, payload) => {
    await publishEvent(type as Parameters<typeof publishEvent>[0], orgId, payload, EDR_ALERT_PUBLISHER);
  },
};

/**
 * One `edr.tenant_stale` event per mapped tenant when it goes stale, deduped
 * until it recovers. Runs from the sync-all tick, NOT from a sync job: a
 * connection whose every sync throws before Phase 3 never reaches a post-commit
 * hook. Event only (no device ⇒ no alert row). Never throws.
 */
export async function evaluateEdrStaleTenants(
  now: Date,
  deps: StaleTenantDeps = defaultStaleTenantDeps,
): Promise<{ published: number }> {
  let tenants: StaleTenantRow[];
  try {
    tenants = await deps.loadMappedTenants();
  } catch (error) {
    logFailure('loadMappedTenants', error, {});
    return { published: 0 };
  }
  let published = 0;
  for (const t of tenants) {
    try {
      if (!isTenantStale(t, now)) {
        await deps.clearStale(t.id);
        continue;
      }
      if (!(await deps.markStale(t.id))) continue;
      try {
        await deps.publish(EVENT_TYPES.EDR_TENANT_STALE, t.orgId, {
          connectionId: t.connectionId,
          tenantId: t.id,
          orgId: t.orgId,
          provider: t.provider,
          lastDetectionSyncAt: t.lastDetectionSyncAt?.toISOString() ?? null,
          lastInventorySyncAt: t.lastInventorySyncAt?.toISOString() ?? null,
        });
        published += 1;
      } catch (error) {
        // Release the mark so the next tick retries the announcement.
        await deps.clearStale(t.id);
        throw error;
      }
    } catch (error) {
      logFailure('staleTenant', error, { tenantId: t.id });
    }
  }
  return { published };
}
