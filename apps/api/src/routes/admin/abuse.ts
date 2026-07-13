import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { createAuditLog } from '../../services/auditService';
import { revokeAllUserTokens } from '../../services/tokenRevocation';
import { revokeAllPartnerOauthArtifacts } from '../../oauth/grantRevocation';
import { restorePartnerTenantAccess } from '../../services/tenantLifecycle';
import { terminateUserRemoteSessions, TEARDOWN_FAILED } from '../../services/remoteSessionTeardown';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import { captureException } from '../../services/sentry';
import { requireMfa } from '../../middleware/auth';
import { withAuthLifecycleSystemTransaction } from '../../services/authLifecycle';
import {
  restoreSuspendedPartnerInTransaction,
  suspendPartnerForAbuseInTransaction,
} from '../../services/partnerActivation';

export {
  disablePartnerUsersForSuspension,
  reEnableSuspensionDisabledUsers,
} from '../../services/partnerActivation';

export const abuseRoutes = new Hono();

// confirmEmail must match the caller's account email on suspend — same
// anti-typo gate as POST /admin/tenant-erasure. Suspend queues
// self_uninstall on every device under the partner; re-enrollment from
// scratch is the only recovery path, so a fat-finger on /partners/:id
// is catastrophic. Unsuspend is reversible — only the reason matters.
const suspendSchema = z.object({
  confirmEmail: z.string().email(),
  reason: z.string().trim().min(10, 'reason must be at least 10 characters'),
});

const reasonSchema = z.object({
  reason: z.string().trim().min(10, 'reason must be at least 10 characters'),
});

