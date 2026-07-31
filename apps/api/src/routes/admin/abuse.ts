import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull, isNotNull, like, ne, type SQL } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  partners,
  organizations,
  devices,
  deviceCommands,
  users,
  sessions,
  apiKeys,
  partnerAbuseSignals,
} from '../../db/schema';
import { createAuditLog } from '../../services/auditService';
import { revokeAllPartnerOauthArtifacts } from '../../oauth/grantRevocation';
import { advanceUserEpochs, revokeAllRefreshFamilies, runPostCommitCleanup } from '../../services/authLifecycle';
import { restorePartnerTenantAccess } from '../../services/tenantLifecycle';
import { terminateUserRemoteSessions, TEARDOWN_FAILED } from '../../services/remoteSessionTeardown';
import { getBreezeBillingClient } from '../../services/breezeBillingClient';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import { billingStatusContradictsPayment } from '../../services/partnerActivation';
import { captureException } from '../../services/sentry';
import { requireMfa } from '../../middleware/auth';
import type { Database } from '../../db';

export const abuseRoutes = new Hono();

// The `users.disabled_reason` marker written by partner suspension. Unsuspend
// re-enables exactly the users carrying it, leaving users disabled for any other
// reason (compromise, off-boarding, manual admin action → NULL) untouched.
// See #917 (L-5).
const SUSPENSION_DISABLED_REASON = 'partner_suspended';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Disable the currently-active non-platform-admin users under a partner as part
 * of suspension, stamping the suspension marker so unsuspend restores exactly
 * these (back to 'active'). We deliberately only touch `status='active'` users:
 *  - already-`disabled` users keep their existing reason (e.g. compromise), so
 *    unsuspend won't resurrect them; and
 *  - `invited` users are left invited rather than disabled — the partner-level
 *    suspension gate already blocks them, and stamping them would make unsuspend
 *    silently promote an unaccepted invite into a full 'active' account.
 * Returns the ids actually disabled by this call.
 */
export function disablePartnerUsersForSuspension(tx: Tx, partnerId: string) {
  return tx
    .update(users)
    .set({ status: 'disabled', disabledReason: SUSPENSION_DISABLED_REASON, updatedAt: new Date() })
    .where(
      and(
        eq(users.partnerId, partnerId),
        eq(users.isPlatformAdmin, false),
        eq(users.status, 'active'),
      ),
    )
    .returning({ id: users.id });
}

/**
 * Re-enable only the users that THIS partner's suspension disabled (marker set),
 * clearing the marker. Users disabled for any other reason stay disabled.
 */
