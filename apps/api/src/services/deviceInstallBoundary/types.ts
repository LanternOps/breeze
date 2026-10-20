/**
 * Shared types of the install incarnation boundary (#8318 wave 1a, spec
 * docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md §5).
 * A leaf module, so handlers, the classification manifest and the contract
 * tests can all import it without a cycle through the orchestrator.
 */

/** The reason written into free-text reason columns by the boundary. */
export const INSTALL_BOUNDARY_REASON = 'superseded_by_reattach' as const;

/** The PAM failure code the spec names (§5.3, §13 decision 2). */
export const PAM_SUPERSEDED_FAILURE_CODE = 'superseded_by_reinstall' as const;

/** The detach / close reason the spec names for AI Operator work and live chats (§5.6). */
export const DEVICE_REINSTALLED_REASON = 'device_reinstalled' as const;

export const BOUNDARY_HANDLER_IDS = [
  'device_row',
  'commands',
  'pam',
  'backup_recovery',
  'grants',
  'sessions',
  'work_in_flight',
  'install_state',
] as const;
export type BoundaryHandlerId = (typeof BOUNDARY_HANDLER_IDS)[number];

/** What every handler is told about the boundary it runs in. */
export interface BoundaryContext {
  deviceId: string;
  /** The device's org, read under the device row lock. */
  orgId: string;
  /** The device's PAM ownership epoch, read under the device row lock. */
  ownershipEpoch: number;
  previousIncarnation: number;
  newIncarnation: number;
  /** One timestamp for every write of this boundary. */
  at: Date;
  /** The human who authorized the reattach, for `revoked_by`-style columns. Null = the system. */
  actorUserId: string | null;
}

/** Row counts a handler reports, keyed `<table>` or `<table>.<action>`. */
export type BoundaryCounts = Record<string, number>;

export interface BoundaryHandler {
  id: BoundaryHandlerId;
  /** The spec section the handler implements. */
  spec: string;
  /**
   * The device-referencing tables this handler invalidates, cancels, resets
   * or clears. The §5.8 contract test checks that every table the
   * classification manifest marks `handler` names a handler that lists it.
   */
  tables: readonly string[];
  run(ctx: BoundaryContext): Promise<BoundaryCounts>;
}

/** Count rows returned by a raw `tx.execute` / `db.execute` (postgres.js shape). */
export function rowCount(result: unknown): number {
  const value = (result as { rows?: unknown[] }).rows ?? result;
  return Array.isArray(value) ? value.length : 0;
}