abuseRoutes.post(
  '/partners/:id/suspend-for-abuse',
  requireMfa(),
  zValidator('json', suspendSchema),
  async (c) => {
    const auth = c.get('auth');
    const { reason, confirmEmail } = c.req.valid('json');
    if (confirmEmail.trim().toLowerCase() !== auth.user.email.trim().toLowerCase()) {
      return c.json(
        { error: 'confirmEmail must match your account email' },
        400,
      );
    }
    const partnerId = c.req.param('id');
    const callerId = auth.user.id;

    const result = await withAuthLifecycleSystemTransaction((tx) =>
      suspendPartnerForAbuseInTransaction(tx, partnerId, callerId)
    );

    if (result.notFound) {
      return c.json({ error: 'partner not found' }, 404);
    }

    // Outside the transaction: revoke each affected user's JWTs in Redis.
    // If Redis is degraded, the DB suspend has already committed but the
    // existing JWTs would still be honoured until natural expiry — that is
    // a partial-suspend that the operator MUST know about. We surface the
    // failure as 500 + audit with result='failure' so they can fail-close
    // (e.g. flush Redis manually, then re-run the suspend).
    const tokenRevocationFailures: Array<{ userId: string; error: string }> = [];
    const revokeResults = await Promise.allSettled(
      result.affectedUserIds.map((id) => revokeAllUserTokens(id)),
    );
    revokeResults.forEach((settled, idx) => {
      if (settled.status === 'rejected') {
        const userId = result.affectedUserIds[idx]!;
        const err = settled.reason;
        tokenRevocationFailures.push({
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
        captureException(err, c);
      }
    });

    // Task 13 — MCP H-1: revoke OAuth grants + refresh tokens so any active
    // 3rd-party-app bearer (Claude.ai, etc.) stops working on the next API
    // call rather than surviving until natural expiry (~10min access /
    // ~14d refresh). This MUST happen on the suspend path; the umbrella
    // PATCH /partners/:id route (orgs.ts) already does it for non-active
    // status transitions, but suspend-for-abuse uses its own bespoke tx.
    // Same partial-failure semantics as the user-JWT revocation above: a
    // Redis cache write failure leaves the DB committed but a grant
    // window open — surface 500 + audit failure so the operator
    // fail-closes manually.
    let oauthRevocationResult: { grantsRevoked: number; refreshTokensRevoked: number; jtisRevoked: number } | null = null;
    let oauthRevocationError: string | null = null;
    try {
      oauthRevocationResult = await revokeAllPartnerOauthArtifacts(partnerId);
    } catch (err) {
      oauthRevocationError = err instanceof Error ? err.message : String(err);
      captureException(err, c);
    }

    // Terminate any live remote-desktop sessions held by the suspended users so
    // a rogue operator can't keep screen / input / clipboard control after the
    // partner is suspended for abuse. Best-effort per session; the
    // OAuth/JWT/API-key revocation above already cut new access. Finding #3.
    // A per-user TEARDOWN_FAILED (already reported to Sentry inside the
    // service) does NOT abort the suspend, but we count it so the audit trail
    // records that some operators may have retained live control.
    let remoteSessionTeardownFailures = 0;
    const teardownResults = await Promise.allSettled(
      result.affectedUserIds.map((id) => terminateUserRemoteSessions(id))
    );
    for (const settled of teardownResults) {
      if (settled.status === 'rejected' || settled.value === TEARDOWN_FAILED) {
        remoteSessionTeardownFailures += 1;
      }
    }

    const cleanupFailures = [
      ...(tokenRevocationFailures.length > 0 ? ['user-tokens'] : []),
      ...(oauthRevocationError !== null ? ['oauth'] : []),
      ...(remoteSessionTeardownFailures > 0 ? ['remote-sessions'] : []),
    ];
    const cleanupStatus = cleanupFailures.length === 0 ? 'complete' as const : 'partial' as const;
    const auditResult: 'success' | 'failure' =
      cleanupStatus === 'complete'
        ? 'success'
        : 'failure';

    try {
      await createAuditLog({
        orgId: null,
        actorType: 'user',
        actorId: callerId,
        actorEmail: auth.user.email,
        action: 'partner.suspended_for_abuse',
        resourceType: 'partner',
        resourceId: partnerId,
        details: {
          reason,
          deviceCount: result.deviceCount,
          userCount: result.userCount,
          apiKeyCount: result.apiKeyCount,
          requestedBy: callerId,
          remoteSessionTeardownFailures,
          oauthGrantsRevoked: oauthRevocationResult?.grantsRevoked ?? 0,
          oauthRefreshTokensRevoked: oauthRevocationResult?.refreshTokensRevoked ?? 0,
          cleanupStatus,
          cleanupFailures,
          ...(tokenRevocationFailures.length > 0
            ? { tokenRevocationFailures }
            : {}),
          ...(oauthRevocationError !== null
            ? { oauthRevocationError }
            : {}),
        },
        ipAddress: getTrustedClientIpOrUndefined(c),
        userAgent: c.req.header('user-agent'),
        result: auditResult,
      });
    } catch (auditErr) {
      // The DB suspend + Redis revocation already happened. Losing the audit
      // row is recoverable (operator can reconstruct from session+command
      // tables) but we must surface it loudly so triage isn't blind.
      console.error('[admin/suspend-for-abuse] audit log write failed', {
        partnerId,
        callerId,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
      captureException(auditErr, c);
    }

    if (cleanupStatus === 'partial') {
      // Raw err.message strings suppressed in production. Counts + a
      // generic flag still surface so operators can triage; full detail
      // is in Sentry + the audit trail. Anywhere other than prod (dev,
      // test, staging-style) keeps the richer view for debugging.
      const exposeRaw = process.env.NODE_ENV !== 'production';
      return c.json(
        {
          error: 'partial_suspend',
          cleanupStatus,
          cleanupFailures,
          partnerId,
          status: 'suspended' as const,
          ...(tokenRevocationFailures.length > 0
            ? {
                tokenRevocationFailed: true,
                tokenRevocationFailureCount: tokenRevocationFailures.length,
                ...(exposeRaw ? { tokenRevocationFailures } : {}),
              }
            : {}),
          ...(oauthRevocationError !== null
            ? {
                oauthRevocationFailed: true,
                ...(exposeRaw ? { oauthRevocationError } : {}),
              }
            : {}),
          deviceCount: result.deviceCount,
          userCount: result.userCount,
          apiKeyCount: result.apiKeyCount,
          queuedUninstalls: result.deviceCount,
          remoteSessionTeardownFailures,
        },
      );
    }

    return c.json({
      partnerId,
      status: 'suspended' as const,
      deviceCount: result.deviceCount,
      userCount: result.userCount,
      apiKeyCount: result.apiKeyCount,
      queuedUninstalls: result.deviceCount,
      remoteSessionTeardownFailures,
      oauthGrantsRevoked: oauthRevocationResult?.grantsRevoked ?? 0,
      oauthRefreshTokensRevoked: oauthRevocationResult?.refreshTokensRevoked ?? 0,
      cleanupStatus,
      cleanupFailures,
    });
  }
);

abuseRoutes.post(
  '/partners/:id/unsuspend',
  requireMfa(),
  zValidator('json', reasonSchema),
  async (c) => {
    const partnerId = c.req.param('id');
    const { reason } = c.req.valid('json');
    const auth = c.get('auth');

    const result = await withAuthLifecycleSystemTransaction((tx) =>
      restoreSuspendedPartnerInTransaction(tx, partnerId)
    );

    if (result.notFound) {
      return c.json({ error: 'partner not found' }, 404);
    }

    // Restore the agent fleet that an orgs.ts-initiated suspend
    // (revokePartnerTenantAccess) token-suspended. Only meaningful when we
    // returned the partner to 'active' — a 'pending' partner is still gated
    // off for agents, so its tokens stay suspended until full activation.
    // Restore is idempotent (clears only reason-tagged 'tenant_suspended'
    // rows, leaving cross-tenant-probe suspensions intact), so on failure we
    // surface 500 + audit failure and the operator can safely re-run
    // /unsuspend. NOTE: devices that already received a self_uninstall command
    // from suspend-for-abuse cannot be auto-restored — re-enrollment required.
    let agentTokensRestored = 0;
    let agentRestoreError: string | null = null;
    if (result.status === 'active') {
      try {
        ({ agentTokensRestored } = await restorePartnerTenantAccess(partnerId));
      } catch (err) {
        agentRestoreError = err instanceof Error ? err.message : String(err);
        captureException(err, c);
      }
    }

    await createAuditLog({
      orgId: null,
      actorType: 'user',
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'partner.unsuspended',
      resourceType: 'partner',
      resourceId: partnerId,
      details: {
        reason,
        newStatus: result.status,
        userCount: result.userCount,
        agentTokensRestored,
        ...(agentRestoreError !== null ? { agentRestoreError } : {}),
        cleanupStatus: agentRestoreError === null ? 'complete' : 'partial',
        cleanupFailures: agentRestoreError === null ? [] : ['agent-restore'],
      },
      ipAddress: getTrustedClientIpOrUndefined(c),
      userAgent: c.req.header('user-agent'),
      result: agentRestoreError === null ? 'success' : 'failure',
    });

    return c.json({
      partnerId,
      status: result.status,
      userCount: result.userCount,
      agentTokensRestored,
      cleanupStatus: agentRestoreError === null ? 'complete' : 'partial',
      cleanupFailures: agentRestoreError === null ? [] : ['agent-restore'],
      ...(agentRestoreError !== null ? { agentRestoreFailed: true } : {}),
      note:
        agentRestoreError !== null
          ? 'Partner reactivated but agent-token restore failed — re-run /unsuspend to retry.'
          : 'Devices that received uninstall commands cannot be auto-restored. Re-enrollment required.',
    });
  }
);
