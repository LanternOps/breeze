import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  alerts,
  backupProviderCustomers,
  backupProviderDevices,
  devices,
  organizations,
} from '../../db/schema';
import { createSourcedAlert, resolveAlert } from '../alertService';
import { EVENT_TYPES, publishEvent } from '../eventBus';
import { captureException } from '../sentry';
// Package ROOT — deriveBackupHealth is a VALUE import (see Global Constraints).
import { deriveBackupHealth, saasWorkloadLabel, type BackupProviderAlertCondition, type ExternalBackupStatus } from '@breeze/shared';
import { getBackupProvider } from './registry';
import { notInHoldingOrgCondition } from '../unassignedPool/selectorPredicate';

/** `alerts.context->>'source'` for every row this module writes. */
export const BACKUP_PROVIDER_ALERT_SOURCE = 'backup_provider';
/** `publisher` passed to createSourcedAlert (the `alert.triggered` event source). */
export const BACKUP_PROVIDER_ALERT_PUBLISHER = 'backup-provider-sync';
export const PROVIDER_ALERT_RESOLUTION_NOTE = 'Condition cleared by provider sync';
export const PROVIDER_ALERT_CONFIG_ITEM = 'backup_provider';

const ADVISORY_LOCK_NAMESPACE = 'backup-provider-sync';
const RAISED_PREFIX = 'raised:';

export const PROVIDER_CONDITION_META: Record<
  BackupProviderAlertCondition,
  { severity: 'high' | 'medium'; title: (deviceName: string) => string }
> = {
  failed: { severity: 'high', title: (n) => `Backup failed on ${n}` },
  over_quota: { severity: 'high', title: (n) => `Backup over quota on ${n}` },
  no_selection: { severity: 'medium', title: (n) => `Backup has nothing selected on ${n}` },
  no_backups: { severity: 'high', title: (n) => `No backups recorded for ${n}` },
  completed_with_errors: { severity: 'medium', title: (n) => `Backup completed with errors on ${n}` },
  stale: { severity: 'high', title: (n) => `No successful backup in 48 hours on ${n}` },
};

const SAAS_CONDITION_PHRASES: Record<BackupProviderAlertCondition, string> = {
  failed: 'failed',
  over_quota: 'over quota',
  no_selection: 'has nothing selected',
  no_backups: 'has no backups recorded',
  completed_with_errors: 'completed with errors',
  stale: 'has no successful run in 48 hours',
};

const CONDITIONS = Object.keys(PROVIDER_CONDITION_META) as BackupProviderAlertCondition[];

export type ProviderConditionState =
  | { phase: 'clear' }
  | { phase: 'pending'; condition: BackupProviderAlertCondition }
  | { phase: 'raised'; condition: BackupProviderAlertCondition };

/**
 * `pending_condition` encodes THREE states, not two (see the plan's DECISION):
 * NULL = clear, '<condition>' = seen once, 'raised:<condition>' = announced.
 * The third state is what makes `backup.provider_device_*` transition-only for
 * UNLINKED rows, which have no alert to read that state from.
 *
 * Longest encoding: 'raised:completed_with_errors' = 28 chars, inside the
 * column's varchar(30). alerts.test.ts pins that bound.
 */
export function encodeConditionState(state: ProviderConditionState): string | null {
  if (state.phase === 'clear') return null;
  return state.phase === 'raised' ? `${RAISED_PREFIX}${state.condition}` : state.condition;
}

export function decodeConditionState(value: string | null): ProviderConditionState {
  if (!value) return { phase: 'clear' };
  if (value.startsWith(RAISED_PREFIX)) {
    const condition = value.slice(RAISED_PREFIX.length) as BackupProviderAlertCondition;
    return CONDITIONS.includes(condition) ? { phase: 'raised', condition } : { phase: 'clear' };
  }
  const condition = value as BackupProviderAlertCondition;
  return CONDITIONS.includes(condition) ? { phase: 'pending', condition } : { phase: 'clear' };
}

