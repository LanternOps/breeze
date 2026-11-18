/**
 * The one chokepoint for an agent's updates to ITS OWN `devices` row
 * (#8318 wave 1b, spec
 * docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md
 * §6.4 "Stale callers", item 1).
 *
 * WHY. Agent auth reads the device row by `agent_id` once, with no lock,
 * before the request's DB work begins (F21). A reattach confirm then changes
 * the target row's `agent_id` (the new install's identity) in one transaction.
 * A request the OLD install authenticated a moment before that commit still
 * runs after it, and until now its `devices` updates filtered on `devices.id`
 * alone — so the old install kept writing liveness, inventory and credential
 * columns onto a row that now belongs to a different install.
 *
 * Every update here applies `devices.id = agent.deviceId AND devices.agent_id
 * = agent.agentId`, so a stale caller's write matches 0 rows: the predicate
 * is the identity the caller authenticated with, and the row no longer
 * carries it. The source of a reattach keeps its `agent_id` but is retired at
 * confirm; a late write there touches only the retired row, and the beat's
 * terminal-status guard skips even that.
 *
 * The identity can be the REST `AgentAuthContext` (`c.get('agent')`), the WS
 * socket's cached `AgentDbContext`, the `/renew-cert` bearer context, or — for
 * server-side certificate issuance from enroll and provisioning — the row the
 * caller just created or locked `FOR UPDATE`. Callers keep their own extra
 * predicates (a terminal-status guard, a throttle, a hash compare-and-swap)
 * through `opts.where`, and get the updated rows back so every site keeps its
 * 0-row handling.
 *
 * Enforced by src/__tests__/agentOwnDeviceRowUpdates.contract.test.ts: a
 * `update(devices)` in a file reachable from an agent entry point must be this
 * statement or be allow-listed in ./agentOwnDeviceRowAllowlist.ts.
 */
import { and, eq, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource, SelectedFields } from 'drizzle-orm/pg-core';
import type { SelectResultFields } from 'drizzle-orm/query-builders/select.types';
import type { db } from '../db';
import { devices } from '../db/schema';

/** The identity an agent-authenticated caller proved: its row and the `agent_id` on it. */
export interface OwnDeviceRowIdentity {
  deviceId: string;
  agentId: string;
}

/** `db` or a transaction handle: anything that can start a `devices` update. */
export type OwnDeviceRowExecutor = Pick<typeof db, 'update'>;

/** `db` or a transaction handle: anything that can read `devices`. */
export type OwnDeviceRowReader = Pick<typeof db, 'select'>;

export type OwnDeviceRowUpdateSet = PgUpdateSetSource<typeof devices>;

export interface UpdateOwnDeviceRowOptions {
  /** Extra predicate the site keeps (status guard, throttle, hash CAS). ANDed with the identity. */
  where?: SQL | undefined;
}

export interface UpdateOwnDeviceRowOptionsReturning<TReturning extends SelectedFields> extends UpdateOwnDeviceRowOptions {
  /** Columns to return instead of the default `{ id }`. */
  returning: TReturning;
}

// Built lazily: some unit suites mock '../db/schema' with a partial table set,
// and this module sits on every agent route's import path.
const defaultReturning = () => ({ id: devices.id });

/** `devices.id = deviceId AND devices.agent_id = agentId` — the identity half of every own-row update. */
export function ownDeviceRowCondition(agent: OwnDeviceRowIdentity): SQL {
  return and(eq(devices.id, agent.deviceId), eq(devices.agentId, agent.agentId))!;
}

/**
 * Update the caller's own `devices` row. Always filters on the authenticated
 * identity (see the module doc); returns the rows the UPDATE matched so the
 * caller can tell a stale (0-row) write from a successful one.
 */
export function updateOwnDeviceRow(
  exec: OwnDeviceRowExecutor,
  agent: OwnDeviceRowIdentity,
  set: OwnDeviceRowUpdateSet,
  opts?: UpdateOwnDeviceRowOptions,
): Promise<{ id: string }[]>;
export function updateOwnDeviceRow<TReturning extends SelectedFields>(
  exec: OwnDeviceRowExecutor,
  agent: OwnDeviceRowIdentity,
  set: OwnDeviceRowUpdateSet,
  opts: UpdateOwnDeviceRowOptionsReturning<TReturning>,
): Promise<SelectResultFields<TReturning>[]>;
export async function updateOwnDeviceRow(
  exec: OwnDeviceRowExecutor,
  agent: OwnDeviceRowIdentity,
  set: OwnDeviceRowUpdateSet,
  opts: UpdateOwnDeviceRowOptions & { returning?: SelectedFields } = {},
): Promise<unknown[]> {
  const returning = opts.returning ?? defaultReturning();
  return exec
    .update(devices)
    .set(set)
    .where(and(ownDeviceRowCondition(agent), opts.where))
    .returning(returning);
}

