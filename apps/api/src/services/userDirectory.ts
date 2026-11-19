/**
 * Breeze login directory reads (full-control W18, #6789): the queries behind
 * `GET /users` and `GET /users/:id`, lifted out of routes/users.ts so the
 * route and the `list_users` / `get_user` AI tools run the same code.
 *
 * The `userRoutes.use('*')` gate moves with them. A partner technician whose
 * membership is not `orgAccess: 'all'` may not enumerate the partner's users
 * on REST, so the `*ForCaller` entry points refuse them too: the tool never
 * asks for less than the route (W18 plan, Review Focus 1). The route keeps
 * calling the gate from its middleware and the ungated queries from its
 * handlers, so its request path is unchanged.
 *
 * No credential or MFA-bookkeeping column leaves this module: `passwordHash`
 * is never selected, and `annotateMfaStatus` strips `roleForceMfa`,
 * `mfaEpoch` and the grace columns after deriving `mfaStatus`.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { organizationUsers, partnerUsers, roles, userPasskeys, users } from '../db/schema';
import { combineMfaPolicyFacts, getScopeSecuritySettings, type MfaSecuritySettings } from './mfaPolicy';
import { previewMfaEnrollmentGrace, resolveMfaGraceDays } from './mfaEnrollmentGrace';
import type { ScopeContext } from './roleAssignment';

export type DirectoryRefusal = { ok: false; code: 'FORBIDDEN' | 'NOT_FOUND'; message: string };
export type DirectoryResult<T> = { ok: true; value: T } | DirectoryRefusal;

type DirectoryAuth = {
  scope: string;
  partnerId: string | null;
  orgId: string | null;
  user: { id: string };
  accessibleOrgIds?: string[] | null;
};

export const FULL_PARTNER_ACCESS_REQUIRED = 'Full partner organization access required';
export const PARTNER_CONTEXT_REQUIRED = 'Partner context required';
export const SCOPE_CONTEXT_REQUIRED = 'Partner or organization context required';

/**
 * Partner-wide user management requires a FULL-access partner membership.
 * Gate directly on partnerUsers.orgAccess === 'all' — the same field the
 * middleware uses to compute accessibleOrgIds (auth.ts). Do NOT infer this by
 * comparing accessibleOrgIds against the partner's org list: accessibleOrgIds
 * is filtered to active/trial, non-deleted orgs, so a full-access admin of a
 * partner that has any suspended/soft-deleted org (or zero orgs yet) would be
 * false-denied, while the org-list read under request RLS is itself narrowed
 * (the RLS-vacuous trap). orgAccess is the authoritative, status-independent
 * signal that distinguishes 'all' from the 'selected'/'none' escalation case.
 */
export async function hasFullPartnerMembership(auth: { user: { id: string }; partnerId: string | null }): Promise<boolean> {
  if (!auth.partnerId) return false;
  const [membership] = await db
    .select({ orgAccess: partnerUsers.orgAccess })
    .from(partnerUsers)
    .where(
      and(
        eq(partnerUsers.userId, auth.user.id),
        eq(partnerUsers.partnerId, auth.partnerId)
      )
    )
    .limit(1);

  return membership?.orgAccess === 'all';
}

/**
 * The `userRoutes.use('*')` partner gate plus `getScopeContext`, as a result
 * instead of a thrown HTTPException. Same order and messages as the route,
 * with one deliberate tightening: the router skips the membership read when
 * `accessibleOrgIds` is not an array; this gate never does, so a partner
 * token assembled without an allowlist still needs `orgAccess: 'all'`.
 */
export async function resolveUserDirectoryScope(auth: DirectoryAuth): Promise<{ ok: true; scopeContext: ScopeContext } | DirectoryRefusal> {
  if (auth.scope === 'partner') {
    if (!auth.partnerId) return { ok: false, code: 'FORBIDDEN', message: PARTNER_CONTEXT_REQUIRED };
    if (!(await hasFullPartnerMembership(auth))) {
      return { ok: false, code: 'FORBIDDEN', message: FULL_PARTNER_ACCESS_REQUIRED };
    }
    return { ok: true, scopeContext: { scope: 'partner', partnerId: auth.partnerId } };
  }
  if (auth.scope === 'organization' && auth.orgId) {
    return { ok: true, scopeContext: { scope: 'organization', orgId: auth.orgId } };
  }
  return { ok: false, code: 'FORBIDDEN', message: SCOPE_CONTEXT_REQUIRED };
}

