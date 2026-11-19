/**
 * Did the agent on a removed device confirm it came off, before the device
 * record is permanently deleted? (#11153, part of the #11123 re-scope.)
 *
 * A purge destroys `device_commands` with everything else, so it also
 * destroys the only thing that could ever clean the endpoint. Before this
 * module the purge refused only while a `device_remove` uninstall was still
 * collectable (`UNINSTALL_PENDING`); a FAILED, EXPIRED or CANCELLED uninstall,
 * or none at all ("leave the agent installed", or a body-less API Remove),
 * was purged silently, leaving an agent nobody can see or reach.
 *
 * ONE expression, `purgeUninstallStateSql()`, decides the state for every
 * purge door:
 *
 *  - `purgeRemovedDevice` reads it under the devices row lock and refuses an
 *    unconfirmed state with `UNINSTALL_NOT_CONFIRMED` unless the caller passes
 *    `force` (only the human single-device route ever does);
 *  - the unattended jobs (retention purge, parked-device purge) use the same
 *    expression in their candidate query, so an unconfirmed device is skipped
 *    and counted instead of being re-picked every run ahead of devices that
 *    could be purged (an oldest-first, capped candidate list would otherwise
 *    stall behind it forever).
 *
 * The confirmed states, and why each one means "no agent is left running as
 * this device":
 *
 *  - `completed` — the newest relevant `self_uninstall` row completed and the
 *    agent has not been seen since (beyond a short grace for a beat that was
 *    already in flight). An agent seen AFTER that is `agent_returned`: the
 *    machine was reinstalled and re-attached to this record, so the old
 *    completion says nothing about the agent running now. NOTE: today the
 *    agent reports `completed` when teardown is handed off, not when it has
 *    finished; #11154 changes the agent so `completed` means real teardown.
 *    This module already treats `completed` as that stronger claim.
 *  - `agent_reported_uninstall` — the installer's UninstallNotify stamped
 *    `uninstall_intent_at` and the agent has been silent since. The same
 *    predicate `offlineDetector.processReapUninstallIntent` decommissions on.
 *  - `reattached` — the device was the SOURCE of a confirmed reattach: its
 *    agent now runs as a different device record (`deviceReattach/confirm.ts`
 *    decommissions the source with `queueUninstall: false` for that reason).
 *    Keyed on the agent id as well: a record later brought back as a reattach
 *    TARGET gets a new agent id, and that agent is very much still running.
 *  - `ephemeral` — a Quick Support device; its agent is session-scoped.
 *
 * "Relevant row" = a `self_uninstall` row carrying the `device_remove` reason,
 * or ANY completed `self_uninstall` (an abuse or offboarding uninstall that
 * completed is still the agent saying it tore down). Pending or failed rows
 * owned only by another feature are ignored: they say nothing about this
 * removal, and `deviceUninstallDrain.ts` documents why bare presence of a
 * pending row must never be treated as this device's Remove. Restore strips
 * `device_remove` from the rows it releases, so a restore-then-remove cycle
 * does not inherit the previous cycle's state.
 *
 * `device_commands` has no RLS and `device_reattachments` is partner-scoped:
 * every caller runs in a system DB context (each purge door already does).
 */
import { sql, type SQL } from 'drizzle-orm';
import { UNINSTALL_REASON_DEVICE_REMOVE, type Tx } from './deviceUninstallDrain';

export const PURGE_UNINSTALL_CONFIRMED_STATES = [
  'completed',
  'agent_reported_uninstall',
  'reattached',
  'ephemeral',
] as const;

export const PURGE_UNINSTALL_UNCONFIRMED_STATES = [
  'failed',
  'expired',
  'cancelled',
  'agent_returned',
  'none',
] as const;

export type PurgeUninstallConfirmedState = (typeof PURGE_UNINSTALL_CONFIRMED_STATES)[number];
export type PurgeUninstallUnconfirmedState = (typeof PURGE_UNINSTALL_UNCONFIRMED_STATES)[number];
/** `pending` = a `device_remove` uninstall is still collectable (`UNINSTALL_PENDING`). */
export type PurgeUninstallState =
  | PurgeUninstallConfirmedState
  | PurgeUninstallUnconfirmedState
  | 'pending';

/**
 * How long after a `completed` uninstall a last-seen bump is still read as the
 * same agent's final beat rather than a reinstall. A beat can be in flight
 * while the result is being posted, and an offboarding or abuse uninstall runs
 * on a device that is not yet decommissioned, so the normal heartbeat path
 * still writes `last_seen_at`. Ten minutes absorbs that; a reinstall,
 * re-attach and Remove inside it is not a realistic sequence.
 */
