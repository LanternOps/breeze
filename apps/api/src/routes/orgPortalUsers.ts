import type { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../lib/validation';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, withDbTransaction } from '../db';
import { organizations, partners, portalUsers, tickets, ticketComments, assetCheckouts } from '../db/schema';
import { linkLoginToContact, type LoginContactOutcome } from '../services/contacts/loginLink';
import { requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { getEmailService } from '../services/email';
import { partnerEmailCustomFromSettings, type PartnerEmailCustom } from '../services/emailTemplates/renderPartnerEmail';
import { getRedis } from '../services/redis';
import { purgeClientAiSessionsForUsers } from '../services/clientAiSessionStore';
import { buildPortalUrl, purgePortalSessionsForUsers } from './portal/helpers';
import { issuePortalCapabilityToken } from './portal/capabilityTokens';
import {
  PORTAL_ACCOUNT_TRANSITION_REFUSED,
  PortalAccountTransitionError,
  initialPortalAccountState,
  isBulkInviteEligible,
  planPortalAccountTransition,
  type PortalAccountFacts,
  type PortalAccountTarget,
  type PortalAccountWriter,
} from '../services/portalAccountState';
import {
  invitePortalUserSchema,
  bulkInvitePortalUsersSchema,
  updatePortalUserSchema,
  inviteContactsToPortalSchema,
  CONTACT_PORTAL_INVITE_OUTCOMES,
  PORTAL_INVITE_ERROR_CODES,
  type AlreadyHasAccessReason,
  type ContactPortalInviteOutcome,
  type ContactPortalInviteResult,
  type PortalInviteErrorCode,
} from '@breeze/shared';
import { listPortalUsersForOrg } from '../services/portalUserDirectory';
import { portalUserHasIdentitySql } from '../services/portalUserIdentities';
import { isSsoOnlyStranded, resolveInviteSignInMethods } from '../services/portalSsoOnly';
import { normalizeContactEmail } from '../services/contacts/crud';
import {
  bindContactLoginForInvite,
  loadOrgContactsForPortalInvite,
  lockPortalInviteAddresses,
  ContactGoneError,
  ContactEmailChangedError,
  PortalLoginChangedError,
  inviteRefusalReason,
  portalLoginEmailEquals,
  type ContactInviteDecision,
  type InviteableContact,
} from '../services/contacts/portalInvite';
import { canReachContactSite } from './orgContacts';

// MSP-facing customer-portal user management (portal_users): list, invite,
// patch (disable/reactivate), resend-invite, bulk-invite, and delete.
// Mirrors routes/orgPortalSettings.ts for gating: partner|system scope,
// ORGS_READ/ORGS_WRITE permission, requireMfa() on the write, and a
// module-local resolveAccessibleOrg (duplicated rather than shared, per
// the pattern established there).

// The list read (and `effectivePortalStatus`) moved to
// services/portalUserDirectory.ts, shared with the list_portal_users AI tool
// (full-control W18, #6789). Re-exported for existing importers.
export { effectivePortalStatus } from '../services/portalUserDirectory';

async function resolveAccessibleOrg(c: any): Promise<{ id: string } | Response> {
  const auth = c.get('auth') as AuthContext;
  const id = c.req.param('id')!;
  if (auth.scope === 'partner' && !auth.canAccessOrg(id)) {
    return c.json({ error: 'Organization not found' }, 404);
  }
  const rows = await db.select({ id: organizations.id }).from(organizations)
    .where(and(eq(organizations.id, id), isNull(organizations.deletedAt))).limit(1);
  if (!rows[0]) return c.json({ error: 'Organization not found' }, 404);
  return { id };
}

async function getOrgScopedPortalUser(orgId: string, userId: string) {
  const [row] = await db.select({ id: portalUsers.id, orgId: portalUsers.orgId, email: portalUsers.email, name: portalUsers.name, passwordHash: portalUsers.passwordHash, authMethod: portalUsers.authMethod, status: portalUsers.status, authEpoch: portalUsers.authEpoch, browserAccess: portalUsers.browserAccess, hasExternalIdentity: portalUserHasIdentitySql() })
    .from(portalUsers).where(and(eq(portalUsers.id, userId), eq(portalUsers.orgId, orgId))).limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Account state (portal registration W2): every status / browser_access write
// in this file is a target computed by services/portalAccountState.ts, applied
// with an `auth_epoch = <the epoch we read>` guard. Every transition that
// changes the row's state bumps the epoch, so a concurrent disable, re-invite,
// accept or password change makes a stale plan match zero rows instead of
// overwriting the newer state.
// ---------------------------------------------------------------------------

type AccountRow = { status: string; browserAccess: string; authMethod: string; passwordHash: string | null; hasExternalIdentity: boolean };

function accountFacts(row: AccountRow): PortalAccountFacts {
  return {
    status: row.status,
    browserAccess: row.browserAccess,
    authMethod: row.authMethod,
    hasPasswordHash: Boolean(row.passwordHash),
    // Identities release B (W3): EXISTS over portal_user_identities, selected
    // with portalUserHasIdentitySql() by every reader in this file.
    hasExternalIdentity: row.hasExternalIdentity,
  };
}

/** The target, or a refusal response carrying the transition's message and code. */
function planOrRefuse(c: any, row: AccountRow, writer: PortalAccountWriter): PortalAccountTarget | Response {
  try {
    return planPortalAccountTransition(accountFacts(row), writer);
  } catch (error) {
    if (error instanceof PortalAccountTransitionError) {
      return c.json({ error: error.message, code: error.code }, error.httpStatus);
    }
    throw error;
  }
}

function stateSet(target: PortalAccountTarget) {
  return {
    status: target.status,
    browserAccess: target.browserAccess,
    ...(target.bumpEpoch ? { authEpoch: sql`${portalUsers.authEpoch} + 1` } : {}),
  };
}

/** The epoch guard matched nothing: the row changed between our read and our write. */
function concurrentChange(c: any): Response {
  return c.json({ error: 'This portal user changed while the request was in progress. Reload and try again.', code: PORTAL_ACCOUNT_TRANSITION_REFUSED }, 409);
}

async function hasPortalUserReferences(userId: string): Promise<boolean> {
  const [t] = await db.select({ id: tickets.id }).from(tickets).where(eq(tickets.submittedBy, userId)).limit(1);
  if (t) return true;
  const [cm] = await db.select({ id: ticketComments.id }).from(ticketComments).where(eq(ticketComments.portalUserId, userId)).limit(1);
  if (cm) return true;
  const [ck] = await db.select({ id: assetCheckouts.id }).from(assetCheckouts).where(eq(assetCheckouts.checkedOutTo, userId)).limit(1);
  return Boolean(ck);
}

/**
 * Issue a purpose-bound invite token (bound to the org, the address and the
 * row's CURRENT auth_epoch — pass the epoch the write returned) and email it.
 *
 * The email offers what the org's effective policy allows (W4 #11381, spec
 * §5.5): "Sign in with Microsoft" (the same invite link with
 * `&method=microsoft`) when Microsoft is effective, and a password only while
 * password sign-in is allowed. A policy read that fails sends nothing (false),
 * like a missing token store: never an invite offering the wrong methods. The
 * read runs in its own savepoint, so catching it leaves the request usable.
 */
export async function issueAndSendInvite(c: any, orgId: string, user: { id: string; email: string; authEpoch: number }, orgName: string | null, inviterName: string | null | undefined, message?: string): Promise<boolean> {
  let methods: { microsoft: boolean; password: boolean };
  try {
    methods = await resolveInviteSignInMethods(orgId);
  } catch (err) {
    console.warn(`[orgPortalUsers] invite not sent (sign-in policy unavailable) portalUserId=${user.id} orgId=${orgId}:`, err instanceof Error ? err.message : err);
    return false;
  }
  const rawToken = await issuePortalCapabilityToken({ purpose: 'invite', portalUserId: user.id, orgId, email: user.email, authEpoch: user.authEpoch });
  if (!rawToken) {
    // redis unavailable — do not email a dead invite link
    console.warn(`[orgPortalUsers] invite not sent (no invite token store) portalUserId=${user.id} orgId=${orgId}`);
    return false;
  }
  const inviteUrl = buildPortalUrl(`/accept-invite?token=${encodeURIComponent(rawToken)}`);
  const emailService = getEmailService();
  if (!emailService) {
    console.warn(`[orgPortalUsers] invite not sent (no email service configured) portalUserId=${user.id} orgId=${orgId}`);
    return false;
  }
  // Partner from the VERIFIED auth context, never request input (spec §8.1).
  // These routes are requireScope('partner', 'system'); a system-scope caller
  // has partnerId === null, which resolves to the platform sender.
  const partnerId = (c.get('auth') as AuthContext | undefined)?.partnerId ?? null;
  let partnerName: string | undefined;
  let custom: PartnerEmailCustom | null = null;
  try {
    // Savepoint so a failed branding read rolls back and the request transaction survives (#11203).
    await withDbTransaction(async () => {
      const orgRows = await db.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
      const orgRow = Array.isArray(orgRows) ? orgRows[0] : undefined;
      if (orgRow?.partnerId) {
        const partnerRows = await db.select({ name: partners.name, settings: partners.settings }).from(partners).where(eq(partners.id, orgRow.partnerId)).limit(1);
        const partner = Array.isArray(partnerRows) ? partnerRows[0] : undefined;
        partnerName = partner?.name ?? undefined;
        custom = partnerEmailCustomFromSettings(partner?.settings, 'portal_invite');
      }
    });
  } catch {
    custom = null;
  }
  try {
    await emailService.sendPortalInvite({
      to: user.email,
      inviteUrl,
      microsoftUrl: methods.microsoft ? `${inviteUrl}&method=microsoft` : undefined,
      passwordAllowed: methods.password,
      orgName: orgName ?? undefined,
      inviterName: inviterName ?? undefined,
      message,
      partnerId,
      partnerName,
      custom,
    });
    return true;
  } catch (err) {
    console.error('[orgPortalUsers] invite email failed:', err);
    return false;
  }
}

/**
 * How an invite resolved to the org's contact for that address (#3258 W03).
 *
 * Recorded in the invite's audit details AND returned in the response body,
 * because a null `contact_id` is not self-explaining after the fact:
 * 'ambiguous' means we declined to guess (and the new login will not see that
 * address's emailed tickets), 'kept' means we deliberately did not touch a
 * link that was already there.
 *
 * `kept` is the one outcome the shared resolver cannot produce, because it is
 * decided BEFORE the resolver is consulted: an existing link is never
 * re-derived, so there is nothing to resolve.
 */
type InviteContactLink = LoginContactOutcome | 'kept' | 'direct';

// ── Invite from contacts (portal registration W1, #11378) ───────────────────
// `direct` is the contactId path: the MSP named the contact, so nothing was
// resolved from the address.

const CODES = PORTAL_INVITE_ERROR_CODES;
const MSG_CONTACT_NOT_FOUND = 'Contact not found';
const MSG_EXTERNAL_IDENTITY = 'This identity is managed by an external sign-in provider.';
const MSG_USER_DISABLED = 'This user is disabled. Reactivate them before inviting.';
const MSG_ALREADY_ACTIVE = 'This email already has an active portal account.';
const MSG_EMAIL_MISMATCH = "The invite email must match the contact's email.";

function contactNotFound(c: any): Response {
  // Missing, another org's, and pinned to a site the caller cannot reach are
  // one body: the response is never an existence oracle.
  return c.json({ error: MSG_CONTACT_NOT_FOUND, code: CODES.PORTAL_INVITE_CONTACT_NOT_FOUND }, 404);
}

type InviteRefusal = { code: PortalInviteErrorCode; error: string };

// A Record, not a switch: a new reason fails the build until it has a code.
const REFUSAL_BY_REASON: Record<AlreadyHasAccessReason, InviteRefusal> = {
  active: { code: CODES.PORTAL_INVITE_ALREADY_ACTIVE, error: MSG_ALREADY_ACTIVE },
  disabled: { code: CODES.PORTAL_INVITE_USER_DISABLED, error: MSG_USER_DISABLED },
  external_identity: { code: CODES.PORTAL_INVITE_EXTERNAL_IDENTITY, error: MSG_EXTERNAL_IDENTITY },
  login_email_differs: {
    code: CODES.PORTAL_INVITE_LOGIN_EMAIL_DIFFERS,
    error: "This contact's portal login uses a different email than the contact. Update or remove that login first.",
  },
};

/** The 409 body for a refused contact invite. */
function inviteDecisionRefusal(decision: Exclude<ContactInviteDecision, { kind: 'invite' }>): InviteRefusal {
  if (decision.kind === 'email_bound_to_other_contact') {
    return {
      code: CODES.PORTAL_INVITE_CONTACT_CONFLICT,
      error: 'This email already has a portal login bound to a different contact. Unbind it first.',
    };
  }
  return REFUSAL_BY_REASON[decision.reason];
}

/**
 * `msp_invite` through the state module for the address (no-`contactId`)
 * invite. The invite route keeps W1's stable PORTAL_INVITE_* codes (#11378) on
 * the module's refusals, as the contact path does; a fail-closed refusal
 * (unknown stored state) keeps the module's own code.
 */
function planInviteOrRefuse(c: any, row: AccountRow): PortalAccountTarget | Response {
  try {
    return planPortalAccountTransition(accountFacts(row), 'msp_invite');
  } catch (error) {
    if (!(error instanceof PortalAccountTransitionError)) throw error;
    const reason = inviteRefusalReason(error);
    if (reason) return c.json(REFUSAL_BY_REASON[reason], 409);
    return c.json({ error: error.message, code: error.code }, error.httpStatus);
  }
}

/**
 * The binder's in-flight failures, as responses. Anything else is rethrown.
 * Callers wrap the bind in `withDbTransaction` and catch OUTSIDE it, so the
 * savepoint has already rolled back every write when this runs (#11203).
 */
function bindFailureResponse(c: any, err: unknown): Response {
  if (err instanceof ContactGoneError) return contactNotFound(c);
  if (err instanceof ContactEmailChangedError) {
    return c.json({ error: "A contact's email changed while inviting. Reload and try again.", code: CODES.PORTAL_INVITE_EMAIL_MISMATCH }, 400);
  }
  // The reused login's epoch moved under the bind (W2 epoch guard).
  if (err instanceof PortalLoginChangedError) return concurrentChange(c);
  // Fail closed on an unknown stored status / browser_access (W2 state module).
  if (err instanceof PortalAccountTransitionError) return c.json({ error: err.message, code: err.code }, err.httpStatus);
  throw err;
}

async function purgeLoginSessions(userId: string): Promise<void> {
  await purgePortalSessionsForUsers([userId]);
  const redis = getRedis();
  if (redis) await purgeClientAiSessionsForUsers(redis, [userId]);
}

async function readOrgName(orgId: string): Promise<string | null> {
  const [orgRow] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return orgRow?.name ?? null;
}

// ── SSO invite for stranded accounts (portal registration W4 #11381, D12) ────

/** POST …/portal-users/sso-invite: Microsoft is not effective for the org, so there is nothing to invite with. */
export const PORTAL_SSO_INVITE_UNAVAILABLE = 'PORTAL_SSO_INVITE_UNAVAILABLE';

const ssoInviteSchema = z.object({
  portalUserIds: z.array(z.string().uuid()).min(1).max(100),
}).strict();

/** Per account: invited, not stranded (absent, another org, has an identity, disabled …), or the refusal code. */
type SsoInviteResult =
  | { result: 'invited'; emailSent: boolean }
  | { result: 'not_stranded' }
  | { result: string };

/**
 * The org-scoped account under `SELECT … FOR UPDATE`, its facts (identity
 * EXISTS included) re-read in a SEPARATE statement after the lock is held.
 * One statement would not do: under READ COMMITTED a locking read that waited
 * for a committing self-link re-checks the row but evaluates the identity
 * EXISTS against its own older snapshot, and so misses the new identity. A
 * self-link takes this row's lock first (portalOidc/accountResolution.ts), and
 * its identity insert's FK check needs `FOR KEY SHARE` on it, so no link can
 * land while we hold it. Held until the caller's transaction ends.
 */
async function lockOrgScopedPortalUser(orgId: string, userId: string) {
  const [locked] = await db.select({ id: portalUsers.id }).from(portalUsers)
    .where(and(eq(portalUsers.id, userId), eq(portalUsers.orgId, orgId)))
    .for('update')
    .limit(1);
  if (!locked) return null;
  return getOrgScopedPortalUser(orgId, userId);
}

/** ssoInviteOne's DB step: a final answer, or the account it moved to `invited`. */
type SsoInviteWrite =
  | { kind: 'done'; outcome: SsoInviteResult }
  | { kind: 'moved'; id: string; email: string; authEpoch: number; bumpedEpoch: boolean };

/**
 * One stranded account through the `msp_sso_invite` writer (the bulk-invite
 * shape: a state-module target written under the epoch it read, sessions
 * purged, then the invite issued at the new epoch). The email offers Microsoft
 * because the route has checked it is effective; issueAndSendInvite re-reads
 * the policy.
 *
 * Read, plan and write run in ONE savepoint under the account's row lock
 * ({@link lockOrgScopedPortalUser}). The epoch guard alone cannot catch a
 * concurrent self-link, which does not bump the epoch: an account linked
 * between an unlocked read and the write would be moved to `invited`, where
 * normal SSO refuses its status and invite acceptance its existing identity.
 * The purge and the invite run after the savepoint, as before.
 *
 * An `active` account that still holds a password is stranded only while
 * password sign-in is off (effective sso_only): with password allowed it can
 * sign in and connect Microsoft from its profile, and moving it to `invited`
 * would only lock it out.
 */
async function ssoInviteOne(c: any, orgId: string, portalUserId: string, orgName: string | null, actor: { id: string; name?: string | null }, passwordAllowed: boolean): Promise<SsoInviteResult> {
  const done = (outcome: SsoInviteResult): SsoInviteWrite => ({ kind: 'done', outcome });
  const write = await withDbTransaction(async (): Promise<SsoInviteWrite> => {
    const target = await lockOrgScopedPortalUser(orgId, portalUserId);
    if (!target || !isSsoOnlyStranded(target)) return done({ result: 'not_stranded' });
    if (passwordAllowed && target.status === 'active' && target.passwordHash) return done({ result: 'not_stranded' });
    let plan: PortalAccountTarget;
    try {
      plan = planPortalAccountTransition(accountFacts(target), 'msp_sso_invite');
    } catch (error) {
      if (!(error instanceof PortalAccountTransitionError)) throw error;
      const reason = inviteRefusalReason(error);
      return done({ result: reason ? REFUSAL_BY_REASON[reason].code : error.code });
    }
    const now = new Date();
    const [moved] = await db.update(portalUsers)
      .set({ ...stateSet(plan), invitedBy: actor.id, invitedAt: now, updatedAt: now })
      .where(and(eq(portalUsers.id, target.id), eq(portalUsers.orgId, orgId), eq(portalUsers.authEpoch, target.authEpoch)))
      .returning({ authEpoch: portalUsers.authEpoch });
    // Kept under the lock as a fail-closed guard: nothing written on a mismatch.
    if (!moved) return done({ result: PORTAL_ACCOUNT_TRANSITION_REFUSED });
    return { kind: 'moved', id: target.id, email: target.email, authEpoch: moved.authEpoch, bumpedEpoch: plan.bumpEpoch };
  });
  if (write.kind === 'done') return write.outcome;
  // Side effects after the write, as invite-contacts does: only Redis can throw
  // here (issueAndSendInvite's reads are savepoints), and the bumped epoch is
  // what refuses the old sessions, so a purge failure is safe to report past.
  if (write.bumpedEpoch) {
    try {
      await purgeLoginSessions(write.id);
    } catch (err) {
      // Its own catch: a purge failure must not also skip the invite.
      console.error(`[orgPortalUsers] sso-invite session purge failed portalUserId=${write.id} orgId=${orgId}:`, err);
    }
  }
  let emailSent = false;
  try {
    emailSent = await issueAndSendInvite(c, orgId, { id: write.id, email: write.email, authEpoch: write.authEpoch }, orgName, actor.name);
  } catch (err) {
    console.error(`[orgPortalUsers] sso-invite side effect failed portalUserId=${write.id} orgId=${orgId}:`, err);
  }
  return { result: 'invited', emailSent };
}

/**
 * Bind an invited portal LOGIN to the org's CONTACT for that address.
 *
 * A thin wrapper over the shared `linkLoginToContact` (services/contacts/
 * loginLink.ts) — the same resolution the Entra exchange and the Outlook
 * add-in use, so all three agree on the lock, the shared-mailbox refusal and
 * the role union.
 *
 * Runs in the caller's REQUEST context, so `contacts` is read and written
 * under RLS with the acting user as `created_by` — unlike the inbound path,
 * which is a system-context ingest side effect with no acting user.
 */
async function resolveInviteContact(
  orgId: string,
  normalizedEmail: string,
  name: string | null,
  actorUserId: string,
): Promise<{ contactId: string | null; link: InviteContactLink }> {
  const { contactId, outcome } = await linkLoginToContact(db, {
    orgId,
    email: normalizedEmail,
    name,
    actor: { userId: actorUserId },
    // Stated explicitly rather than left to the default: an invite really is
    // granting portal access, which is what earns the role — the add-in path
    // deliberately passes [] because it grants none.
    roles: ['portal'],
    unionRoles: ['portal'],
  });
  return { contactId, link: outcome };
}

export function registerOrgPortalUsersRoutes(orgRoutes: Hono) {
  const requireOrgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
  const requireOrgWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);

  orgRoutes.get('/organizations/:id/portal-users', requireScope('partner', 'system'), requireOrgRead, async (c) => {
    const org = await resolveAccessibleOrg(c);
    if (org instanceof Response) return org;
    return c.json({ data: await listPortalUsersForOrg(org.id) });
  });

  orgRoutes.post('/organizations/:id/portal-users/invite', requireScope('partner', 'system'), requireOrgWrite, requireMfa(), zValidator('json', invitePortalUserSchema), async (c) => {
    const org = await resolveAccessibleOrg(c);
    if (org instanceof Response) return org;
    const auth = c.get('auth') as AuthContext;
    const { email, name, message, contactId } = c.req.valid('json');
    const normalizedEmail = email.trim().toLowerCase();

    if (contactId) {
      // Bind to THE contact the MSP picked. Read by (org, id) together, then
      // site reach: a sibling org of the same partner is visible under RLS.
      const [contact] = await loadOrgContactsForPortalInvite(db, org.id, [contactId]);
      if (!contact || !canReachContactSite(auth, contact.siteId)) return contactNotFound(c);
      const contactEmail = normalizeContactEmail(contact.email);
      if (!contactEmail) {
        return c.json({ error: 'This contact has no email address.', code: CODES.PORTAL_INVITE_CONTACT_NO_EMAIL }, 400);
      }
      // Binding a contact grants its ticket history, so the invite address
      // must BE the contact's address (case-insensitive).
      if (contactEmail !== normalizeContactEmail(email)) {
        return c.json({ error: MSG_EMAIL_MISMATCH, code: CODES.PORTAL_INVITE_EMAIL_MISMATCH }, 400);
      }

      let decision: ContactInviteDecision;
      try {
        decision = await withDbTransaction(() => bindContactLoginForInvite(db, {
          orgId: org.id,
          contact,
          normalizedEmail: contactEmail,
          name: name ?? null,
          actor: { userId: auth.user.id },
          now: new Date(),
        }));
      } catch (err) {
        return bindFailureResponse(c, err);
      }
      if (decision.kind !== 'invite') return c.json(inviteDecisionRefusal(decision), 409);

      if (!decision.created) await purgeLoginSessions(decision.portalUserId);
      const emailSent = await issueAndSendInvite(c, org.id, { id: decision.portalUserId, email: decision.email, authEpoch: decision.authEpoch }, await readOrgName(org.id), auth.user.name, message);
      const contactLink: InviteContactLink = decision.contactLink;
      writeRouteAudit(c, {
        orgId: org.id,
        action: 'organization.portal_user.invite',
        resourceType: 'portal_user',
        resourceId: decision.portalUserId,
        details: { email: decision.email, emailSent, contactLink, contactId: contact.id },
      });
      return c.json({ data: { id: decision.portalUserId, email: decision.email, status: 'invited', contactLink }, emailSent });
    }

    // The per-address lock BEFORE the existing-login read (W3 Review Focus 3).
    // Approving a self/SSO access request takes this lock, refuses when the
    // address has an account, and inserts one; read first and this invite
    // could act on a stale "none" and insert a second portal_users row for the
    // address (portal_users.email is not unique). Held to the end of the
    // request transaction; the contact resolver's re-take below is a no-op.
    await lockPortalInviteAddresses(db, org.id, [normalizedEmail]);
    const [existing] = await db.select({ id: portalUsers.id, email: portalUsers.email, passwordHash: portalUsers.passwordHash, authMethod: portalUsers.authMethod, status: portalUsers.status, contactId: portalUsers.contactId, authEpoch: portalUsers.authEpoch, browserAccess: portalUsers.browserAccess, hasExternalIdentity: portalUserHasIdentitySql() })
      .from(portalUsers).where(and(eq(portalUsers.orgId, org.id), portalLoginEmailEquals(normalizedEmail))).limit(1);

    // Refusals (identity-managed, disabled, already active with a password)
    // come from the state module, BEFORE any contact is read or written.
    const target = existing ? planInviteOrRefuse(c, existing) : null;
    if (target instanceof Response) return target;

    const now = new Date();
    let userId: string;
    let authEpoch: number;
    let contactLink: InviteContactLink;
    if (existing && target) {
      // An existing link is never re-derived, let alone overwritten: whoever
      // set it (the 2026-08-19 backfill, a previous invite, a tech editing the
      // contact) knew more than an email string does. Skipping the lookup also
      // stops a re-invite from minting a duplicate contact.
      //
      // `resolveInviteContact` only ever returns a contact in `org.id`, and
      // this row is in `org.id` too — but that is no longer the only thing
      // keeping the pair same-org: `portal_users_contact_org_fk`
      // (contact_id, org_id) -> contacts (id, org_id) makes a cross-org link
      // unrepresentable, so a future writer that forgets the org bound gets a
      // 23503 rather than a silent tenant leak (#3258 follow-up).
      const contactPatch: { contactId?: string } = {};
      if (existing.contactId) {
        contactLink = 'kept';
      } else {
        const resolved = await resolveInviteContact(org.id, normalizedEmail, name ?? null, auth.user.id);
        contactLink = resolved.link;
        if (resolved.contactId) contactPatch.contactId = resolved.contactId;
      }
      const [moved] = await db.update(portalUsers)
        .set({ name: name ?? undefined, ...stateSet(target), invitedBy: auth.user.id, invitedAt: now, updatedAt: now, ...contactPatch })
        .where(and(eq(portalUsers.id, existing.id), eq(portalUsers.orgId, org.id), eq(portalUsers.authEpoch, existing.authEpoch)))
        .returning({ id: portalUsers.id, authEpoch: portalUsers.authEpoch });
      if (!moved) return concurrentChange(c);
      await purgePortalSessionsForUsers([existing.id]);
      const redis = getRedis();
      if (redis) await purgeClientAiSessionsForUsers(redis, [existing.id]);
      userId = moved.id;
      authEpoch = moved.authEpoch;
    } else {
      const resolved = await resolveInviteContact(org.id, normalizedEmail, name ?? null, auth.user.id);
      contactLink = resolved.link;
      const [created] = await db.insert(portalUsers).values({ orgId: org.id, email: normalizedEmail, name: name ?? null, passwordHash: null, authMethod: 'password', ...initialPortalAccountState('msp_invite'), invitedBy: auth.user.id, invitedAt: now, contactId: resolved.contactId }).returning({ id: portalUsers.id, authEpoch: portalUsers.authEpoch });
      userId = created!.id;
      authEpoch = created!.authEpoch;
    }

    const [orgRow] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, org.id)).limit(1);
    const emailSent = await issueAndSendInvite(c, org.id, { id: userId, email: normalizedEmail, authEpoch }, orgRow?.name ?? null, auth.user.name, message);

    writeRouteAudit(c, { orgId: org.id, action: 'organization.portal_user.invite', resourceType: 'portal_user', resourceId: userId, details: { email: normalizedEmail, emailSent, contactLink } });
    // `contactLink` is returned, not only audited: 'ambiguous' means the login
    // was created WITHOUT a contact and therefore cannot see the tickets that
    // address has emailed in (routes/portal/ticketOwnership.ts). The audit log
    // is not somewhere an API consumer — or the invite UI — can read that from.
    // (The UI warning itself is a follow-up; this is the field it needs.)
    return c.json({ data: { id: userId, email: normalizedEmail, status: 'invited', contactLink }, emailSent });
  });

  orgRoutes.patch('/organizations/:id/portal-users/:userId', requireScope('partner', 'system'), requireOrgWrite, requireMfa(), zValidator('json', updatePortalUserSchema), async (c) => {
    const org = await resolveAccessibleOrg(c);
    if (org instanceof Response) return org;
    const body = c.req.valid('json');
    if (Object.keys(body).length === 0) return c.json({ error: 'No updates provided' }, 400);
    const target = await getOrgScopedPortalUser(org.id, c.req.param('userId')!);
    if (!target) return c.json({ error: 'Portal user not found' }, 404);
    const { status: requestedStatus, ...profileFields } = body;
    // status 'disabled' → msp_disable; 'active' → msp_reactivate, which may
    // land on 'invited' for an account with no credential (plan D4) and
    // refuses an invited account (invited → active is accept-invite only).
    let plan: PortalAccountTarget | null = null;
    if (requestedStatus !== undefined) {
      const planned = planOrRefuse(c, target, requestedStatus === 'disabled' ? 'msp_disable' : 'msp_reactivate');
      if (planned instanceof Response) return planned;
      plan = planned;
    }
    const [updated] = await db.update(portalUsers).set({
      ...profileFields,
      ...(plan ? stateSet(plan) : {}),
      updatedAt: new Date(),
    }).where(and(
      eq(portalUsers.id, target.id),
      eq(portalUsers.orgId, org.id),
      ...(plan ? [eq(portalUsers.authEpoch, target.authEpoch)] : []),
    )).returning({ id: portalUsers.id, status: portalUsers.status });
    if (!updated) return concurrentChange(c);
    // Sessions end only on a real transition (a no-op reactivate keeps them).
    if (plan?.bumpEpoch) {
      await purgePortalSessionsForUsers([target.id]);
      const redis = getRedis();
      if (redis) await purgeClientAiSessionsForUsers(redis, [target.id]);
    }
    writeRouteAudit(c, { orgId: org.id, action: 'organization.portal_user.update', resourceType: 'portal_user', resourceId: target.id, details: { changedFields: Object.keys(body), ...(plan ? { status: updated.status } : {}) } });
    return c.json({ data: { id: updated.id, status: updated.status } });
  });

  orgRoutes.post('/organizations/:id/portal-users/:userId/resend-invite', requireScope('partner', 'system'), requireOrgWrite, requireMfa(), async (c) => {
    const org = await resolveAccessibleOrg(c);
    if (org instanceof Response) return org;
    const auth = c.get('auth') as AuthContext;
    const target = await getOrgScopedPortalUser(org.id, c.req.param('userId')!);
    if (!target) return c.json({ error: 'Portal user not found' }, 404);
    const plan = planOrRefuse(c, target, 'msp_resend_invite');
    if (plan instanceof Response) return plan;
    let authEpoch = target.authEpoch;
    // A legacy credential-less ACTIVE row moves to invited first, so the
    // token is redeemable; an invited row is resent with no write.
    if (plan.bumpEpoch || plan.status !== target.status || plan.browserAccess !== target.browserAccess) {
      const now = new Date();
      const [moved] = await db.update(portalUsers)
        .set({ ...stateSet(plan), invitedBy: auth.user.id, invitedAt: now, updatedAt: now })
        .where(and(eq(portalUsers.id, target.id), eq(portalUsers.orgId, org.id), eq(portalUsers.authEpoch, target.authEpoch)))
        .returning({ authEpoch: portalUsers.authEpoch });
      if (!moved) return concurrentChange(c);
      authEpoch = moved.authEpoch;
      if (plan.bumpEpoch) {
        await purgePortalSessionsForUsers([target.id]);
        const redis = getRedis();
        if (redis) await purgeClientAiSessionsForUsers(redis, [target.id]);
      }
    }
    const [orgRow] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, org.id)).limit(1);
    const emailSent = await issueAndSendInvite(c, org.id, { id: target.id, email: target.email, authEpoch }, orgRow?.name ?? null, auth.user.name);
    writeRouteAudit(c, { orgId: org.id, action: 'organization.portal_user.resend_invite', resourceType: 'portal_user', resourceId: target.id, details: { emailSent } });
    return c.json({ data: { id: target.id }, emailSent });
  });

  orgRoutes.post('/organizations/:id/portal-users/bulk-invite', requireScope('partner', 'system'), requireOrgWrite, requireMfa(), zValidator('json', bulkInvitePortalUsersSchema), async (c) => {
    const org = await resolveAccessibleOrg(c);
    if (org instanceof Response) return org;
    const auth = c.get('auth') as AuthContext;
    const { userIds } = c.req.valid('json');
    // "Pending setup" = a password-method row with no password and no external
    // identity, invited or (pre-#3258 inbound email) active (plan D2). Bulk
    // invite can never touch an add-in (Entra) or identity-only account.
    // "No external identity" = no portal_user_identities row (W3 release B).
    const baseWhere = and(
      eq(portalUsers.orgId, org.id),
      eq(portalUsers.authMethod, 'password'),
      isNull(portalUsers.passwordHash),
      sql`not ${portalUserHasIdentitySql()}`,
      inArray(portalUsers.status, ['invited', 'active']),
    );
    const candidates = await db.select({ id: portalUsers.id, email: portalUsers.email, status: portalUsers.status, browserAccess: portalUsers.browserAccess, authMethod: portalUsers.authMethod, passwordHash: portalUsers.passwordHash, hasExternalIdentity: portalUserHasIdentitySql(), authEpoch: portalUsers.authEpoch }).from(portalUsers).where(baseWhere);
    const eligible = candidates.filter((u) => isBulkInviteEligible(accountFacts(u)));
    const targets = userIds && userIds.length > 0 ? eligible.filter((u) => userIds.includes(u.id)) : eligible;
    const [orgRow] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, org.id)).limit(1);
    const now = new Date();
    // `skipped` tells the caller (and the audit) a row was NOT invited, as
    // distinct from an invite whose email failed (`emailSent: false` alone).
    const results: Array<{ id: string; emailSent: boolean; skipped?: 'refused' | 'concurrent_change' }> = [];
    for (const t of targets) {
      let plan: PortalAccountTarget;
      try {
        plan = planPortalAccountTransition(accountFacts(t), 'msp_bulk_invite');
      } catch (error) {
        if (error instanceof PortalAccountTransitionError) { results.push({ id: t.id, emailSent: false, skipped: 'refused' }); continue; }
        throw error;
      }
      const [moved] = await db.update(portalUsers)
        .set({ ...stateSet(plan), invitedBy: auth.user.id, invitedAt: now, updatedAt: now })
        .where(and(eq(portalUsers.id, t.id), eq(portalUsers.orgId, org.id), eq(portalUsers.authEpoch, t.authEpoch)))
        .returning({ authEpoch: portalUsers.authEpoch });
      // Changed since the candidate read (disabled, accepted, re-invited): skip it.
      if (!moved) { results.push({ id: t.id, emailSent: false, skipped: 'concurrent_change' }); continue; }
      await purgePortalSessionsForUsers([t.id]);
      const redis = getRedis();
      if (redis) await purgeClientAiSessionsForUsers(redis, [t.id]);
      const emailSent = await issueAndSendInvite(c, org.id, { id: t.id, email: t.email, authEpoch: moved.authEpoch }, orgRow?.name ?? null, auth.user.name);
      results.push({ id: t.id, emailSent });
    }
    writeRouteAudit(c, { orgId: org.id, action: 'organization.portal_user.bulk_invite', resourceType: 'organization', resourceId: org.id, details: { invited: results.filter((r) => !r.skipped).length, skipped: results.filter((r) => r.skipped).length } });
    return c.json({ data: results });
  });

  // W4 (#11381, spec §5.11): "Send Microsoft sign-in invite" to stranded
  // accounts (no identity, so `sso_only` leaves them unable to sign in).
  // Sequential, one result per unique id, in request order.
  orgRoutes.post('/organizations/:id/portal-users/sso-invite', requireScope('partner', 'system'), requireOrgWrite, requireMfa(), zValidator('json', ssoInviteSchema), async (c) => {
    const org = await resolveAccessibleOrg(c);
    if (org instanceof Response) return org;
    const auth = c.get('auth') as AuthContext;
    const ids = [...new Set(c.req.valid('json').portalUserIds)];
    const methods = await resolveInviteSignInMethods(org.id);
    if (!methods.microsoft) {
      return c.json({ error: 'Microsoft sign-in is not available for this organization.', code: PORTAL_SSO_INVITE_UNAVAILABLE }, 409);
    }
    const orgName = await readOrgName(org.id);
    const results: Array<{ portalUserId: string } & SsoInviteResult> = [];
    for (const portalUserId of ids) {
      results.push({ portalUserId, ...(await ssoInviteOne(c, org.id, portalUserId, orgName, auth.user, methods.password)) });
    }
    const invited = results.filter((r) => r.result === 'invited').length;
    const notStranded = results.filter((r) => r.result === 'not_stranded').length;
    writeRouteAudit(c, {
      orgId: org.id,
      action: 'organization.portal_user.sso_invite',
      resourceType: 'organization',
      resourceId: org.id,
      details: { requested: ids.length, invited, notStranded, refused: ids.length - invited - notStranded },
    });
    return c.json({ data: results });
  });

  // W4: "Give browser access" to an existing (typically add-in) account. The
  // state module's msp_grant_browser_access writer: no epoch bump, so the
  // person's add-in sessions keep working; disabled / invited are refused.
  orgRoutes.post('/organizations/:id/portal-users/:userId/browser-access', requireScope('partner', 'system'), requireOrgWrite, requireMfa(), async (c) => {
    const org = await resolveAccessibleOrg(c);
    if (org instanceof Response) return org;
    const target = await getOrgScopedPortalUser(org.id, c.req.param('userId')!);
    if (!target) return c.json({ error: 'Portal user not found' }, 404);
    const plan = planOrRefuse(c, target, 'msp_grant_browser_access');
    if (plan instanceof Response) return plan;
    if (plan.status !== target.status || plan.browserAccess !== target.browserAccess || plan.bumpEpoch) {
      const [updated] = await db.update(portalUsers)
        .set({ ...stateSet(plan), updatedAt: new Date() })
        .where(and(eq(portalUsers.id, target.id), eq(portalUsers.orgId, org.id), eq(portalUsers.authEpoch, target.authEpoch)))
        .returning({ id: portalUsers.id });
      if (!updated) return concurrentChange(c);
      writeRouteAudit(c, { orgId: org.id, action: 'organization.portal_user.browser_access.grant', resourceType: 'portal_user', resourceId: target.id, details: { email: target.email } });
    }
    return c.json({ data: { browserAccess: 'granted' as const } });
  });

  // Batch "Give portal access" from the Contacts tab (W1, #11378). Always 200
  // once validation and reach pass, with exactly one result per unique id.
  orgRoutes.post('/organizations/:id/portal-users/invite-contacts', requireScope('partner', 'system'), requireOrgWrite, requireMfa(), zValidator('json', inviteContactsToPortalSchema), async (c) => {
    const org = await resolveAccessibleOrg(c);
    if (org instanceof Response) return org;
    const auth = c.get('auth') as AuthContext;
    const ids = [...new Set(c.req.valid('json').contactIds)];

    // All or nothing on reach: one id outside the org (or on a barred site)
    // fails the batch with the single-invite 404, so there is no per-id oracle.
    const loaded = await loadOrgContactsForPortalInvite(db, org.id, ids);
    const byId = new Map(loaded.filter((row) => canReachContactSite(auth, row.siteId)).map((row) => [row.id, row]));
    if (ids.some((id) => !byId.has(id))) return contactNotFound(c);

    const results = new Map<string, ContactPortalInviteResult>();
    const emailOf = new Map<string, string>();
    const idsByEmail = new Map<string, string[]>();
    for (const id of ids) {
      const email = normalizeContactEmail(byId.get(id)!.email);
      if (!email) {
        results.set(id, { contactId: id, outcome: 'no_email' });
        continue;
      }
      emailOf.set(id, email);
      idsByEmail.set(email, [...(idsByEmail.get(email) ?? []), id]);
    }
    // Two requested contacts on one address: no guess at who the "real" one
    // is (the `ambiguous` rule in loginLink.ts), so every one of them is refused.
    for (const group of idsByEmail.values()) {
      if (group.length < 2) continue;
      for (const id of group) {
        results.set(id, { contactId: id, outcome: 'duplicate_email_in_batch' });
        emailOf.delete(id);
      }
    }
    const eligible: Array<{ contact: InviteableContact; email: string }> = ids
      .filter((id) => emailOf.has(id))
      .map((id) => ({ contact: byId.get(id)!, email: emailOf.get(id)! }));

    // Phase 1, DB only, in ONE savepoint: a contact deleted mid-batch rolls
    // back every bind before anything is mailed. Every address is locked up
    // front in one sorted order (see lockPortalInviteAddresses).
    const now = new Date();
    const decisions = new Map<string, ContactInviteDecision>();
    try {
      await withDbTransaction(async () => {
        await lockPortalInviteAddresses(db, org.id, eligible.map((e) => e.email));
        for (const { contact, email } of eligible) {
          decisions.set(contact.id, await bindContactLoginForInvite(db, {
            orgId: org.id, contact, normalizedEmail: email, name: null, actor: { userId: auth.user.id }, now,
          }));
        }
      });
    } catch (err) {
      return bindFailureResponse(c, err);
    }

    // Phase 2, side effects, only after every bind held.
    const orgName = eligible.length > 0 ? await readOrgName(org.id) : null;
    for (const { contact } of eligible) {
      const decision = decisions.get(contact.id)!;
      if (decision.kind === 'already_has_access') {
        results.set(contact.id, { contactId: contact.id, outcome: 'already_has_access', portalUserId: decision.portalUserId, reason: decision.reason });
        continue;
      }
      if (decision.kind === 'email_bound_to_other_contact') {
        results.set(contact.id, { contactId: contact.id, outcome: 'email_bound_to_other_contact', portalUserId: decision.portalUserId });
        continue;
      }
      // A failed send keeps the login and reports emailSent:false; the UI
      // tells the MSP to use Resend rather than claiming a clean success.
      //
      // The catch is load-bearing: earlier contacts may already have been
      // mailed links to their logins, and a throw here would 500 the request
      // and roll those logins back under the links. Only Redis calls can throw
      // here (the branding read inside issueAndSendInvite is already in its
      // own savepoint), so catching does not poison the request transaction.
      // A purge failure is safe to continue past: the bind bumped auth_epoch,
      // which is what live sessions are checked against.
      let emailSent = false;
      try {
        if (!decision.created) await purgeLoginSessions(decision.portalUserId);
        emailSent = await issueAndSendInvite(c, org.id, { id: decision.portalUserId, email: decision.email, authEpoch: decision.authEpoch }, orgName, auth.user.name);
      } catch (err) {
        console.error(`[orgPortalUsers] invite-contacts side effect failed portalUserId=${decision.portalUserId} orgId=${org.id}:`, err);
      }
      results.set(contact.id, { contactId: contact.id, outcome: 'invited', portalUserId: decision.portalUserId, emailSent });
      writeRouteAudit(c, {
        orgId: org.id,
        action: 'organization.portal_user.invite',
        resourceType: 'portal_user',
        resourceId: decision.portalUserId,
        details: { email: decision.email, emailSent, contactLink: decision.contactLink, contactId: contact.id, source: 'invite_contacts' },
      });
    }

    const ordered = ids.map((id) => results.get(id)!);
    const counts = Object.fromEntries(CONTACT_PORTAL_INVITE_OUTCOMES.map((o) => [o, 0])) as Record<ContactPortalInviteOutcome, number>;
    for (const r of ordered) counts[r.outcome] += 1;
    writeRouteAudit(c, { orgId: org.id, action: 'organization.portal_user.invite_contacts', resourceType: 'organization', resourceId: org.id, details: { requested: ids.length, counts } });
    return c.json({ data: { results: ordered, counts } });
  });

  orgRoutes.delete('/organizations/:id/portal-users/:userId', requireScope('partner', 'system'), requireOrgWrite, requireMfa(), async (c) => {
    const org = await resolveAccessibleOrg(c);
    if (org instanceof Response) return org;
    const target = await getOrgScopedPortalUser(org.id, c.req.param('userId')!);
    if (!target) return c.json({ error: 'Portal user not found' }, 404);
    if (await hasPortalUserReferences(target.id)) {
      return c.json({ error: 'This user has ticket or asset history. Disable them instead of deleting.' }, 409);
    }
    await db.delete(portalUsers).where(eq(portalUsers.id, target.id));
    writeRouteAudit(c, { orgId: org.id, action: 'organization.portal_user.delete', resourceType: 'portal_user', resourceId: target.id, details: { email: target.email } });
    return c.json({ data: { id: target.id, deleted: true } });
  });
}
