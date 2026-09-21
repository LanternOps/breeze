import { and, eq, or, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  alerts,
  backupProviderCustomers,
  backupProviderDevices,
  devices,
} from '../../db/schema';
import { createSourcedAlert, resolveAlert } from '../alertService';
import { EVENT_TYPES, publishEvent } from '../eventBus';
// Package ROOT — deriveBackupHealth is a VALUE import (see Global Constraints).
import { deriveBackupHealth, type BackupProviderAlertCondition, type ExternalBackupStatus } from '@breeze/shared';
import { getBackupProvider } from './registry';

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
  status: ExternalBackupStatus;
  lastSuccessAt: Date | null;
  errorsCount: number;
  pendingCondition: string | null;
  breezeDeviceId: string | null;
  deviceDisplayName: string | null;
  deviceHostname: string | null;
  customerName: string | null;
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
        status: backupProviderDevices.status,
        lastSuccessAt: backupProviderDevices.lastSuccessAt,
        errorsCount: backupProviderDevices.errorsCount,
        pendingCondition: backupProviderDevices.pendingCondition,
        breezeDeviceId: backupProviderDevices.breezeDeviceId,
        deviceDisplayName: devices.displayName,
        deviceHostname: devices.hostname,
        customerName: backupProviderCustomers.vendorCustomerName,
      })
      .from(backupProviderDevices)
      .leftJoin(devices, eq(devices.id, backupProviderDevices.breezeDeviceId))
      .leftJoin(backupProviderCustomers, eq(backupProviderCustomers.id, backupProviderDevices.customerId))
      .where(and(
        eq(backupProviderDevices.connectionId, connectionId),
        // M365 backup accounts are never linked to a Breeze device and raise no
        // alerts (spec, Non-goals). They are excluded here rather than filtered
        // later so they never even acquire a pending_condition.
        eq(backupProviderDevices.accountType, 'backup_manager'),
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
        sql`${alerts.context}->>'source' = ${BACKUP_PROVIDER_ALERT_SOURCE}`,
        sql`${alerts.context}->>'connectionId' = ${connectionId}`,
        or(eq(alerts.status, 'active'), eq(alerts.status, 'acknowledged'), eq(alerts.status, 'suppressed')),
      ))) as OpenProviderAlert[];

    const openByProviderDeviceId = new Map<string, OpenProviderAlert>();
    for (const alert of openAlerts) {
      if (alert.providerDeviceId) openByProviderDeviceId.set(alert.providerDeviceId, alert);
    }

    let raised = 0;
    let resolved = 0;
    const rowIds = new Set(rows.map((r) => r.id));
    const pendingUpdates: Array<{ id: string; pendingCondition: string | null }> = [];

    for (const row of rows) {
      const prev = decodeConditionState(row.pendingCondition);
      const computed = computeProviderCondition(row, now);
      const { next, raise, recoveredFrom } = nextConditionState(prev, computed);

      if (encodeConditionState(next) !== row.pendingCondition) {
        pendingUpdates.push({ id: row.id, pendingCondition: encodeConditionState(next) });
      }

      if (raise && next.phase === 'raised') {
        const meta = PROVIDER_CONDITION_META[next.condition];
        const label = deviceLabel(row);
        if (row.breezeDeviceId) {
          const alertId = await createSourcedAlert({
            deviceId: row.breezeDeviceId,
            orgId: row.orgId,
            severity: meta.severity,
            title: meta.title(label).slice(0, 500),
            message: `${providerLabel(row.provider)} backup for ${label}${row.customerName ? ` (${row.customerName})` : ''} is reporting: ${meta.title(label)}.`,
            context: {
              source: BACKUP_PROVIDER_ALERT_SOURCE,
              connectionId,
              providerDeviceId: row.id,
              condition: next.condition,
              provider: row.provider,
            },
            publisher: BACKUP_PROVIDER_ALERT_PUBLISHER,
            configItemName: PROVIDER_ALERT_CONFIG_ITEM,
          });
          if (alertId) raised += 1;
        }
        await publishEvent(
          EVENT_TYPES.BACKUP_PROVIDER_DEVICE_UNHEALTHY,
          row.orgId,
          {
            connectionId,
            providerKey: row.provider,
            providerDeviceId: row.id,
            orgId: row.orgId,
            deviceId: row.breezeDeviceId,
            vendorDeviceName: row.vendorDeviceName,
            status: row.status,
            health: 'unhealthy',
            condition: next.condition,
          },
          BACKUP_PROVIDER_ALERT_PUBLISHER,
        );
      } else if (recoveredFrom) {
        const openAlert = openByProviderDeviceId.get(row.id);
        if (openAlert && !(openAlert.status === 'suppressed' && openAlert.suppressedUntil === null)) {
          const didResolve = await resolveAlert(openAlert.id, PROVIDER_ALERT_RESOLUTION_NOTE);
          if (didResolve) resolved += 1;
        }
        await publishEvent(
          EVENT_TYPES.BACKUP_PROVIDER_DEVICE_RECOVERED,
          row.orgId,
          {
            connectionId,
            providerKey: row.provider,
            providerDeviceId: row.id,
            orgId: row.orgId,
            deviceId: row.breezeDeviceId,
            vendorDeviceName: row.vendorDeviceName,
            status: row.status,
            health: 'healthy',
            condition: recoveredFrom,
          },
          BACKUP_PROVIDER_ALERT_PUBLISHER,
        );
      }
    }

    // Resolve alerts whose provider device row no longer exists at all (deleted,
    // unlinked, or the connection was removed) — the spec's third resolve case.
    for (const alert of openAlerts) {
      if (alert.providerDeviceId && rowIds.has(alert.providerDeviceId)) continue;
      if (alert.status === 'suppressed' && alert.suppressedUntil === null) continue;
      const didResolve = await resolveAlert(alert.id, PROVIDER_ALERT_RESOLUTION_NOTE);
      if (didResolve) resolved += 1;
    }

    for (const batch of chunkUpdates(pendingUpdates, 500)) {
      const values = sql.join(
        batch.map((u) => sql`(${u.id}::uuid, ${u.pendingCondition})`),
        sql`, `,
      );
      await db.execute(sql`
        UPDATE backup_provider_devices AS p
        SET pending_condition = v.pending_condition
        FROM (VALUES ${values}) AS v(id, pending_condition)
        WHERE p.id = v.id
      `);
    }

    return { raised, resolved };
  }, `backup-provider-alerts:${connectionId}`));
}

function chunkUpdates<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