export async function getScopedUser(userId: string, scopeContext: ScopeContext) {
  if (scopeContext.scope === 'partner') {
    const [record] = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        status: users.status,
        roleId: roles.id,
        roleName: roles.name,
        roleIsSystem: roles.isSystem,
        orgAccess: partnerUsers.orgAccess,
        orgIds: partnerUsers.orgIds
      })
      .from(partnerUsers)
      .innerJoin(users, eq(partnerUsers.userId, users.id))
      .innerJoin(roles, eq(partnerUsers.roleId, roles.id))
      .where(and(eq(partnerUsers.partnerId, scopeContext.partnerId), eq(partnerUsers.userId, userId)))
      .limit(1);

    return record || null;
  }

  const [record] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      status: users.status,
      roleId: roles.id,
      roleName: roles.name,
      roleIsSystem: roles.isSystem,
      siteIds: organizationUsers.siteIds,
      deviceGroupIds: organizationUsers.deviceGroupIds
    })
    .from(organizationUsers)
    .innerJoin(users, eq(organizationUsers.userId, users.id))
    .innerJoin(roles, eq(organizationUsers.roleId, roles.id))
    .where(and(eq(organizationUsers.orgId, scopeContext.orgId), eq(organizationUsers.userId, userId)))
    .limit(1);

  return record || null;
}

export type ScopedUserRecord = NonNullable<Awaited<ReturnType<typeof getScopedUser>>>;

/**
 * RMM-QA-166 (D11): `mfaProtected` = mfa_enabled OR a live (non-disabled)
 * user_passkeys row — the same predicate `userIsMfaProtected` applies — so the
 * operator UI can offer "Reset MFA" for a passkey-only leftover whose
 * mfa_enabled flag was already cleared. The passkey probe runs under system
 * context (user_passkeys RLS is self-or-system) but ONLY over the ids the
 * caller's own tenant-scoped membership join just returned — it never widens
 * the row set (precedent: routes/sso.ts member passkey annotation).
 */
async function annotateMfaProtected<T extends { id: string; mfaEnabled: boolean }>(
  rows: T[]
): Promise<Array<T & { mfaProtected: boolean }>> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const passkeyRows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ userId: userPasskeys.userId })
        .from(userPasskeys)
        .where(and(inArray(userPasskeys.userId, ids), isNull(userPasskeys.disabledAt)))
    )
  );
  const withPasskey = new Set(passkeyRows.map((row) => row.userId));
  return rows.map((row) => ({ ...row, mfaProtected: row.mfaEnabled === true || withPasskey.has(row.id) }));
}

/** One of these per row on the Admin → Users list MFA status column (#5690). */
export type MfaStatusColumn = 'enrolled' | 'pending' | 'overdue' | 'not_required';

/**
 * #5690 — derives the Admin → Users list MFA status column from facts already
 * in hand: `mfaProtected` (from `annotateMfaProtected`, above) plus each row's
 * `roleForceMfa`, `mfaEpoch` and persisted grace columns. One settings read
 * for the whole scope (`getScopeSecuritySettings`), not one per row, and
 * `previewMfaEnrollmentGrace` (read-only — never grants) rather than
 * `evaluateMfaEnrollmentGrace`, because a GET must not have the side effect of
 * granting enrolment windows to every role-forced user it lists.
 *
 * Reuses `combineMfaPolicyFacts` — the same rule `getEffectiveMfaPolicy`
 * applies at login/middleware — so this column can never disagree with live
 * enforcement about whether a user is actually gated right now.
 */
function annotateMfaStatus<
  T extends {
    id: string;
    mfaEnabled: boolean;
    mfaProtected: boolean;
    roleForceMfa: boolean;
    mfaEpoch: number;
    mfaEnrollmentDeadline: Date | string | null;
    mfaEnrollmentGraceGrantedAt: Date | string | null;
  }
>(rows: T[], security: MfaSecuritySettings | undefined): Array<
  Omit<T, 'roleForceMfa' | 'mfaEpoch' | 'mfaEnrollmentDeadline' | 'mfaEnrollmentGraceGrantedAt'> & {
    mfaStatus: MfaStatusColumn;
    mfaEnrollmentDeadline: string | null;
  }
