/**
 * mTLS certificates of parked devices (#8318 spec 2026-10-12 §10.4, §13
 * decision 9): the certificate issued at pool enrollment lives no longer than
 * the parking window, and it is revoked when the device is expired (the hourly
 * job or a deploy-key incident) or purged.
 *
 * Expiry and purge run inside their own system transaction under the
 * holding-area lock and the device row lock. These helpers write only the
 * certificate rows, in that transaction, and return the ids to revoke once it
 * has committed (`revokeCertificatesAfterCommit`, the durable lifecycle in
 * services/deviceMtlsCertificateLifecycle.ts: inline attempt, then the BullMQ
 * retry and the five-minute sweep). The provider is never called inside the
 * transaction (#1105).
 *
 * `queueCertificateRevocationCore` is not used: it demotes an active row only
 * once a replacement exists, and an expired device gets no replacement. The
 * demotion is the same guarded write the reattach confirm uses for an old
 * install's certificate with no staged successor (deviceReattach/confirm.ts):
 * state → pending_revocation, due now.
 *
 * Where mTLS was never configured a device has no certificate rows, so both
 * helpers find nothing and change nothing.
 */
import { and, eq, gt, inArray, ne } from 'drizzle-orm';
import { deviceMtlsCertificates } from '../../db/schema';
import type { Tx } from '../deviceMtlsCertificateLifecycle';

/** Rows the provider may still honour: everything not yet revoked. */
const LIVE_STATES = ['active', 'pending_activation'] as const;

/**
 * Demote the device's active and pending-activation certificates to
 * pending_revocation, due now. Returns the demoted ids, to revoke after commit.
 */
export async function demoteParkedDeviceCertificates(tx: Tx, deviceId: string, now: Date): Promise<string[]> {
  const demoted = await tx
    .update(deviceMtlsCertificates)
    .set({ state: 'pending_revocation', nextRevokeAttemptAt: now, updatedAt: now })
    .where(and(
      eq(deviceMtlsCertificates.deviceId, deviceId),
      inArray(deviceMtlsCertificates.state, [...LIVE_STATES]),
    ))
    .returning({ id: deviceMtlsCertificates.id });
  return demoted.map((row) => row.id);
}

/**
 * True while the device holds a certificate the provider may still honour: not
 * revoked and not past its own expiry. A purge deletes the certificate rows
 * with the device (composite FK cascade), and the revocation worker can only
 * revoke a row that still exists, so purge waits for these.
 */
export async function hasUnrevokedLiveCertificate(tx: Tx, deviceId: string, now: Date): Promise<boolean> {
  const [row] = await tx
    .select({ id: deviceMtlsCertificates.id })
    .from(deviceMtlsCertificates)
    .where(and(
      eq(deviceMtlsCertificates.deviceId, deviceId),
      ne(deviceMtlsCertificates.state, 'revoked'),
      gt(deviceMtlsCertificates.expiresAt, now),
    ))
    .limit(1);
  return Boolean(row);
}
