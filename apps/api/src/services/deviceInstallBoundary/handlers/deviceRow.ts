/**
 * The target's own row (§4.1, §5.5 "Capability columns", §5.7 "Edition
 * migration"). Runs FIRST, right after the orchestrator's lock and version
 * check, so anything this boundary transaction (or a command insert waiting
 * behind its row lock) enqueues afterwards is stamped with the NEW
 * incarnation, and the command handler can cancel precisely the earlier
 * incarnations' rows.
 *
 * The server assumes nothing about the new install until it heartbeats: every
 * capability the old install declared goes back to "not declared".
 *  - The integer protocol versions are NOT NULL DEFAULT 0 and non-sticky
 *    (rewritten every beat), so 0 is "not declared".
 *  - The backup helper protocols use NULL for "not reported yet" — the same
 *    reset token-authenticated re-enroll already applies (F3).
 *  - agent_identity_epoch_ack is the ownership epoch whose signed identity the
 *    OLD install loaded; NULL means "not acknowledged" above epoch 1, so PAM
 *    dispatch waits for the new install's acknowledgement.
 *  - rollback_component_versions is the old install's component snapshot.
 *  - edition_migration_dispatched_at was the old install's once-per-device
 *    claim (§5.7).
 *  - uninstall_intent_at is the old install's "I am being uninstalled" stamp.
 *    Left set, the uninstall-intent reaper (jobs/offlineDetector.ts) would
 *    decommission the reattached row again before the new install's first
 *    heartbeat clears it.
 *
 * `INSTALL_BOUNDARY_RESET_COLUMNS` is pinned by a unit test that fails when a
 * new `*ProtocolVersion` column is added to `devices` without joining it.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { devices } from '../../../db/schema';
import type { BoundaryHandler } from '../types';

export const INSTALL_BOUNDARY_RESET_COLUMNS = {
  outboundNetworkPolicyVersion: 0,
  scriptSecretEnvVersion: 0,
  peripheralPolicyProtocolVersion: 0,
  rollbackProtocolVersion: 0,
  pamLifetimeProtocolVersion: 0,
  pamReconciliationResetProtocolVersion: 0,
  revocationLeaseProtocolVersion: 0,
  desktopFenceProtocolVersion: 0,
  consentPromptProtocolVersion: 0,
  workloadInventoryProtocolVersion: 0,
  backupReadProtocolVersion: null,
  backupIntegrityProtocolVersion: null,
  backupWriteProtocolVersion: null,
  agentIdentityEpochAck: null,
  rollbackComponentVersions: null,
  editionMigrationDispatchedAt: null,
  uninstallIntentAt: null,
} as const satisfies Partial<typeof devices.$inferInsert>;

export const deviceRowHandler: BoundaryHandler = {
  id: 'device_row',
  spec: '§4.1, §5.5, §5.7',
  tables: ['devices'],
  async run(ctx) {
    const updated = await db
      .update(devices)
      .set({
        installIncarnation: ctx.newIncarnation,
        incarnationStartedAt: ctx.at,
        lastReattachedAt: ctx.at,
        ...INSTALL_BOUNDARY_RESET_COLUMNS,
        updatedAt: ctx.at,
      })
      .where(eq(devices.id, ctx.deviceId))
      .returning({ id: devices.id });
    if (updated.length !== 1) {
      throw new Error(`install boundary: device ${ctx.deviceId} row was not advanced`);
    }
    return { devices: 1 };
  },
};
