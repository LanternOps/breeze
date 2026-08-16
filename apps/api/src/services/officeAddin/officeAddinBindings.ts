import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { officeAddinUserBindings } from '../../db/schema/officeAddin';
import { users } from '../../db/schema/users';

/**
 * Entra identity → Breeze technician binding lookups for the Office add-in
 * neutral auth exchange (Task 10, spec §2.2 / §9). Tenancy: shape 3
 * partner-axis (no org_id on office_addin_user_bindings), so no cascade/export
 * registration applies here.
 *
 * These run under the CALLER's db access context (system, per the route) —
 * no context wrapping inside, so they compose cleanly inside a caller-owned
 * `withSystemDbAccessContext` block.
 */

export type BindingWithUser = {
  binding: {
    id: string;
    userId: string;
    partnerId: string;
    boundAuthEpoch: number;
    mfaVerifiedAt: Date;
  };
  user: {
    id: string;
    email: string;
    name: string;
    status: string;
    authEpoch: number;
    partnerId: string;
  };
};

/** Active (non-revoked) binding for an Entra identity, joined to its Breeze user. */
export async function findActiveBinding(
  entraTenantId: string,
  entraOid: string
): Promise<BindingWithUser | null> {
  const [row] = await db
    .select({
      bindingId: officeAddinUserBindings.id,
      bindingUserId: officeAddinUserBindings.userId,
      bindingPartnerId: officeAddinUserBindings.partnerId,
      boundAuthEpoch: officeAddinUserBindings.boundAuthEpoch,
      mfaVerifiedAt: officeAddinUserBindings.mfaVerifiedAt,
      userId: users.id,
      userEmail: users.email,
      userName: users.name,
      userStatus: users.status,
      userAuthEpoch: users.authEpoch,
      userPartnerId: users.partnerId,
    })
    .from(officeAddinUserBindings)
    .innerJoin(users, eq(users.id, officeAddinUserBindings.userId))
    .where(
      and(
        eq(officeAddinUserBindings.entraTenantId, entraTenantId),
        eq(officeAddinUserBindings.entraOid, entraOid),
        isNull(officeAddinUserBindings.revokedAt)
      )
    )
    .limit(1);

  if (!row) return null;

  return {
    binding: {
      id: row.bindingId,
      userId: row.bindingUserId,
      partnerId: row.bindingPartnerId,
      boundAuthEpoch: row.boundAuthEpoch,
      mfaVerifiedAt: row.mfaVerifiedAt,
    },
    user: {
      id: row.userId,
      email: row.userEmail,
      name: row.userName,
      status: row.userStatus,
      authEpoch: row.userAuthEpoch,
      partnerId: row.userPartnerId,
    },
  };
}

/**
 * Whether ANY binding row exists for this identity, active or revoked. Used
 * to hard-deny (`revoked_relink`) instead of falling through to client JIT
 * provisioning — a former technician's identity must never JIT-provision as
 * a client portal user.
 */
export async function hasAnyBinding(entraTenantId: string, entraOid: string): Promise<boolean> {
  const [row] = await db
    .select({ id: officeAddinUserBindings.id })
    .from(officeAddinUserBindings)
    .where(
      and(
        eq(officeAddinUserBindings.entraTenantId, entraTenantId),
        eq(officeAddinUserBindings.entraOid, entraOid)
      )
    )
    .limit(1);
  return !!row;
}

export async function revokeBinding(bindingId: string, revokedBy: string | null): Promise<void> {
  await db
    .update(officeAddinUserBindings)
    .set({ revokedAt: new Date(), revokedBy })
    .where(eq(officeAddinUserBindings.id, bindingId));
}