> {
  const graceDays = resolveMfaGraceDays(security);
  const now = new Date();
  return rows.map((row) => {
    const { roleForceMfa, mfaEpoch, mfaEnrollmentDeadline, mfaEnrollmentGraceGrantedAt, ...rest } = row;
    const toDate = (v: Date | string | null) => (v == null ? null : v instanceof Date ? v : new Date(v));
    const grace = previewMfaEnrollmentGrace({
      hasFactor: row.mfaProtected,
      mfaEpoch,
      deadline: toDate(mfaEnrollmentDeadline),
      grantedAt: toDate(mfaEnrollmentGraceGrantedAt),
      graceDays,
      now,
    });
    const policy = combineMfaPolicyFacts({ roleForceMfa, security, grace });

    // NOTE: during an active grace window `combineMfaPolicyFacts` intentionally
    // reports `required: false` (that's what keeps the live enforcement gate
    // from biting) — so `graceWindow === 'active'` must be checked BEFORE
    // `required`, not after, or a pending user would misreport as
    // `not_required`.
    let mfaStatus: MfaStatusColumn;
    if (row.mfaProtected) {
      mfaStatus = 'enrolled';
    } else if (policy.source.graceWindow === 'active') {
      mfaStatus = 'pending';
    } else if (!policy.required) {
      mfaStatus = 'not_required';
    } else {
      mfaStatus = 'overdue';
    }

    return {
      ...rest,
      mfaStatus,
      mfaEnrollmentDeadline: mfaStatus === 'pending' ? (policy.pendingEnrollment?.deadline ?? null) : null,
    };
  });
}

/** The `GET /users` list for an already-gated scope. */
export async function listScopedUsers(scopeContext: ScopeContext) {
  if (scopeContext.scope === 'partner') {
    const data = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        status: users.status,
        lastLoginAt: users.lastLoginAt,
        mfaEnabled: users.mfaEnabled,
        mfaEpoch: users.mfaEpoch,
        mfaEnrollmentDeadline: users.mfaEnrollmentDeadline,
        mfaEnrollmentGraceGrantedAt: users.mfaEnrollmentGraceGrantedAt,
        roleId: roles.id,
        roleName: roles.name,
        roleForceMfa: roles.forceMfa,
        orgAccess: partnerUsers.orgAccess,
        orgIds: partnerUsers.orgIds
      })
      .from(partnerUsers)
      .innerJoin(users, eq(partnerUsers.userId, users.id))
      .innerJoin(roles, eq(partnerUsers.roleId, roles.id))
      .where(eq(partnerUsers.partnerId, scopeContext.partnerId));

    const withProtected = await annotateMfaProtected(data);
    const security = await getScopeSecuritySettings({
      scope: 'partner',
      partnerId: scopeContext.partnerId,
      orgId: null,
    });
    return annotateMfaStatus(withProtected, security);
  }

  const data = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      status: users.status,
      lastLoginAt: users.lastLoginAt,
      mfaEnabled: users.mfaEnabled,
      mfaEpoch: users.mfaEpoch,
      mfaEnrollmentDeadline: users.mfaEnrollmentDeadline,
      mfaEnrollmentGraceGrantedAt: users.mfaEnrollmentGraceGrantedAt,
      roleId: roles.id,
      roleName: roles.name,
      roleForceMfa: roles.forceMfa,
      siteIds: organizationUsers.siteIds,
      deviceGroupIds: organizationUsers.deviceGroupIds
    })
    .from(organizationUsers)
    .innerJoin(users, eq(organizationUsers.userId, users.id))
    .innerJoin(roles, eq(organizationUsers.roleId, roles.id))
    .where(eq(organizationUsers.orgId, scopeContext.orgId));

  const withProtected = await annotateMfaProtected(data);
  const security = await getScopeSecuritySettings({
    scope: 'organization',
    orgId: scopeContext.orgId,
    partnerId: null,
  });
  return annotateMfaStatus(withProtected, security);
}

export type ScopedUserRow = Awaited<ReturnType<typeof listScopedUsers>>[number];

/** `GET /users` with the router gate applied: the AI tool's entry point. */
export async function listScopedUsersForCaller(auth: DirectoryAuth): Promise<DirectoryResult<ScopedUserRow[]>> {
  const scope = await resolveUserDirectoryScope(auth);
  if (!scope.ok) return scope;
  return { ok: true, value: await listScopedUsers(scope.scopeContext) };
}

/** `GET /users/:id` with the router gate applied: the AI tool's entry point. */
export async function getScopedUserForCaller(auth: DirectoryAuth, userId: string): Promise<DirectoryResult<ScopedUserRecord>> {
  const scope = await resolveUserDirectoryScope(auth);
  if (!scope.ok) return scope;
  const record = await getScopedUser(userId, scope.scopeContext);
  return record ? { ok: true, value: record } : { ok: false, code: 'NOT_FOUND', message: 'User not found' };
}