export function reEnableSuspensionDisabledUsers(tx: Tx, partnerId: string) {
  return tx
    .update(users)
    .set({ status: 'active', disabledReason: null, updatedAt: new Date() })
    .where(
      and(
        eq(users.partnerId, partnerId),
        eq(users.status, 'disabled'),
        eq(users.disabledReason, SUSPENSION_DISABLED_REASON),
      ),
    )
    .returning({ id: users.id });
}

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

    const result = await withSystemDbAccessContext(async () => {
      return db.transaction(async (tx) => {
        const [partner] = await tx
          .select({ id: partners.id, status: partners.status })
          .from(partners)
          .where(eq(partners.id, partnerId))
          .limit(1);

        if (!partner) {
          return { notFound: true as const };
        }

        await tx
          .update(partners)
          .set({ status: 'suspended', updatedAt: new Date() })
          .where(eq(partners.id, partnerId));

        // Collect device IDs under this partner (one query, used for both queueing
        // uninstalls and cancelling other pending commands).
        const partnerDevices = await tx
          .select({ id: devices.id })
          .from(devices)
          .innerJoin(organizations, eq(devices.orgId, organizations.id))
          .where(eq(organizations.partnerId, partnerId));
        const deviceIds = partnerDevices.map((d) => d.id);
        const deviceCount = deviceIds.length;

        if (deviceCount > 0) {
          // Queue a self_uninstall for every device in one INSERT (multi-row VALUES).
          await tx.insert(deviceCommands).values(
            deviceIds.map((id) => ({
              deviceId: id,
              type: 'self_uninstall',
              payload: { removeConfig: true },
              status: 'pending',
              targetRole: 'agent',
              createdBy: callerId,
            }))
          );

          // Cancel any other pending/sent commands for those devices.
          await tx
            .update(deviceCommands)
            .set({
              status: 'cancelled',
              completedAt: new Date(),
              result: { reason: 'partner_suspended_for_abuse' },
            })
            .where(
              and(
                inArray(deviceCommands.deviceId, deviceIds),
                ne(deviceCommands.type, 'self_uninstall'),
                inArray(deviceCommands.status, ['pending', 'sent'])
              )
            );
        }

        // Collect users for revocation BEFORE deleting sessions.
        const partnerUserRows = await tx
          .select({ id: users.id, isPlatformAdmin: users.isPlatformAdmin })
          .from(users)
          .where(eq(users.partnerId, partnerId));
        const partnerUserIds = partnerUserRows.map((u) => u.id);

        // Delete sessions for all partner users EXCEPT the calling platform
        // admin if they happen to be a member. We also skip them in the JWT
        // revocation step below — keeps the responder logged in mid-incident.
        const sessionTargets = partnerUserIds.filter((id) => id !== callerId);
        if (sessionTargets.length > 0) {
          await tx.delete(sessions).where(inArray(sessions.userId, sessionTargets));
        }

        // Disable users — but never disable the calling platform admin if
        // they happen to be a member of the partner being suspended. Already-
        // disabled users keep their existing disabled_reason so unsuspend can
        // tell suspension-disabled users apart from the rest (#917 L-5). Token/
        // session revocation below still covers ALL partner users via
        // affectedUserIds, independent of this set.
        const disableResult = await disablePartnerUsersForSuspension(tx, partnerId);
        const userCount = disableResult.length;

        // Task 9: multi-user mutation — advance each disabled user's auth
        // epoch and durably revoke their refresh-token families in the SAME
        // transaction as the disable, so a rollback undoes all three
        // together. RLS on refresh_token_families is user-id-scoped (self OR
        // system); this transaction already runs under the system context
        // above, so the revoke is visible/effective for every target user.
        for (const { id } of disableResult) {
          await advanceUserEpochs(tx, id, { auth: true });
          await revokeAllRefreshFamilies(tx, id, 'suspended');
        }

        // Revoke API keys for orgs under this partner.
        const partnerOrgs = await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.partnerId, partnerId));
        const orgIds = partnerOrgs.map((o) => o.id);

        let apiKeyCount = 0;
        if (orgIds.length > 0) {
          const apiKeyResult = await tx
            .update(apiKeys)
            .set({ status: 'revoked', updatedAt: new Date() })
            .where(and(inArray(apiKeys.orgId, orgIds), ne(apiKeys.status, 'revoked')))
            .returning({ id: apiKeys.id });
          apiKeyCount = apiKeyResult.length;
        }

        return {
          notFound: false as const,
          deviceCount,
          userCount,
          apiKeyCount,
          affectedUserIds: partnerUserRows
            .filter((u) => !(u.isPlatformAdmin && u.id === callerId))
            .map((u) => u.id),
        };
      });
    });

    if (result.notFound) {
      return c.json({ error: 'partner not found' }, 404);
    }

    // Outside the transaction: run the lifecycle service's post-commit
    // cleanup (Redis token cutoff, permission-cache clear, per-user OAuth-
    // artifact revocation) for every affected user. Never throws — see
    // runPostCommitCleanup's doc comment. If the Redis cutoff step failed,
    // the DB suspend (and the epoch bump + durable refresh-family revocation
    // already committed inside the transaction) still stands, but the
    // existing JWT would be honoured until natural expiry — a partial-
    // suspend the operator MUST know about. We surface that as 500 + audit
    // with result='failure' so they can fail-close (e.g. flush Redis
    // manually, then re-run the suspend).
    const tokenRevocationFailures: Array<{ userId: string; error: string }> = [];
    const cleanupResults = await Promise.all(
      result.affectedUserIds.map((id) => runPostCommitCleanup(id)),
    );
    cleanupResults.forEach((cleanup, idx) => {
      if (!cleanup.redisOk) {
        tokenRevocationFailures.push({
          userId: result.affectedUserIds[idx]!,
          error: 'Redis token cutoff failed — see server logs for detail',
        });
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

    // Cancel the partner's billing subscription so a suspended-for-abuse account
    // stops billing (a stolen card keeps getting charged otherwise) instead of
    // waiting for a manual cancel in Stripe. Best-effort like the teardown steps
    // above — a billing-service hiccup must NOT abort a suspension already
    // committed to the DB. Never refunds (that stays a manual operator decision).
    // Skipped entirely on installs with no billing service configured
    // (self-hosted). Outcome is recorded in the audit trail either way.
    let billingSubscriptionCanceled: boolean | null = null;
    let billingCancelError: string | null = null;
    if (process.env.BREEZE_BILLING_URL) {
      try {
        const cancelResult = await getBreezeBillingClient().cancelSubscription({
          partnerId,
          immediate: true,
        });
        billingSubscriptionCanceled = cancelResult.canceled;
      } catch (err) {
        billingCancelError = err instanceof Error ? err.message : String(err);
        captureException(err, c);
      }
    }

    const auditResult: 'success' | 'failure' =
      tokenRevocationFailures.length === 0 && oauthRevocationError === null
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
          billingSubscriptionCanceled,
          ...(billingCancelError !== null ? { billingCancelError } : {}),
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

    if (tokenRevocationFailures.length > 0 || oauthRevocationError !== null) {
      // Raw err.message strings suppressed in production. Counts + a
      // generic flag still surface so operators can triage; full detail
      // is in Sentry + the audit trail. Anywhere other than prod (dev,
      // test, staging-style) keeps the richer view for debugging.
      const exposeRaw = process.env.NODE_ENV !== 'production';
      return c.json(
        {
          error: 'partial_suspend',
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
          billingSubscriptionCanceled,
          ...(billingCancelError !== null ? { billingCancelFailed: true } : {}),
        },
        500,
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
      // The whole point of the billing step is "stop charging a stolen card" —
      // an operator must see a failed cancel in the response, not only in
      // Sentry/audit, so they can cancel manually in Stripe.
      billingSubscriptionCanceled,
      ...(billingCancelError !== null ? { billingCancelFailed: true } : {}),
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

    const result = await withSystemDbAccessContext(async () => {
      return db.transaction(async (tx) => {
        const [partner] = await tx
          .select({
            id: partners.id,
            paymentMethodAttachedAt: partners.paymentMethodAttachedAt,
            emailVerifiedAt: partners.emailVerifiedAt,
            billingSubscriptionStatus: partners.billingSubscriptionStatus,
          })
          .from(partners)
          .where(eq(partners.id, partnerId))
          .limit(1);

        if (!partner) {
          return { notFound: true as const };
        }

        // Preserve the FULL activation gate (email verification AND payment
        // method) — unsuspend must not become the one path that activates an
        // unverified partner. Otherwise route back through pending-activation.
        //
        // The billing-status veto matters more here than anywhere else: a
        // partner suspended for card-testing abuse typically carries an
        // `incomplete_expired` subscription, and before the veto its (falsely
        // written) payment stamp would send it straight back to `active` under
        // an admin's unsuspend. Vetoed partners land on `pending` and must
        // complete a real payment.
        const newStatus: 'active' | 'pending' =
          partner.paymentMethodAttachedAt &&
          partner.emailVerifiedAt &&
          !billingStatusContradictsPayment(partner.billingSubscriptionStatus)
            ? 'active'
            : 'pending';

        await tx
          .update(partners)
          .set({ status: newStatus, updatedAt: new Date() })
          .where(eq(partners.id, partnerId));

        // Only restore users THIS suspension disabled — not users disabled for
        // compromise / off-boarding / manual admin action (#917 L-5).
        const reEnabled = await reEnableSuspensionDisabledUsers(tx, partnerId);

        return { notFound: false as const, status: newStatus, userCount: reEnabled.length };
      });
    });

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
      },
      ipAddress: getTrustedClientIpOrUndefined(c),
      userAgent: c.req.header('user-agent'),
      result: agentRestoreError === null ? 'success' : 'failure',
    });

    if (agentRestoreError !== null) {
      return c.json(
        {
          partnerId,
          status: result.status,
          userCount: result.userCount,
          agentRestoreFailed: true,
          note: 'Partner reactivated but agent-token restore failed — re-run /unsuspend to retry.',
        },
        500,
      );
    }

    return c.json({
      partnerId,
      status: result.status,
      userCount: result.userCount,
      agentTokensRestored,
      note:
        'Devices that received uninstall commands cannot be auto-restored. Re-enrollment required.' +
        (process.env.BREEZE_BILLING_URL
          ? ' If suspend-for-abuse canceled the subscription, billing is NOT auto-restored — re-create it manually for a wrongly-suspended partner.'
          : ''),
    });
  }
);

