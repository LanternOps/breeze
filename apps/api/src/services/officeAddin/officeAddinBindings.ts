import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { officeAddinUserBindings } from '../../db/schema/officeAddin';
import { users } from '../../db/schema/users';
import { isPgUniqueViolation } from '../../utils/pgErrors';

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
 * Active (non-revoked) binding by its id, joined to its Breeze user — the
 * per-request re-authorization read for `officeAddinTechAuthMiddleware`.
 *
 * The join is INNER because `office_addin_user_bindings.user_id` is a NOT NULL
 * FK to `users`: a missing user row is impossible, so a null result here always
 * means "binding missing or revoked", which the middleware treats as the
 * harsher deny (it also deletes the Redis session).
 */
export async function findActiveBindingById(bindingId: string): Promise<BindingWithUser | null> {
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
      and(eq(officeAddinUserBindings.id, bindingId), isNull(officeAddinUserBindings.revokedAt))
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

/** Candidate user row for the bind flow's credential check. */
export type BindCandidateUser = {
  id: string;
  email: string;
  name: string;
  status: string;
  partnerId: string | null;
  passwordHash: string | null;
  mfaEnabled: boolean;
  mfaSecret: string | null;
  authEpoch: number;
};

/**
 * Look up a user by login email for the bind flow (Task 11). Mirrors
 * `routes/auth/login.ts`'s case-insensitive lookup (`email.toLowerCase()`) —
 * this email is a login credential only, never the authorization identifier
 * (that's the Entra (tid, oid) pair stored on the binding row).
 */
export async function findUserForBind(email: string): Promise<BindCandidateUser | null> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      status: users.status,
      partnerId: users.partnerId,
      passwordHash: users.passwordHash,
      mfaEnabled: users.mfaEnabled,
      mfaSecret: users.mfaSecret,
      authEpoch: users.authEpoch,
    })
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  return row ?? null;
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

/**
 * Thrown by {@link createBinding} when the (entraTenantId, entraOid) identity
 * is already actively bound to a DIFFERENT Breeze user — the partial unique
 * index `office_addin_bindings_identity_active_uq` raised a 23505. The route
 * maps this to 409 `identity_already_bound`.
 */
export class BindingConflictError extends Error {
  constructor() {
    super('office add-in identity already actively bound to a different user');
    this.name = 'BindingConflictError';
  }
}

/**
 * Create (or re-link) the technician binding for an Entra identity, per the
 * bind flow (Task 11, spec §2.2/§9). Email is only the login credential used
 * to authenticate this request — the durable authorization key is the Entra
 * (tid, oid) pair stored on the row.
 *
 * Re-link case: `office_addin_bindings_user_active_uq` allows at most one
 * active binding per user, so re-binding (e.g. a new Entra tenant) must first
 * revoke the SAME user's existing active binding inside the same transaction
 * before inserting the new one. A 23505 on the IDENTITY index instead means
 * the (tid, oid) is bound to a DIFFERENT user, which is a real conflict, not
 * a re-link — surfaced as {@link BindingConflictError}.
 */
export async function createBinding(input: {
  entraTenantId: string;
  entraOid: string;
  userId: string;
  partnerId: string;
  boundAuthEpoch: number;
  mfaVerifiedAt: Date;
}): Promise<{ id: string }> {
  try {
    return await db.transaction(async (tx) => {
      await tx
        .update(officeAddinUserBindings)
        .set({ revokedAt: new Date(), revokedBy: input.userId })
        .where(
          and(eq(officeAddinUserBindings.userId, input.userId), isNull(officeAddinUserBindings.revokedAt))
        );

      const [row] = await tx
        .insert(officeAddinUserBindings)
        .values({
          entraTenantId: input.entraTenantId,
          entraOid: input.entraOid,
          userId: input.userId,
          partnerId: input.partnerId,
          boundAuthEpoch: input.boundAuthEpoch,
          mfaVerifiedAt: input.mfaVerifiedAt,
        })
        .returning({ id: officeAddinUserBindings.id });

      if (!row) {
        throw new Error('office_addin_user_bindings insert returned no row');
      }

      return { id: row.id };
    });
  } catch (err) {
    if (isPgUniqueViolation(err, 'office_addin_bindings_identity_active_uq')) {
      throw new BindingConflictError();
    }
    throw err;
  }
}