export const UNINSTALL_COMPLETED_RETURN_GRACE = '10 minutes';

/**
 * The state of the device row in scope as `devices` (a `FROM devices` query or
 * a drizzle `.from(devices)` builder), as text. Correlated on `devices.id`.
 * Raw column names on purpose: the outer query must not alias `devices`, and
 * the fragment stays plain text a test double can inspect.
 *
 * Order matters: the carve-outs come first because they hold whatever the
 * command rows say (a reattach source has no uninstall row at all; an agent
 * that reported its own uninstall never collects the queued one, which then
 * expires). `pending` is NOT reported ahead of them here — the purge checks
 * `UNINSTALL_PENDING` separately, before reading this state.
 */
export function purgeUninstallStateSql(): SQL<string> {
  return sql<string>`(CASE
    WHEN devices.is_ephemeral THEN 'ephemeral'
    WHEN EXISTS (
      SELECT 1 FROM device_reattachments r
       WHERE r.source_device_id = devices.id
         AND r.source_agent_id = devices.agent_id
    ) THEN 'reattached'
    WHEN devices.uninstall_intent_at IS NOT NULL
      AND (devices.last_seen_at IS NULL OR devices.last_seen_at < devices.uninstall_intent_at)
      THEN 'agent_reported_uninstall'
    ELSE COALESCE((
      SELECT CASE
        WHEN c.status = 'completed' THEN
          CASE
            -- A completion with no timestamp cannot be shown to postdate the
            -- agent's last beat, so a seen agent fails closed.
            WHEN devices.last_seen_at IS NOT NULL
              AND (
                c.completed_at IS NULL
                OR devices.last_seen_at > c.completed_at + ${UNINSTALL_COMPLETED_RETURN_GRACE}::interval
              )
              THEN 'agent_returned'
            ELSE 'completed'
          END
        WHEN c.status IN ('pending', 'sent') THEN
          CASE WHEN c.device_remove_expires_at > now() THEN 'pending' ELSE 'expired' END
        -- staleCommandReaper lands a drain-window expiry as failed + timeout.
        WHEN c.status = 'failed' AND c.result->>'status' = 'timeout' THEN 'expired'
        WHEN c.status = 'cancelled' THEN 'cancelled'
        -- device_commands.status is an unconstrained varchar: anything
        -- unrecognised is the reading that does NOT claim the agent came off.
        ELSE 'failed'
      END
        FROM device_commands c
       WHERE c.device_id = devices.id
         AND c.type = 'self_uninstall'
         AND (
           c.uninstall_reasons @> ARRAY[${UNINSTALL_REASON_DEVICE_REMOVE}]::text[]
           OR c.status = 'completed'
         )
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT 1
    ), 'none')
  END)`;
}

/**
 * True when an unattended purge may attempt the device: its uninstall is
 * confirmed, or still pending (the purge then refuses with `UNINSTALL_PENDING`
 * and the device comes back on a later run once it resolves). Unconfirmed
 * devices are excluded from the candidate set and counted instead.
 */
export function purgeUninstallAttemptableSql(): SQL<boolean> {
  const attemptable = [...PURGE_UNINSTALL_CONFIRMED_STATES, 'pending'];
  return sql<boolean>`${purgeUninstallStateSql()} IN (${sql.join(
    attemptable.map((state) => sql`${state}`),
    sql`, `,
  )})`;
}

const KNOWN_STATES: ReadonlySet<string> = new Set<string>([
  ...PURGE_UNINSTALL_CONFIRMED_STATES,
  ...PURGE_UNINSTALL_UNCONFIRMED_STATES,
  'pending',
]);

export function isPurgeUninstallConfirmed(
  state: PurgeUninstallState,
): state is PurgeUninstallConfirmedState {
  return (PURGE_UNINSTALL_CONFIRMED_STATES as readonly string[]).includes(state);
}

/**
 * Read the state for one device. Call it with the devices row already locked
 * (`purgeRemovedDevice` does), so the decision and the cascade see one row.
 * A missing row or an unrecognised value reads as `none` / `failed` — never
 * as confirmed.
 */
export async function readPurgeUninstallState(tx: Tx, deviceId: string): Promise<PurgeUninstallState> {
  const rows = (await tx.execute(sql`
    SELECT ${purgeUninstallStateSql()} AS uninstall_state
      FROM devices
     WHERE devices.id = ${deviceId}
  `)) as unknown as Array<{ uninstall_state: string | null }>;
  const value = Array.isArray(rows) ? rows[0]?.uninstall_state : undefined;
  if (value == null) return 'none';
  return KNOWN_STATES.has(value) ? (value as PurgeUninstallState) : 'failed';
}
