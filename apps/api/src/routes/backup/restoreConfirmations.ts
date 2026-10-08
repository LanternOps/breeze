/**
 * POST /backup/restore-confirmations — typed confirmation of one restore.
 *
 * A restore of a snapshot taken before attestations existed needs a confirmed
 * authorization (services/backupRestoreGate.ts). A technician with a second
 * factor confirms it with the two-factor step-up. A technician without one
 * gets `method: 'typed'` from the restore route and confirms here by typing
 * the target device's name: this route checks the phrase and mints a
 * single-use, short-lived grant for operation
 * `backup_unattested_restore_typed`, bound to the user, session, epochs and
 * the exact (snapshot, target device, command type). The restore route then
 * consumes it and records the authorization and its audit event exactly as it
 * does for the two-factor grant (routes/backup/restoreIntegrityGate.ts).
 *
 * Nothing else is accepted here: a failed or pending attestation and an
 * unresolvable snapshot are refused, every other reason needs the two-factor
 * step-up, and callers without an interactive user session cannot confirm.
 */
import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { getUserEpochs } from '../../services/authEpochs';
import { RESTORE_INTEGRITY_MESSAGES, decideRestoreGate } from '../../services/backupRestoreGate';
import { resolveRestoreIntegrity } from '../../services/backupRestoreIntegrity';
import { mintStepUpGrant, unattestedRestoreResourceDigest } from '../../services/mfaStepUpGrant';
import { PERMISSIONS } from '../../services/permissions';
import { ENABLE_2FA } from '../auth/schemas';
import { resolveScopedOrgId } from './helpers';
import {
  UNATTESTED_RESTORE_TYPED_OPERATION,
  restoreConfirmationPhrase,
  typedConfirmationAllowedFor,
  typedConfirmationMatches,
} from './restoreIntegrityGate';
import { userIsMfaProtected } from '../auth/helpers';
import { authorizeRouteResilienceResources } from './resilienceAuthorization';
import { restoreTypedConfirmationSchema } from './schemas';

export const restoreConfirmationRoutes = new Hono();

const TYPED_CONFIRMATION_AUDIT_ACTION = 'backup.restore.typed_confirmation';

restoreConfirmationRoutes.post(
  '/restore-confirmations',
  requireScope('organization', 'partner', 'system'),
  // The grant is spendable only on a restore route, which enforces its own
  // (stricter, per-route) permissions; minting one needs only read access to
  // the backup, like the two-factor step-up mint needs none.
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  requireMfa(),
  zValidator('json', restoreTypedConfirmationSchema),
  async (c) => {
    const auth = c.get('auth');
    const userId = auth?.user?.id ?? null;
    const sid = auth?.token?.sid ?? null;
    if (!userId || !sid) {
      return c.json({ error: RESTORE_INTEGRITY_MESSAGES.snapshot_integrity_unavailable, code: 'snapshot_integrity_unavailable' }, 409);
    }
    const notApplicable = (error: string) => c.json({ error, code: 'typed_confirmation_not_applicable' }, 409);
    if (!ENABLE_2FA) {
      return notApplicable('This deployment confirms restores without two-factor authentication; start the restore again and confirm it.');
    }

    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const payload = c.req.valid('json');
    const authorization = await authorizeRouteResilienceResources(c, orgId, [
      { kind: 'snapshot', id: payload.snapshotId, role: 'source' },
      { kind: 'device', id: payload.targetDeviceId, role: 'target' },
    ], 'restore');
    if (!authorization.ok) return authorization.response;

    const integrity = await resolveRestoreIntegrity(payload.snapshotId);
    const decision = decideRestoreGate({ commandType: payload.commandType, integrity, targetDeviceId: payload.targetDeviceId });
    if (decision.kind === 'refuse') return c.json({ error: decision.message, code: decision.code }, 409);
    if (decision.kind === 'allow') return notApplicable('This restore does not need a confirmation.');
    if (!typedConfirmationAllowedFor(decision.reason)) {
      return notApplicable('Confirm this restore with two-factor authentication.');
    }
    // Read directly (not via userCanStepUp, which maps a failed lookup to
    // "has a factor"): a failed lookup here is a 503, never a wrong answer.
    let hasFactor: boolean;
    try {
      hasFactor = await userIsMfaProtected(userId);
    } catch (err) {
      console.error('[restoreConfirmations] factor lookup failed:', err);
      return c.json({ error: 'Service temporarily unavailable' }, 503);
    }
    if (hasFactor) {
      return notApplicable('Your account has two-factor authentication set up. Confirm this restore with it.');
    }
    const phrase = await restoreConfirmationPhrase(orgId, payload.targetDeviceId);
    if (!phrase) return notApplicable('Confirm this restore with two-factor authentication.');

    const auditBase = {
      orgId,
      action: TYPED_CONFIRMATION_AUDIT_ACTION,
      resourceType: 'backup_snapshot',
      resourceId: payload.snapshotId,
      details: { targetDeviceId: payload.targetDeviceId, commandType: payload.commandType, reason: decision.reason },
    };
    if (!typedConfirmationMatches(phrase, payload.confirmationText)) {
      writeRouteAudit(c, { ...auditBase, result: 'failure', details: { ...auditBase.details, failure: 'confirmation_mismatch' } });
      return c.json({ error: 'The name you typed does not match the device being restored.', code: 'confirmation_mismatch' }, 400);
    }

    const epochs = await getUserEpochs(userId);
    if (!epochs) return c.json({ error: 'Service temporarily unavailable' }, 503);
    const grantId = await mintStepUpGrant({
      userId,
      operation: UNATTESTED_RESTORE_TYPED_OPERATION,
      authEpoch: epochs.authEpoch,
      mfaEpoch: epochs.mfaEpoch,
      sid,
      resourceDigest: unattestedRestoreResourceDigest({
        snapshotDbId: payload.snapshotId,
        targetDeviceId: payload.targetDeviceId,
        commandType: payload.commandType,
      }),
    });
    if (!grantId) return c.json({ error: 'Service temporarily unavailable' }, 503);

    writeRouteAudit(c, { ...auditBase, result: 'success' });
    c.header('Cache-Control', 'no-store');
    return c.json({ stepUpGrant: grantId });
  },
);
