import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { db } from '../db';
import {
  apiKeys,
  deviceCommands,
  devices,
  organizations,
  partners,
  sessions,
  users,
} from '../db/schema';
import type { AuthLifecycleTransaction } from './authLifecycle';
import {
  invalidateLockedPartnerUsersInTransaction,
  lockPartnerLifecycleRows,
} from './partnerLifecycleLock';

/**
 * Partner activation reconciliation (issue #718).
 *
 * A hosted self-service partner is created `pending` and only becomes
 * `active` once BOTH preconditions are independently satisfied:
 *
 *   1. email verified  → `partners.email_verified_at` is set, and
 *   2. payment attached → `partners.payment_method_attached_at` is set.
 *
 * These two events arrive on independent paths and in either order:
 *
 *   - pay-then-verify: breeze-billing writes `payment_method_attached_at`
 *     (and normally flips status), then the user clicks the verify link.
 *     `consumeVerificationToken` reconciles this ordering.
 *   - verify-then-pay: the user verifies first, then breeze-billing writes
 *     `payment_method_attached_at`. If breeze-billing has a webhook /
 *     idempotency gap and writes the timestamp without flipping status, the
 *     partner is stranded `pending` forever even though both preconditions
 *     are met. `partnerGuard` reconciles this ordering on the next
 *     authenticated request.
 *
 * The predicate below is the SINGLE source of truth shared by both paths so
 * they cannot drift apart.
 *
 * SECURITY / PRODUCT INVARIANTS (issue #718 rescope — do not relax):
 *   - NEVER activate on time elapsed. There is no "it's been N days, let them
 *     in" branch anywhere. A failed signup payment correctly stays `pending`.
 *   - NEVER activate on email-verified alone. `payment_method_attached_at` is
 *     written only by breeze-billing on a confirmed Stripe capture, so it is
 *     the proof-of-payment gate. Activating without it would comp a non-payer.
 *   - ONLY `pending` partners are eligible. `suspended` / `churned` /
 *     soft-deleted partners are never resurrected by reconciliation — that
 *     would undo the abuse-suspension and #568 mid-session cutoff.
 *
 * Self-hosted (`IS_HOSTED=false`) partners are created `active` directly by
 * `register-partner`, so they never enter the `pending` state and this
 * predicate simply never matches for them — payment is implicitly waived by
 * never being required in the first place.
 */

export interface ReconcilablePartner {
  status: string;
  emailVerifiedAt: Date | string | null;
  paymentMethodAttachedAt: Date | string | null;
  deletedAt?: Date | string | null;
}

export interface PartnerActivationStatusMetadata {
  message?: string;
  actionUrl?: string;
  actionLabel?: string;
}

export const PARTNER_SUSPENSION_DISABLED_REASON = 'partner_suspended';

/** Restore only users carrying the marker written by partner suspension. */
export function reEnableSuspensionDisabledUsers(
  tx: AuthLifecycleTransaction,
  partnerId: string,
) {
  return tx
    .update(users)
    .set({ status: 'active', disabledReason: null, updatedAt: new Date() })
    .where(
      and(
        eq(users.partnerId, partnerId),
        eq(users.status, 'disabled'),
        eq(users.disabledReason, PARTNER_SUSPENSION_DISABLED_REASON),
      ),
    )
    .returning({ id: users.id });
}

/**
 * True iff a `pending` partner has independently met BOTH activation
 * preconditions and should be flipped to `active`. Pure — no I/O — so it is
 * trivially testable and reusable from any read path.
 */
export function shouldActivatePendingPartner(partner: ReconcilablePartner): boolean {
  if (partner.deletedAt != null) return false;
  return (
    partner.status === 'pending' &&
    partner.emailVerifiedAt != null &&
    partner.paymentMethodAttachedAt != null
  );
}

/**
 * The mutation half of activation. Flips the partner to `active` and clears
 * the "Awaiting email verification" / "Finish payment" status banner keys that
 * breeze-billing (or register-partner hooks) may have written while the tenant
 * was `pending`, so the dashboard doesn't show a stale inactive banner.
 *
 * Mirrors the JSONB-null pattern in
 * breeze-billing/src/services/partnerSync.ts:activatePartner and the inline
 * version previously duplicated in consumeVerificationToken.
 *
 * `tx` is any Drizzle-compatible executor (the request db, a transaction, or
 * a system-scoped handle). The caller owns the RLS scope; this helper only
 * issues the UPDATE.
 *
 * Returns whether this caller won the activation. The UPDATE is guarded by
 * `status = 'pending'` so a concurrent reconciliation (e.g. verify-then-pay
 * racing the billing webhook) is idempotent — the loser updates 0 rows and
 * does not clobber an already-active partner.
 */