/**
 * The spec's condition table, in its stated precedence.
 *
 * A session-status condition always beats `stale`: "No successful backup in 48
 * hours" is true of a failing device too, but "Backup failed" is the actionable
 * claim. `stale` is the catch-all for the statuses that carry no complaint of
 * their own (`completed`, `in_progress`, `not_started`, `unknown`) but whose
 * last SUCCESS is older than 48 h or absent — independent evidence that does
 * not depend on parsing this session's outcome.
 */
export function computeProviderCondition(
  input: { status: ExternalBackupStatus; lastSuccessAt: Date | null; errorsCount: number },
  now: Date,
): BackupProviderAlertCondition | null {
  switch (input.status) {
    case 'failed': return 'failed';
    case 'over_quota': return 'over_quota';
    case 'no_selection': return 'no_selection';
    case 'no_backups': return 'no_backups';
    case 'completed_with_errors':
    case 'interrupted': return 'completed_with_errors';
    default: break;
  }
  const { recency } = deriveBackupHealth({
    status: input.status,
    lastSuccessAt: input.lastSuccessAt,
    errorsCount: input.errorsCount,
    now,
  });
  return recency === 'over_48h' || recency === 'never' ? 'stale' : null;
}

/**
 * Two-poll hysteresis (spec, Alerts and events).
 *
 * Raise only when the computed condition equals the one stored last poll;
 * clear on the FIRST poll where it no longer holds. 30-minute polling makes
 * the Redis flap window useless here (see the plan's alertCooldown DECISION),
 * so consecutive-poll agreement is the durable replacement.
 */
export function nextConditionState(
  prev: ProviderConditionState,
  computed: BackupProviderAlertCondition | null,
): { next: ProviderConditionState; raise: boolean; recoveredFrom: BackupProviderAlertCondition | null } {
  const wasRaised = prev.phase === 'raised' ? prev.condition : null;

  if (computed === null) {
    return { next: { phase: 'clear' }, raise: false, recoveredFrom: wasRaised };
  }
  if (prev.phase === 'raised' && prev.condition === computed) {
    return { next: prev, raise: false, recoveredFrom: null };
  }
  if (prev.phase === 'pending' && prev.condition === computed) {
    return { next: { phase: 'raised', condition: computed }, raise: true, recoveredFrom: null };
  }
  // First observation, or the condition changed: the old one (if announced) has
  // genuinely cleared, and the new one starts its own two-poll count.
  return { next: { phase: 'pending', condition: computed }, raise: false, recoveredFrom: wasRaised };
}

interface ProviderAlertRow {
  id: string;
  orgId: string;
  provider: string;
  vendorDeviceId: string;
  vendorDeviceName: string;
  accountType: string;
  dataSources: string[];
  status: ExternalBackupStatus;
  lastSuccessAt: Date | null;
  errorsCount: number;
  pendingCondition: string | null;
  breezeDeviceId: string | null;
  deviceDisplayName: string | null;
  deviceHostname: string | null;
  customerName: string | null;
  orgName: string | null;
}

interface OpenProviderAlert {
  id: string;
  status: string;
  suppressedUntil: Date | null;
  providerDeviceId: string | null;
  condition: string | null;
}

function deviceLabel(row: ProviderAlertRow): string {
  return row.deviceDisplayName || row.deviceHostname || row.vendorDeviceName;
}

function providerLabel(providerKey: string): string {
  try {
    return getBackupProvider(providerKey).label;
  } catch {
    // An unknown provider key means the adapter was removed from the registry
    // while rows survive. The alert must still be readable, so fall back to the
    // raw key instead of failing the whole evaluation.
    return providerKey;
  }
}

/**
 * Post-commit alert and event evaluation for ONE connection.
 *
 * Runs in its OWN system transaction, after the inventory commit, under the
 * same per-connection advisory lock — `createSourcedAlert` and `resolveAlert`
 * publish immediately, and neither may run inside the inventory transaction
 * (spec, Sync job step 4). Idempotent by construction: the state machine's
 * `raise` is a transition, and the dedupe query blocks a second alert for a
 * condition already open, so re-running after a partial failure re-does no
 * work.
 */