// ---------------------------------------------------------------------------
// Abuse-signal acknowledgement (ops tooling).
//
// partner_abuse_signals is system-only under forced RLS (see the
// 2026-07-13-partner-abuse-signals migration) — a request-context query would
// silently see zero rows, so every read/write below runs under
// withSystemDbAccessContext, exactly like services/abuseSignals/ does.
//
// What acknowledging suppresses (see services/abuseSignals/persistence.ts and
// runAbuseDigest in services/abuseSignals/index.ts):
//  - the hourly sweep's re-notify path: an open row that has not yet been
//    delivered (`delivered_at IS NULL`, e.g. Discord delivery kept failing)
//    retries on every sweep until `acknowledged_at` is set;
//  - the weekly digest: acknowledged rows drop out of the
//    "open unacknowledged signals" severity counts and the watch-tier list.
// Acknowledging does NOT resolve the row — the sweep keeps updating
// severity/score on it and will still auto-resolve it as stale when the
// underlying condition clears.

/** Escape LIKE wildcards so a signalKey filter is a literal prefix match. */
function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

const listSignalsQuerySchema = z.object({
  status: z.enum(['open', 'acknowledged', 'resolved', 'all']).default('open'),
  partnerId: z.string().uuid().optional(),
  signalKey: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const bulkAcknowledgeSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
});

