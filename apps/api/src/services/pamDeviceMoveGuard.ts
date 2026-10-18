/**
 * PAM preconditions for an ownership change of a device (device org move) or
 * of every device of an org (org merge).
 *
 * Two modes (PAM ownership epochs, spec docs/superpowers/specs/pam/
 * 2026-10-06-pam-ownership-epoch-design.md §5, §8, §10):
 *  - transfer OFF (default): any PAM actuation in the departing org refuses
 *    the move (`PAM_DEVICE_MOVE_BLOCKED`) — the S0 Track E guard.
 *  - transfer ON: only an actuation that is not closed
 *    (`pam_actuation_is_closed`, cleaned with endpoint proof) refuses it
 *    (`PAM_DEVICE_MOVE_ACTIVE`); closed evidence stays at its epoch.
 *
 * Transfer is on only when BOTH the deployment env flag
 * `PAM_OWNERSHIP_EPOCH_TRANSFER` and the database switch
 * (`breeze_pam_epoch_transfer_enabled()`, a row breeze_app cannot write) are
 * on. The device trigger `devices_pam_history_move_guard` applies the same
 * rule from the switch plus the GUCs armed by `armOwnershipChange`, and is
 * the authority for every devices.org_id writer; these helpers only give the
 * route and the merge engine a typed refusal before it fires.
 */
import { sql } from 'drizzle-orm';
import { db } from '../db';

export type PamDeviceMoveTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Anything with drizzle's `execute` — a transaction or the ambient db. */
type SqlExecutor = Pick<PamDeviceMoveTx, 'execute'>;

/** Transfer not enabled and the device has PAM history in its departing org. */
export class PamDeviceMoveBlockedError extends Error {
  readonly code: 'PAM_DEVICE_MOVE_BLOCKED' | 'PAM_DEVICE_MOVE_ACTIVE' = 'PAM_DEVICE_MOVE_BLOCKED';

  constructor(message = 'Device organization move is blocked by durable PAM lifecycle evidence') {
    super(message);
    this.name = 'PamDeviceMoveBlockedError';
  }
}

/** Transfer enabled, but a departing-org actuation is not closed yet. */
export class PamDeviceMoveActiveError extends PamDeviceMoveBlockedError {
  override readonly code = 'PAM_DEVICE_MOVE_ACTIVE' as const;

  constructor() {
    super('Device organization move is blocked until its PAM elevation sessions finish cleanup');
    this.name = 'PamDeviceMoveActiveError';
  }
}

/** Constraint names the device trigger raises (23514) for the two refusals. */
export const PAM_MOVE_GUARD_CONSTRAINT = 'devices_pam_history_move_guard';
export const PAM_MOVE_OPEN_ACTUATION_CONSTRAINT = 'devices_pam_open_actuation_move_guard';

export type OwnershipChangeCause = 'device_move' | 'org_merge';

function rows<T>(result: unknown): T[] {
  const value = (result as { rows?: T[] }).rows ?? result;
  return Array.isArray(value) ? value : [];
}

/** `PAM_OWNERSHIP_EPOCH_TRANSFER` is on only for true/1/on (any case); default off. */
export function isPamEpochTransferEnvEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.PAM_OWNERSHIP_EPOCH_TRANSFER?.trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'on';
}

/**
 * Effective transfer mode: env flag AND the database switch. With the env flag
 * off the database is not consulted. Read inside the caller's transaction so
 * the route's precondition and the trigger see the same switch value.
 */
export async function resolvePamEpochTransfer(
  executor: SqlExecutor,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  if (!isPamEpochTransferEnvEnabled(env)) return false;
  const [row] = rows<{ enabled: boolean }>(await executor.execute(
    sql`SELECT public.breeze_pam_epoch_transfer_enabled() AS enabled`,
  ));
  return row?.enabled === true;
}

/**
 * Arms the transaction-local GUCs the devices triggers read: the epoch cause
 * (always — it labels the new ownership epoch and decides whether un-actuated
 * elevation requests follow a merge) and the transfer opt-in (only when
 * `transferEnabled`). Must run inside the caller's transaction, before the
 * `devices.org_id` write.
 */
