import { and, eq, isNull } from 'drizzle-orm';
import { organizationUsers, organizations, partnerUsers, users } from '../db/schema';
import type { AuthLifecycleTransaction } from './authLifecycle';

export interface OrganizationLifecycleActor {
  scope: 'organization' | 'partner' | 'system';
  userId: string;
  partnerId: string | null;
  orgId: string | null;
}

export type PartnerWideLifecycleActor = OrganizationLifecycleActor;

/**
 * Re-resolve authority for a partner-wide lifecycle operation under the same
 * true system transaction that performs the privileged write. A selected
 * organization list is never equivalent to full-partner authority, even when
 * request RLS happens to expose every row the caller can currently see.
 */
export async function authorizePartnerWideLifecycleWrite(
  tx: AuthLifecycleTransaction,
  actor: PartnerWideLifecycleActor,
): Promise<boolean> {
  if (actor.scope === 'partner') {
    if (!actor.partnerId || actor.orgId !== null) return false;

    const [membership] = await tx
      .select({ id: partnerUsers.id, orgAccess: partnerUsers.orgAccess })
      .from(partnerUsers)
      .where(and(
        eq(partnerUsers.userId, actor.userId),
        eq(partnerUsers.partnerId, actor.partnerId),
        eq(partnerUsers.orgAccess, 'all'),
      ))
      .limit(1);

    return membership?.orgAccess === 'all';
  }

  if (actor.scope !== 'system' || actor.partnerId !== null || actor.orgId !== null) {
    return false;
  }

  const [platformAdmin] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(
      eq(users.id, actor.userId),
      eq(users.isPlatformAdmin, true),
      eq(users.status, 'active'),
    ))
    .limit(1);

  return Boolean(platformAdmin);
}

export type OrganizationLifecycleAuthorization =
  | { authorized: false }
  | { authorized: true; targetPartnerId: string };

/**
 * Re-resolve an organization lifecycle actor inside the same system transaction
 * that performs the write. Request-time authorization is not enough here: a
 * membership or org allowlist can change before the ambient tenant context is
 * dropped for the system transaction.
 */
export async function authorizeOrganizationLifecycleWrite(
  tx: AuthLifecycleTransaction,
  actor: OrganizationLifecycleActor,
  organizationId: string,
): Promise<OrganizationLifecycleAuthorization> {
  const [target] = await tx
    .select({ id: organizations.id, partnerId: organizations.partnerId })
    .from(organizations)
    .where(and(eq(organizations.id, organizationId), isNull(organizations.deletedAt)))
    .limit(1);

  if (!target) return { authorized: false };

  if (actor.scope === 'organization') {
    if (actor.orgId !== target.id || actor.partnerId !== target.partnerId) {
      return { authorized: false };
    }

    const [membership] = await tx
      .select({ id: organizationUsers.id })
      .from(organizationUsers)
      .where(and(
        eq(organizationUsers.userId, actor.userId),
        eq(organizationUsers.orgId, target.id),
      ))
      .limit(1);

    return membership
      ? { authorized: true, targetPartnerId: target.partnerId }
      : { authorized: false };
  }

  if (actor.scope === 'partner') {
    if (actor.orgId !== null || actor.partnerId !== target.partnerId) {
      return { authorized: false };
    }

    const [membership] = await tx
      .select({
        id: partnerUsers.id,
        orgAccess: partnerUsers.orgAccess,
        orgIds: partnerUsers.orgIds,
      })
      .from(partnerUsers)
      .where(and(
        eq(partnerUsers.userId, actor.userId),
        eq(partnerUsers.partnerId, target.partnerId),
      ))
      .limit(1);

    const hasAccess = membership?.orgAccess === 'all'
      || (membership?.orgAccess === 'selected' && membership.orgIds?.includes(target.id));

    return hasAccess
      ? { authorized: true, targetPartnerId: target.partnerId }
      : { authorized: false };
  }

  if (actor.partnerId !== null || actor.orgId !== null) {
    return { authorized: false };
  }

  const [platformAdmin] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(
      eq(users.id, actor.userId),
      eq(users.isPlatformAdmin, true),
      eq(users.status, 'active'),
    ))
    .limit(1);

  return platformAdmin
    ? { authorized: true, targetPartnerId: target.partnerId }
    : { authorized: false };
}

export function organizationLifecycleWriteCondition(
  organizationId: string,
  targetPartnerId: string,
) {
  return and(
    eq(organizations.id, organizationId),
    eq(organizations.partnerId, targetPartnerId),
    isNull(organizations.deletedAt),
  );
}