export async function activatePartnerRow(
  tx: Pick<typeof db, 'update'>,
  partnerId: string,
  now: Date = new Date(),
  statusMetadata?: PartnerActivationStatusMetadata,
): Promise<boolean> {
  const clearedSettings = sql`jsonb_set(
    jsonb_set(
      jsonb_set(
        COALESCE(${partners.settings}, '{}'::jsonb),
        '{statusMessage}', 'null'::jsonb
      ),
      '{statusActionUrl}', 'null'::jsonb
    ),
    '{statusActionLabel}', 'null'::jsonb
  )`;
  const statusSettings: Record<string, string> = {};
  if (statusMetadata?.message) statusSettings.statusMessage = statusMetadata.message;
  if (statusMetadata?.actionUrl) statusSettings.statusActionUrl = statusMetadata.actionUrl;
  if (statusMetadata?.actionLabel) statusSettings.statusActionLabel = statusMetadata.actionLabel;
  const settings = Object.keys(statusSettings).length > 0
    ? sql`${clearedSettings} || ${JSON.stringify(statusSettings)}::jsonb`
    : clearedSettings;

  const activated = await tx
    .update(partners)
    .set({
      status: 'active' as const,
      settings,
      updatedAt: now,
    })
    .where(sql`${partners.id} = ${partnerId} AND ${partners.status} = 'pending'`)
    .returning({ id: partners.id });
  return activated.length > 0;
}

export interface PartnerActivationResult {
  activated: boolean;
  userIds: string[];
}

type PartnerLifecycleStatus = 'pending' | 'active' | 'suspended' | 'churned';

/** Apply a delayed registration-hook status only while the partner is still in
 * the state the hook request observed. Abuse suspension/deletion always wins a
 * stale external response. */
export async function applyRegistrationHookStatusTransition(
  tx: AuthLifecycleTransaction,
  input: {
    partnerId: string;
    expectedStatus: PartnerLifecycleStatus;
    nextStatus: PartnerLifecycleStatus;
    statusMetadata?: PartnerActivationStatusMetadata;
  },
): Promise<{ applied: boolean }> {
  const locked = await lockPartnerLifecycleRows(tx, input.partnerId);
  const updateSet: Record<string, unknown> = {
    status: input.nextStatus,
    updatedAt: new Date(),
  };
  const metadata = input.statusMetadata;
  const statusSettings: Record<string, string> = {};
  if (metadata?.message) statusSettings.statusMessage = metadata.message;
  if (metadata?.actionUrl) statusSettings.statusActionUrl = metadata.actionUrl;
  if (metadata?.actionLabel) statusSettings.statusActionLabel = metadata.actionLabel;
  if (Object.keys(statusSettings).length > 0) {
    updateSet.settings = sql`COALESCE(${partners.settings}, '{}'::jsonb) || ${JSON.stringify(statusSettings)}::jsonb`;
  }

  const updated = await tx
    .update(partners)
    .set(updateSet)
    .where(and(
      eq(partners.id, input.partnerId),
      eq(partners.status, input.expectedStatus),
      isNull(partners.deletedAt),
    ))
    .returning({ id: partners.id });
  if (updated.length === 0) return { applied: false };

  await invalidateLockedPartnerUsersInTransaction(
    tx,
    locked,
    'registration-hook-status-changed',
  );
  return { applied: true };
}

/**
 * Activate one pending partner and invalidate every session that was minted
 * while that tenant was inactive. The caller must supply the active system
 * transaction so the status flip, auth-epoch advances, and durable family
 * revocations commit or roll back together.
 */
export async function activatePendingPartnerAndInvalidateSessions(
  tx: AuthLifecycleTransaction,
  partnerId: string,
  now: Date = new Date(),
  statusMetadata?: PartnerActivationStatusMetadata,
): Promise<PartnerActivationResult> {
  const locked = await lockPartnerLifecycleRows(tx, partnerId);

  if (!(await activatePartnerRow(tx, partnerId, now, statusMetadata))) {
    return { activated: false, userIds: [] };
  }

  await invalidateLockedPartnerUsersInTransaction(tx, locked, 'partner-activated');

  return { activated: true, userIds: locked.userIds };
}

/**
 * Restore one explicitly suspended partner without bypassing the normal
 * activation gates. The row lock keeps the eligibility check, status write,
 * suspension-marker cleanup, and durable auth invalidation atomic with respect
 * to concurrent partner lifecycle changes.
 */