/**
 * Read the caller's own `devices` row, bound to the authenticated identity
 * (`id = agent.deviceId AND agent_id = agent.agentId`) and locked
 * `FOR NO KEY UPDATE` until the caller's transaction ends (#8318 §6.4, the
 * review of wave 1b-1).
 *
 * WHY. A request that works FROM its own row before it writes it (the main
 * heartbeat: bare-metal check-in, role-flip audit, readiness refresh) must
 * know it is still that row's install before its first side effect, not at
 * the write that comes last. A bound read that finds nothing is the stale
 * caller (or a vanished row; tell them apart with `ownDeviceRowChangedHands`).
 *
 * WHY THE LOCK. A reattach confirm locks the device row `FOR UPDATE` before
 * it changes `agent_id`, and the F3 re-enroll's UPDATE changes the unique
 * `agent_id`, which takes the same mode. Either this read holds the lock
 * first (everything the caller does until commit belongs to the old install
 * and happens before the identity change) or it reads after the change
 * committed and matches 0 rows. Without the lock the identity could change
 * between this read and the bound write.
 *
 * `FOR NO KEY UPDATE`, not `FOR UPDATE`: it is the weakest mode that still
 * conflicts with both identity changes (and with any other UPDATE of the row,
 * which the caller is about to make anyway), and it stays compatible with the
 * `KEY SHARE` lock a foreign key takes, so other connections inserting rows
 * that merely REFERENCE this device (metrics, logs, command results) are not
 * blocked for the length of the caller's transaction (same reasoning as
 * catalogService and automationRuntime).
 *
 * LOCK ORDER. Take it before any other row lock in the transaction: confirm
 * and the install boundary go devices → other tables, so a caller that
 * locked another table's row first could invert against them.
 */
export function selectOwnDeviceRowForUpdate(
  exec: OwnDeviceRowReader,
  agent: OwnDeviceRowIdentity,
): Promise<typeof devices.$inferSelect | undefined>;
export function selectOwnDeviceRowForUpdate<TColumns extends SelectedFields>(
  exec: OwnDeviceRowReader,
  agent: OwnDeviceRowIdentity,
  columns: TColumns,
  /** Extra predicate the site keeps (e.g. an org guard). ANDed with the identity. */
  opts?: { where?: SQL | undefined },
): Promise<SelectResultFields<TColumns> | undefined>;
export async function selectOwnDeviceRowForUpdate(
  exec: OwnDeviceRowReader,
  agent: OwnDeviceRowIdentity,
  columns?: SelectedFields,
  opts: { where?: SQL | undefined } = {},
): Promise<unknown> {
  const query = columns ? exec.select(columns) : exec.select();
  const [row] = await query
    .from(devices)
    .where(and(ownDeviceRowCondition(agent), opts.where))
    .limit(1)
    .for('no key update');
  return row;
}

/**
 * After an own-row update (or `selectOwnDeviceRowForUpdate`) matched 0 rows:
 * does the row now belong to a DIFFERENT install? True when the row, re-read once by `id`, carries an
 * `agent_id` other than the one the caller authenticated with — a reattach
 * confirm or an in-place F3 re-enroll committed after this request
 * authenticated (#8318 §6.4). False when the row still carries the caller's
 * `agent_id` (the site's own predicate refused the write, e.g. the beat's
 * terminal-status guard), and false when the row is not visible to `exec`,
 * so a caller keeps its existing 0-row handling unless the hand-over is
 * proven.
 *
 * Read on the caller's own connection and scope, deliberately: the beats run
 * inside an org-scoped transaction, and a system read there would take a
 * second pooled connection while holding the first (#1105). Both identity
 * changes leave the row in the caller's authenticated org (the confirm
 * re-checks `target.org_id`, the re-enroll never moves it), so the row is
 * visible to the caller exactly when the question matters. Only call it on
 * the 0-row path: it is one extra read.
 */
export async function ownDeviceRowChangedHands(
  exec: OwnDeviceRowReader,
  agent: OwnDeviceRowIdentity,
): Promise<boolean> {
  const [row] = await exec
    .select({ agentId: devices.agentId })
    .from(devices)
    .where(eq(devices.id, agent.deviceId))
    .limit(1);
  return row !== undefined && row.agentId !== agent.agentId;
}