type AbuseSignalRow = typeof partnerAbuseSignals.$inferSelect;

function toSignalResponse(r: AbuseSignalRow) {
  return {
    id: r.id,
    partnerId: r.partnerId,
    signalKey: r.signalKey,
    severity: r.severity,
    score: r.score,
    evidence: r.evidence,
    firstFiredAt: r.firstFiredAt,
    computedAt: r.computedAt,
    resolvedAt: r.resolvedAt,
    acknowledgedAt: r.acknowledgedAt,
    acknowledgedBy: r.acknowledgedBy,
    deliveredAt: r.deliveredAt,
  };
}

abuseRoutes.get(
  '/signals',
  requireMfa(),
  zValidator('query', listSignalsQuerySchema),
  async (c) => {
    const { status, partnerId, signalKey, limit, offset } = c.req.valid('query');

    const conds: SQL[] = [];
    if (status === 'open') {
      conds.push(isNull(partnerAbuseSignals.resolvedAt), isNull(partnerAbuseSignals.acknowledgedAt));
    } else if (status === 'acknowledged') {
      conds.push(isNull(partnerAbuseSignals.resolvedAt), isNotNull(partnerAbuseSignals.acknowledgedAt));
    } else if (status === 'resolved') {
      conds.push(isNotNull(partnerAbuseSignals.resolvedAt));
    }
    if (partnerId) {
      conds.push(eq(partnerAbuseSignals.partnerId, partnerId));
    }
    if (signalKey) {
      conds.push(like(partnerAbuseSignals.signalKey, `${escapeLikePrefix(signalKey)}%`));
    }

    const rows = await withSystemDbAccessContext(() =>
      db
        .select()
        .from(partnerAbuseSignals)
        .where(conds.length > 0 ? and(...conds) : undefined)
        .orderBy(desc(partnerAbuseSignals.computedAt))
        .limit(limit)
        .offset(offset),
    );

    return c.json({ signals: rows.map(toSignalResponse), limit, offset });
  },
);

