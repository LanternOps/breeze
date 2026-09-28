/**
 * Shared delivery-refresher contract, kept in a leaf module so the modules
 * that implement refreshers (which reach the DB) and `commandDelivery.ts`
 * (which registers them) can both import it without an import cycle.
 */

/**
 * The command a delivery refresher is preparing. `claimedAt` is the claim
 * timestamp (`device_commands.executed_at`) — the generation marker for this
 * particular delivery attempt, null only when no claim exists yet.
 */
export type DeliveryRefreshContext = {
  commandId: string;
  deviceId: string;
  type: string;
  claimedAt: Date | null;
  /**
   * The backup helper's brokered-read protocol as reported by the heartbeat
   * that is delivering this command, when the delivery path has it. It is
   * authoritative over the stored (non-sticky) device column, which a
   * guarded device write may not have updated.
   */
  reportedBackupReadProtocolVersion?: number;
  /**
   * The backup helper's snapshot integrity and storage write protocols, as
   * reported by the same heartbeat. Same semantics as the read field: absent
   * on delivery paths that carry no heartbeat report, where a refresher falls
   * back to the stored (non-sticky) device column.
   */
  reportedBackupIntegrityProtocolVersion?: number;
  reportedBackupWriteProtocolVersion?: number;
};

/** The helper-protocol fields a heartbeat hands to delivery refreshers. */
export type ReportedBackupHelperProtocols = Pick<
  DeliveryRefreshContext,
  'reportedBackupReadProtocolVersion' | 'reportedBackupIntegrityProtocolVersion' | 'reportedBackupWriteProtocolVersion'
>;

/**
 * Thrown by a delivery refresher when the command can NEVER be delivered as
 * queued — its stable reference no longer resolves, points at another
 * organization, or no longer matches what was decided at enqueue. Distinct
 * from an ordinary error (an outage, a dropped connection), which releases the
 * row for a later attempt: a refused row is expired instead, so it is not
 * re-claimed on every heartbeat until its execution clock runs out. The
 * message is operator-facing (it ends up on the command result), so it must
 * never contain credential material.
 */
export class CommandDeliveryRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandDeliveryRefusedError';
  }
}

export function isCommandDeliveryRefusal(err: unknown): err is CommandDeliveryRefusedError {
  return err instanceof CommandDeliveryRefusedError;
}

/**
 * Thrown by a delivery refresher when the command cannot be delivered YET but
 * will be deliverable shortly without anyone acting — a snapshot's file index
 * that is still being prepared, say. The row is released back to `pending`
 * with the reason recorded (`result.deliveryDeferred`), and the next claim
 * tries again; if it is never delivered, the stale reaper reports that reason.
 * An expected state, not a fault: it is not reported as an error. The message
 * is operator-facing and must never contain credential material.
 */
export class CommandDeliveryDeferredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandDeliveryDeferredError';
  }
}

export function isCommandDeliveryDeferral(err: unknown): err is CommandDeliveryDeferredError {
  return err instanceof CommandDeliveryDeferredError;
}
