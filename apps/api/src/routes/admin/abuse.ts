import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  partners,
  organizations,
  devices,
  deviceCommands,
  users,
  sessions,
  apiKeys,
} from '../../db/schema';
import { createAuditLog } from '../../services/auditService';
import { revokeAllUserTokens } from '../../services/tokenRevocation';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import { captureException } from '../../services/sentry';

export const abuseRoutes = new Hono();

const reasonSchema = z.object({
  reason: z.string().trim().min(10, 'reason must be at least 10 characters'),
});

abuseRoutes.post(
  '/partners/:id/suspend-for-abuse',
  zValidator('json', reasonSchema),
  async (c) => {
    const partnerId = c.req.param('id');
    const { reason } = c.req.valid('json');
    const auth = c.get('auth');
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
        // they happen to be a member of the partner being suspended.
        const disableResult = await tx
          .update(users)
          .set({ status: 'disabled', updatedAt: new Date() })
          .where(
            and(
              eq(users.partnerId, partnerId),
              eq(users.isPlatformAdmin, false)
            )
          )
          .returning({ id: users.id });
        const userCount = disableResult.length;

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

    const auditResult: 'success' | 'failure' =
      tokenRevocationFailures.length === 0 ? 'success' : 'failure';

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
          ...(tokenRevocationFailures.length > 0
            ? { tokenRevocationFailures }
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

    if (tokenRevocationFailures.length > 0) {
      return c.json(
        {
          error: 'partial_suspend',
          partnerId,
          status: 'suspended' as const,
          tokenRevocationFailed: true,
          tokenRevocationFailures,
          deviceCount: result.deviceCount,
          userCount: result.userCount,
          apiKeyCount: result.apiKeyCount,
          queuedUninstalls: result.deviceCount,
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
    });
  }
);

abuseRoutes.post(
  '/partners/:id/unsuspend',
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
          })
          .from(partners)
          .where(eq(partners.id, partnerId))
          .limit(1);

        if (!partner) {
          return { notFound: true as const };
        }

        // Preserve the activation gate: only flip to 'active' if the partner
        // has a payment method attached. Otherwise, route them back through
        // the pending-activation flow.
        const newStatus: 'active' | 'pending' = partner.paymentMethodAttachedAt
          ? 'active'
          : 'pending';

        await tx
          .update(partners)
          .set({ status: newStatus, updatedAt: new Date() })
          .where(eq(partners.id, partnerId));

        const reEnabled = await tx
          .update(users)
          .set({ status: 'active', updatedAt: new Date() })
          .where(
            and(
              eq(users.partnerId, partnerId),
              eq(users.status, 'disabled')
            )
          )
          .returning({ id: users.id });

        return { notFound: false as const, status: newStatus, userCount: reEnabled.length };
      });
    });

    if (result.notFound) {
      return c.json({ error: 'partner not found' }, 404);
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
      },
      ipAddress: getTrustedClientIpOrUndefined(c),
      userAgent: c.req.header('user-agent'),
      result: 'success',
    });

    return c.json({
      partnerId,
      status: result.status,
      userCount: result.userCount,
      note:
        'Devices that received uninstall commands cannot be auto-restored. Re-enrollment required.',
    });
  }
);