abuseRoutes.post('/signals/:id/acknowledge', requireMfa(), async (c) => {
  const auth = c.get('auth');
  const parsedId = z.string().uuid().safeParse(c.req.param('id'));
  if (!parsedId.success) {
    return c.json({ error: 'invalid signal id' }, 400);
  }
  const id = parsedId.data;

  const result = await withSystemDbAccessContext(async () => {
    // Guarded write first: the `acknowledged_at IS NULL` predicate makes a
    // concurrent double-ack race collapse into the idempotent path below.
    const [updated] = await db
      .update(partnerAbuseSignals)
      .set({ acknowledgedAt: new Date(), acknowledgedBy: auth.user.email })
      .where(and(eq(partnerAbuseSignals.id, id), isNull(partnerAbuseSignals.acknowledgedAt)))
      .returning();
    if (updated) {
      return { notFound: false as const, alreadyAcknowledged: false as const, row: updated };
    }

    // Nothing written — either the row doesn't exist (404) or it was already
    // acknowledged (idempotent no-op success returning current state).
    const [existing] = await db
      .select()
      .from(partnerAbuseSignals)
      .where(eq(partnerAbuseSignals.id, id))
      .limit(1);
    if (!existing) {
      return { notFound: true as const };
    }
    return { notFound: false as const, alreadyAcknowledged: true as const, row: existing };
  });

  if (result.notFound) {
    return c.json({ error: 'signal not found' }, 404);
  }

  if (!result.alreadyAcknowledged) {
    await createAuditLog({
      orgId: null,
      actorType: 'user',
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'abuse_signal.acknowledged',
      resourceType: 'abuse_signal',
      resourceId: id,
      details: {
        partnerId: result.row.partnerId,
        signalKey: result.row.signalKey,
        severity: result.row.severity,
      },
      ipAddress: getTrustedClientIpOrUndefined(c),
      userAgent: c.req.header('user-agent'),
      result: 'success',
    });
  }

  return c.json({
    signal: toSignalResponse(result.row),
    alreadyAcknowledged: result.alreadyAcknowledged,
  });
});

abuseRoutes.post(
  '/signals/acknowledge-bulk',
  requireMfa(),
  zValidator('json', bulkAcknowledgeSchema),
  async (c) => {
    const auth = c.get('auth');
    const { ids } = c.req.valid('json');
    const uniqueIds = [...new Set(ids)];

    const outcome = await withSystemDbAccessContext(async () => {
      const acked = await db
        .update(partnerAbuseSignals)
        .set({ acknowledgedAt: new Date(), acknowledgedBy: auth.user.email })
        .where(
          and(
            inArray(partnerAbuseSignals.id, uniqueIds),
            isNull(partnerAbuseSignals.acknowledgedAt),
          ),
        )
        .returning({ id: partnerAbuseSignals.id });
      const ackedIds = new Set(acked.map((r) => r.id));

      // Distinguish already-acknowledged (idempotent success) from unknown ids.
      const remaining = uniqueIds.filter((sigId) => !ackedIds.has(sigId));
      const existingRemaining =
        remaining.length > 0
          ? await db
              .select({ id: partnerAbuseSignals.id })
              .from(partnerAbuseSignals)
              .where(inArray(partnerAbuseSignals.id, remaining))
          : [];
      const existingIds = new Set(existingRemaining.map((r) => r.id));

      return {
        results: uniqueIds.map((sigId) => ({
          id: sigId,
          status: ackedIds.has(sigId)
            ? ('acknowledged' as const)
            : existingIds.has(sigId)
              ? ('already_acknowledged' as const)
              : ('not_found' as const),
        })),
        acknowledgedCount: ackedIds.size,
        acknowledgedIds: [...ackedIds],
      };
    });

    if (outcome.acknowledgedCount > 0) {
      await createAuditLog({
        orgId: null,
        actorType: 'user',
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'abuse_signal.bulk_acknowledged',
        resourceType: 'abuse_signal',
        details: {
          requestedCount: uniqueIds.length,
          acknowledgedCount: outcome.acknowledgedCount,
          acknowledgedIds: outcome.acknowledgedIds,
        },
        ipAddress: getTrustedClientIpOrUndefined(c),
        userAgent: c.req.header('user-agent'),
        result: 'success',
      });
    }

    return c.json({
      results: outcome.results,
      acknowledgedCount: outcome.acknowledgedCount,
    });
  },
);

