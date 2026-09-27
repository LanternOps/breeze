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
};

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
