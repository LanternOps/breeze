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