export async function restoreSuspendedPartnerInTransaction(
  tx: AuthLifecycleTransaction,
  partnerId: string,
) {
  const locked = await lockPartnerLifecycleRows(tx, partnerId);
  const partner = locked.partner;

  // Deliberately use the same response shape for missing and ineligible rows:
  // callers must not be able to use this endpoint as a partner-status oracle.
  if (!partner || partner.status !== 'suspended') {
    return { notFound: true as const };
  }

  const newStatus: 'active' | 'pending' = shouldActivatePendingPartner({
    status: 'pending',
    emailVerifiedAt: partner.emailVerifiedAt,
    paymentMethodAttachedAt: partner.paymentMethodAttachedAt,
  })
    ? 'active'
    : 'pending';

  await tx
    .update(partners)
    .set({ status: newStatus, updatedAt: new Date() })
    .where(eq(partners.id, partnerId));

  // Restore only users disabled by suspension; independently invalidate every
  // affected partner user. Include the returned rows defensively and dedupe so
  // a concurrent legacy/membership repair cannot leave a restored user out.
  const reEnabled = await reEnableSuspensionDisabledUsers(tx, partnerId);
  const affectedUserIds = [...new Set([
    ...locked.userIds,
    ...reEnabled.map((user) => user.id),
  ])].sort();
  await invalidateLockedPartnerUsersInTransaction(
    tx,
    locked,
    'partner-reactivated',
    affectedUserIds,
  );

  return {
    notFound: false as const,
    status: newStatus,
    userCount: reEnabled.length,
    affectedUserIds,
  };
}

/**
 * Mark only currently active, non-platform users as suspension-disabled.
 * Existing disabled users retain their independent reason and invited users
 * remain invited, so restore cannot resurrect an unrelated disabled identity
 * or promote an unaccepted invite.
 */
export function disablePartnerUsersForSuspension(
  tx: AuthLifecycleTransaction,
  partnerId: string,
) {
  return tx
    .update(users)
    .set({
      status: 'disabled',
      disabledReason: PARTNER_SUSPENSION_DISABLED_REASON,
      updatedAt: new Date(),
    })
    .where(and(
      eq(users.partnerId, partnerId),
      eq(users.isPlatformAdmin, false),
      eq(users.status, 'active'),
    ))
    .returning({ id: users.id });
}

/** Abuse suspension transaction core. Post-commit Redis/OAuth/remote cleanup
 * remains route-owned; every durable partner/user/family/credential mutation
 * stays atomic here under the shared lifecycle lock order. */
export async function suspendPartnerForAbuseInTransaction(
  tx: AuthLifecycleTransaction,
  partnerId: string,
  callerId: string,
) {
  const locked = await lockPartnerLifecycleRows(tx, partnerId);
  if (!locked.partner) return { notFound: true as const };

  await tx
    .update(partners)
    .set({ status: 'suspended', updatedAt: new Date() })
    .where(eq(partners.id, partnerId));

  const partnerDevices = await tx
    .select({ id: devices.id })
    .from(devices)
    .innerJoin(organizations, eq(devices.orgId, organizations.id))
    .where(eq(organizations.partnerId, partnerId));
  const deviceIds = partnerDevices.map((device) => device.id);
  if (deviceIds.length > 0) {
    await tx.insert(deviceCommands).values(deviceIds.map((deviceId) => ({
      deviceId,
      type: 'self_uninstall' as const,
      payload: { removeConfig: true },
      status: 'pending' as const,
      targetRole: 'agent' as const,
      createdBy: callerId,
    })));
    await tx
      .update(deviceCommands)
      .set({
        status: 'cancelled',
        completedAt: new Date(),
        result: { reason: 'partner_suspended_for_abuse' },
      })
      .where(and(
        inArray(deviceCommands.deviceId, deviceIds),
        ne(deviceCommands.type, 'self_uninstall'),
        inArray(deviceCommands.status, ['pending', 'sent']),
      ));
  }

  const sessionTargets = locked.userIds.filter((id) => id !== callerId);
  if (sessionTargets.length > 0) {
    await tx.delete(sessions).where(inArray(sessions.userId, sessionTargets));
  }
  const disabled = await disablePartnerUsersForSuspension(tx, partnerId);

  let apiKeyCount = 0;
  if (locked.orgIds.length > 0) {
    const revokedKeys = await tx
      .update(apiKeys)
      .set({ status: 'revoked', updatedAt: new Date() })
      .where(and(inArray(apiKeys.orgId, locked.orgIds), ne(apiKeys.status, 'revoked')))
      .returning({ id: apiKeys.id });
    apiKeyCount = revokedKeys.length;
  }

  const affectedUserIds = locked.userRows
    .filter((user) => !(user.isPlatformAdmin && user.id === callerId))
    .map((user) => user.id);
  await invalidateLockedPartnerUsersInTransaction(
    tx,
    locked,
    'partner-suspended',
    affectedUserIds,
  );

  return {
    notFound: false as const,
    deviceCount: deviceIds.length,
    userCount: disabled.length,
    apiKeyCount,
    affectedUserIds,
  };
}
