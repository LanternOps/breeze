import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { users, partners, organizations } from '../db/schema';
import { isPasswordAuthDisabledBySso } from '../routes/auth/ssoPolicy';

export type ResetIneligibleReason =
  | 'unknown_user'
  | 'user_disabled'
  | 'tenant_inactive'
  | 'sso_required';

export interface ResetEligibility {
  allowed: boolean;
  reason?: ResetIneligibleReason;
  userId?: string;
  email?: string;
  /**
   * Server-side-only diagnostic detail for the blocking condition (#719
   * residual 1). For a `tenant_inactive` denial this is the SPECIFIC tenant
   * status that blocked the reset — `partner:suspended`, `partner:churned`,
   * `partner:missing`, `org:suspended`, `org:churned`, `org:missing` — so an
   * operator reading the audit trail can tell a benign self-service `pending`
   * signup (now ALLOWED) apart from a deliberate `suspended`/`churned` cutoff,
   * and so the observability signal can be sliced by status.
   *
   * MUST NOT be surfaced in any HTTP response body — doing so would turn the
   * reset flow into an account-enumeration / tenant-status oracle. Callers use
   * it for audit logging and anomaly metrics only.
   */
  detail?: string;
}

interface UserLookupRow {
  id: string;
  email: string;
  status: string;
  partnerId: string | null;
  orgId: string | null;
}

// Partner statuses that PERMIT password reset. `pending` is explicitly in
// scope: a partner whose email is verified but whose payment hasn't yet
// activated must be able to reset (closes #719). `suspended` / `churned` /
// soft-deleted must NOT — those are abuse-response or end-of-lifecycle
// states where giving an attacker a path back to the account would defeat
// the suspension. This mirrors `getSessionAllowedPartner` in
// `tenantStatus.ts`, which admits the same set for the login session gate.
const RESET_ALLOWED_PARTNER_STATUSES = new Set<string>(['active', 'pending']);

// User row statuses that block password reset. Locked-out accounts shouldn't
// be reactivated via the public reset flow — an admin must restore them.
const RESET_BLOCKED_USER_STATUSES = new Set<string>(['disabled']);

// Organization statuses that block password reset for org-scoped users.
const RESET_BLOCKED_ORG_STATUSES = new Set<string>(['suspended', 'churned']);

/**
 * Single source of truth for "can this email reset its password right now?".
 *
 * Used by both `/auth/forgot-password` (issue reset token + send email) and
 * `/auth/reset-password` (consume token + change password) so the two phases
 * can't drift to allow only one. Centralizing the policy also prevents a new
 * tenant status from being added in one path but forgotten in the other.
 *
 * The shape is the same on every branch — callers must not leak the reason
 * to the HTTP response (use it for audit logging and the email-send decision
 * only). All public responses stay a generic 200 to defeat email-enumeration.
 *
 * Note on timing: every branch performs roughly the same number of DB queries
 * (user lookup, optional partner lookup, optional org/SSO lookup), so
 * partner-status does not introduce a per-status timing side-channel
 * meaningful to a network attacker. (Addresses MED-1 from the earlier audit.)
 */
export async function getPasswordResetEligibility(email: string): Promise<ResetEligibility> {
  const normalized = email.toLowerCase().trim();
  if (!normalized) return { allowed: false, reason: 'unknown_user' };

  return withSystemDbAccessContext(async () => {
    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        status: users.status,
        partnerId: users.partnerId,
        orgId: users.orgId,
      })
      .from(users)
      .where(eq(users.email, normalized))
      .limit(1);

    if (!user) return { allowed: false, reason: 'unknown_user' };

    return evaluateEligibility(user as UserLookupRow);
  });
}

/**
 * Same policy as `getPasswordResetEligibility`, keyed by userId for the
 * `/reset-password` consumption path (where we've already resolved the user
 * from the reset token). Re-evaluates so a partner suspended between issuing
 * the token and the user clicking the link can't slip a reset through.
 */
export async function getPasswordResetEligibilityForUser(userId: string): Promise<ResetEligibility> {
  return withSystemDbAccessContext(async () => {
    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        status: users.status,
        partnerId: users.partnerId,
        orgId: users.orgId,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) return { allowed: false, reason: 'unknown_user' };

    return evaluateEligibility(user as UserLookupRow);
  });
}

async function evaluateEligibility(user: UserLookupRow): Promise<ResetEligibility> {
  if (RESET_BLOCKED_USER_STATUSES.has(user.status)) {
    return { allowed: false, reason: 'user_disabled', userId: user.id, email: user.email };
  }

  if (user.partnerId) {
    const [partner] = await db
      .select({ status: partners.status, deletedAt: partners.deletedAt })
      .from(partners)
      .where(eq(partners.id, user.partnerId))
      .limit(1);

    if (!partner || partner.deletedAt || !RESET_ALLOWED_PARTNER_STATUSES.has(partner.status as string)) {
      // `detail` records the specific blocking status for the audit trail /
      // anomaly metric (#719 residual 1). Soft-deleted and not-found both map
      // to `missing` so a purged-vs-soft-deleted partner can't be told apart.
      const detail = !partner || partner.deletedAt
        ? 'partner:missing'
        : `partner:${partner.status}`;
      return { allowed: false, reason: 'tenant_inactive', detail, userId: user.id, email: user.email };
    }
  }

  if (user.orgId) {
    const [org] = await db
      .select({ status: organizations.status, deletedAt: organizations.deletedAt })
      .from(organizations)
      .where(eq(organizations.id, user.orgId))
      .limit(1);

    if (!org || org.deletedAt || RESET_BLOCKED_ORG_STATUSES.has(org.status as string)) {
      const detail = !org || org.deletedAt
        ? 'org:missing'
        : `org:${org.status}`;
      return { allowed: false, reason: 'tenant_inactive', detail, userId: user.id, email: user.email };
    }
  }

  // SSO check: defer to the existing helper so password reset and login share
  // one definition of "SSO is mandatory for this org". `isPasswordAuthDisabledBySso`
  // only flags `scope='organization'` users whose org has an active enforced
  // provider — partner-scope users are never SSO-gated here.
  if (user.orgId) {
    const ssoBlocked = await isPasswordAuthDisabledBySso({
      scope: 'organization',
      orgId: user.orgId,
      partnerId: null,
    });
    if (ssoBlocked) {
      return { allowed: false, reason: 'sso_required', userId: user.id, email: user.email };
    }
  }

  return { allowed: true, userId: user.id, email: user.email };
}