export async function armOwnershipChange(
  executor: SqlExecutor,
  cause: OwnershipChangeCause,
  transferEnabled: boolean,
): Promise<void> {
  await executor.execute(sql`
    SELECT set_config('breeze.ownership_change_cause', ${cause}, true),
           set_config('breeze.pam_epoch_transfer', ${transferEnabled ? 'on' : 'off'}, true)
  `);
}

export async function assertPamDeviceOrgMoveAllowed(
  tx: SqlExecutor,
  input: { deviceId: string; sourceOrgId: string; transferEnabled?: boolean },
): Promise<void> {
  if (input.transferEnabled) {
    const [open] = rows<{ blocked: boolean }>(await tx.execute(sql`
      SELECT EXISTS (
        SELECT 1
        FROM pam_actuations a
        WHERE a.device_id = ${input.deviceId}::uuid
          AND a.org_id = ${input.sourceOrgId}::uuid
          AND NOT pam_actuation_is_closed(a)
      ) AS blocked
    `));
    if (!open) throw new Error('[pamDeviceMoveGuard] PAM move precondition query returned no row');
    if (open.blocked) throw new PamDeviceMoveActiveError();
    return;
  }
  const row = rows<{ blocked: boolean }>(await tx.execute(sql`
    SELECT EXISTS (
      SELECT 1
      FROM pam_actuations
      WHERE device_id = ${input.deviceId}::uuid
        AND org_id = ${input.sourceOrgId}::uuid
    ) AS blocked
  `))[0];
  if (!row) throw new Error('[pamDeviceMoveGuard] PAM move precondition query returned no row');
  if (row.blocked) throw new PamDeviceMoveBlockedError();
}

/**
 * OD4 (spec §13): an ownership change expires every still-live elevation
 * request that never reached actuation — the approval was made under the
 * departing org's policy. Status `expired`, plus an `expired` elevation_audit
 * row (actor system, details.cause `ownership_changed`) in the same statement.
 * The rows themselves stay where they are on a device move (source-org
 * history); on a merge they follow their device (devices restamp trigger).
 *
 * `deviceId` scopes to one device (device move); without it, every such
 * request of the org (merge loser). Returns the number expired.
 *
 * No post-commit event/notification is emitted: the transaction may still
 * roll back, and the ownership change itself is what callers audit.
 */
/**
 * `details.cause` of the OD4 `expired` audit row. Bound as a value, not a SQL
 * literal: the elevation_audit writer inventory reads quoted names inside a
 * jsonb_build_object as details keys.
 */
export const OWNERSHIP_CHANGED_CAUSE = 'ownership_changed';

export async function expireUnactuatedElevationRequests(
  executor: SqlExecutor,
  input: { orgId: string; deviceId?: string },
): Promise<number> {
  const deviceFilter = input.deviceId ? sql`AND r.device_id = ${input.deviceId}::uuid` : sql``;
  const expired = rows<{ id: string }>(await executor.execute(sql`
    WITH due AS (
      SELECT r.id, r.status::text AS prior_status
        FROM elevation_requests r
       WHERE r.org_id = ${input.orgId}::uuid
         ${deviceFilter}
         AND r.status IN ('pending', 'approved', 'auto_approved', 'actuating')
         AND NOT EXISTS (SELECT 1 FROM pam_actuations a WHERE a.elevation_request_id = r.id)
       FOR NO KEY UPDATE OF r
    ), flipped AS (
      UPDATE elevation_requests e
         SET status = 'expired', expired_at = now(), updated_at = now()
        FROM due
       WHERE e.id = due.id
      RETURNING e.id, e.org_id, due.prior_status
    ), audited AS (
      INSERT INTO elevation_audit (org_id, elevation_request_id, event_type, actor, details, occurred_at)
      SELECT f.org_id, f.id, 'expired', 'system',
             jsonb_build_object('cause', ${OWNERSHIP_CHANGED_CAUSE}::text, 'prior_status', f.prior_status),
             now()
        FROM flipped f
      RETURNING elevation_request_id
    )
    SELECT elevation_request_id AS id FROM audited
  `));
  return expired.length;
}