export async function evaluateProviderAlerts(
  connectionId: string,
  options: { now?: Date } = {},
): Promise<{ raised: number; resolved: number }> {
  const now = options.now ?? new Date();

  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    await db.execute(sql`
      SELECT pg_advisory_xact_lock(hashtext(${ADVISORY_LOCK_NAMESPACE}), hashtext(${connectionId}))
    `);

    const rows = (await db
      .select({
        id: backupProviderDevices.id,
        orgId: backupProviderDevices.orgId,
        provider: backupProviderDevices.provider,
        vendorDeviceId: backupProviderDevices.vendorDeviceId,
        vendorDeviceName: backupProviderDevices.vendorDeviceName,
        accountType: backupProviderDevices.accountType,
        dataSources: backupProviderDevices.dataSources,
        status: backupProviderDevices.status,
        lastSuccessAt: backupProviderDevices.lastSuccessAt,
        errorsCount: backupProviderDevices.errorsCount,
        pendingCondition: backupProviderDevices.pendingCondition,
        breezeDeviceId: backupProviderDevices.breezeDeviceId,
        deviceDisplayName: devices.displayName,
        deviceHostname: devices.hostname,
        customerName: backupProviderCustomers.vendorCustomerName,
        orgName: organizations.name,
      })
      .from(backupProviderDevices)
      .leftJoin(devices, eq(devices.id, backupProviderDevices.breezeDeviceId))
      .leftJoin(backupProviderCustomers, eq(backupProviderCustomers.id, backupProviderDevices.customerId))
      .leftJoin(organizations, eq(organizations.id, backupProviderDevices.orgId))
      .where(and(
        eq(backupProviderDevices.connectionId, connectionId),
        // SaaS workloads share endpoint condition evaluation and hysteresis.
        // Their alerts belong to the workload rather than a linked device.
        inArray(backupProviderDevices.accountType, ['backup_manager', 'm365', 'gws']),
        // No provider alert is raised under the holding org.
        notInHoldingOrgCondition(backupProviderDevices.orgId),
      ))) as ProviderAlertRow[];

    // Every open provider alert of THIS connection, including ones whose row has
    // since vanished — those must resolve too (spec: a device that vanishes, is
    // unlinked, or whose connection is deleted/deactivated resolves its alerts).
    const openAlerts = (await db
      .select({
        id: alerts.id,
        status: alerts.status,
        suppressedUntil: alerts.suppressedUntil,
        providerDeviceId: sql<string | null>`${alerts.context}->>'providerDeviceId'`,
        condition: sql<string | null>`${alerts.context}->>'condition'`,
      })
      .from(alerts)
      .where(and(
        inArray(alerts.status, ['active', 'acknowledged', 'suppressed']),
        sql`${alerts.context}->>'source' = ${BACKUP_PROVIDER_ALERT_SOURCE}`,
        sql`${alerts.context}->>'connectionId' = ${connectionId}`,
      ))) as OpenProviderAlert[];

    const openByKey = new Set(
      openAlerts.map((a) => `${a.providerDeviceId ?? ''}|${a.condition ?? ''}`),
    );

    const pendingWrites: Array<{ id: string; value: string | null }> = [];
    const toRaise: Array<{ row: ProviderAlertRow; condition: BackupProviderAlertCondition }> = [];
    const pendingEvents: Array<{ type: typeof EVENT_TYPES.BACKUP_PROVIDER_DEVICE_UNHEALTHY | typeof EVENT_TYPES.BACKUP_PROVIDER_DEVICE_RECOVERED; orgId: string; payload: Record<string, unknown> }> = [];
    /** "<providerDeviceId>|<condition>" pairs that must SURVIVE this pass. */
    const keep = new Set<string>();

    for (const row of rows) {
      // Even a legacy link cannot turn a SaaS workload into a device subject.
      const isSaas = row.accountType === 'm365' || row.accountType === 'gws';
      const deviceId = isSaas ? null : row.breezeDeviceId;
      const computed = computeProviderCondition(row, now);
      const prev = decodeConditionState(row.pendingCondition);
      const { next, raise, recoveredFrom } = nextConditionState(prev, computed);

      const encoded = encodeConditionState(next);
      if (encoded !== row.pendingCondition) pendingWrites.push({ id: row.id, value: encoded });

      const { health } = deriveBackupHealth({
        status: row.status,
        lastSuccessAt: row.lastSuccessAt,
        errorsCount: row.errorsCount,
        now,
      });

      if (recoveredFrom) {
        pendingEvents.push({
          type: EVENT_TYPES.BACKUP_PROVIDER_DEVICE_RECOVERED,
          orgId: row.orgId,
          payload: {
            connectionId,
            providerKey: row.provider,
            providerDeviceId: row.id,
            orgId: row.orgId,
            deviceId,
            vendorDeviceName: row.vendorDeviceName,
            status: row.status,
            health,
            condition: recoveredFrom,
          },
        });
      }

      if (raise) {
        pendingEvents.push({
          type: EVENT_TYPES.BACKUP_PROVIDER_DEVICE_UNHEALTHY,
          orgId: row.orgId,
          payload: {
            connectionId,
            providerKey: row.provider,
            providerDeviceId: row.id,
            orgId: row.orgId,
            deviceId,
            vendorDeviceName: row.vendorDeviceName,
            status: row.status,
            health,
            condition: next.phase === 'raised' ? next.condition : null,
          },
        });
      }

      // Raised SaaS workloads and linked endpoints keep (or get) an alert.
      // Unlinked endpoints still get events only.
      if (next.phase !== 'raised' || (!isSaas && !deviceId)) continue;
      keep.add(`${row.id}|${next.condition}`);
      if (!openByKey.has(`${row.id}|${next.condition}`)) {
        toRaise.push({ row, condition: next.condition });
      }
    }

    // ---- persist the hysteresis state -----------------------------------
    if (pendingWrites.length > 0) {
      const values = sql.join(
        pendingWrites.map((w) => sql`(${w.id}::uuid, ${w.value}::varchar)`),
        sql`, `,
      );
      await db.execute(sql`
        UPDATE backup_provider_devices AS p
        SET pending_condition = v.pending_condition, updated_at = now()
        FROM (VALUES ${values}) AS v(id, pending_condition)
        WHERE p.id = v.id AND p.connection_id = ${connectionId}::uuid
      `);
    }

    // ---- resolve what no longer holds -----------------------------------
    // An indefinitely-suppressed alert ("Forever") is left alone: auto-resolving
    // it destroys the mute, because the next recurrence then creates a brand-new
    // ACTIVE alert (warrantyAlertEvaluator.ts:227-252, #2110). Timed
    // suppressions still resolve.
    const resolvable = openAlerts.filter((alert) => {
      if (keep.has(`${alert.providerDeviceId ?? ''}|${alert.condition ?? ''}`)) return false;
      if (alert.status === 'suppressed' && alert.suppressedUntil === null) return false;
      return true;
    });

    let resolved = 0;
    const resolvedIds = new Set<string>();
    for (const alert of resolvable) {
      if (await resolveAlert(alert.id, PROVIDER_ALERT_RESOLUTION_NOTE, undefined, false, 'condition_cleared')) {
        resolved += 1;
        resolvedIds.add(alert.id);
      }
    }
    // Losing an individual compare-and-swap is normal (a technician got there
    // first). Losing EVERY candidate is the shape an RLS write-policy divergence
    // takes, and under `breeze_app` such a write raises no error at all — so one
    // aggregate line per invocation gives that failure somewhere to show up.
    if (resolvable.length > 0 && resolved === 0) {
      console.warn(
        `[BackupProviderSync] alert resolve transitioned 0 of ${resolvable.length} open provider `
        + `alert(s) for connection ${connectionId}; every compare-and-swap matched no rows.`,
      );
    }

    // ---- raise ------------------------------------------------------------
    let raised = 0;
    for (const { row, condition } of toRaise) {
      const meta = PROVIDER_CONDITION_META[condition];
      const name = deviceLabel(row);
      const label = providerLabel(row.provider);
      const lastSuccess = row.lastSuccessAt ? row.lastSuccessAt.toISOString() : 'never';
      const isSaas = row.accountType === 'm365' || row.accountType === 'gws';
      const title = (isSaas
        ? `${saasWorkloadLabel(row.dataSources[0] ?? null)} backup ${SAAS_CONDITION_PHRASES[condition]} — ${row.customerName || row.orgName || row.vendorDeviceName}`
        : meta.title(name)).slice(0, 500);
      const message = `${label} reports status "${row.status}" for ${row.vendorDeviceName}`
        + `${row.customerName ? ` (customer ${row.customerName})` : ''}. `
        + `Last successful backup: ${lastSuccess}. Errors in the last session: ${row.errorsCount}.`;
      // A Forever suppression survives condition changes. Preserve its mute and
      // owner identity instead of colliding with the one-open-alert owner index.
      const survivingAlert = isSaas ? openAlerts.find((alert) =>
        alert.providerDeviceId === row.id && alert.condition !== condition && !resolvedIds.has(alert.id),
      ) : undefined;
      if (survivingAlert) {
        await db.update(alerts).set({
          context: sql`jsonb_set(${alerts.context}, '{condition}', to_jsonb(${condition}::text))`,
          title,
          severity: meta.severity,
          message,
        }).where(and(
          eq(alerts.id, survivingAlert.id),
          inArray(alerts.status, ['active', 'acknowledged', 'suppressed']),
        ));
        continue;
      }
      const alertId = await createSourcedAlert({
        ...(isSaas
          ? { deviceId: null, owner: { kind: 'backup_workload' as const, ref: row.id } }
          : { deviceId: row.breezeDeviceId! }),
        // For endpoints the composite device/org FK enforces the same org.
        orgId: row.orgId,
        severity: meta.severity,
        title,
        message,
        context: {
          source: BACKUP_PROVIDER_ALERT_SOURCE,
          connectionId,
          providerKey: row.provider,
          providerDeviceId: row.id,
          vendorDeviceId: row.vendorDeviceId,
          condition,
        },
        configItemName: PROVIDER_ALERT_CONFIG_ITEM,
        publisher: BACKUP_PROVIDER_ALERT_PUBLISHER,
        eventPayload: {
          connectionId,
          providerKey: row.provider,
          providerDeviceId: row.id,
          condition,
        },
      });
      if (alertId) {
        raised += 1;
      } else if (isSaas) {
        // Owner-backed inserts can return null on dedupe as well as publish
        // failure. The next sync checks for an open alert before retrying.
        console.warn(
          `[BackupProviderSync] no new ${condition} alert for backup workload ${row.id}; `
          + 'deduplicated or not published, the next sync checks again',
        );
      } else {
        // The insert produced no row or the publish rolled it back, so nothing
        // was announced. The row still sits in the `raised` phase, and the next
        // sync's dedupe finds no open alert and retries — which is why the
        // hysteresis state is NOT rolled back here.
        console.error(
          `[BackupProviderSync] failed to create the ${condition} alert for provider device `
          + `${row.id}; the next sync retries`,
        );
        captureException(new Error(`failed to create the ${condition} backup provider alert`), undefined, {
          service: 'backupProviders',
          operation: 'createSourcedAlert',
          connectionId,
          providerDeviceId: row.id,
          condition,
        });
      }
    }

    // ---- publish the transition events ------------------------------------
    // Last, so a publish failure cannot leave an alert unraised. Each publish is
    // individually guarded: the event stream is best-effort, the alert is not.
    for (const event of pendingEvents) {
      try {
        await publishEvent(event.type, event.orgId, event.payload, BACKUP_PROVIDER_ALERT_PUBLISHER);
      } catch (error) {
        console.error(`[BackupProviderSync] failed to publish ${event.type}:`, error);
        captureException(error instanceof Error ? error : new Error(String(error)), undefined, {
          service: 'backupProviders',
          operation: 'evaluateProviderAlerts',
          connectionId,
        });
      }
    }

    return { raised, resolved };
  }, 'backupProviderSync.alerts'));
}
