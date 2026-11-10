/**
 * Completing a self-registration once its mailbox-proof link is consumed
 * (portal registration W6, plan D8 + D10; spec §5.9 steps 4–5).
 *
 * Called by the public verify route with NO DB context held (the W5 read API
 * throws inside a request transaction). Re-validates every leg the link was
 * issued under, in order — any failure is a `refused` the route answers with
 * the same generic 400 an unknown token gets:
 *   1. the org (and its partner) is still active;
 *   2. the address's exact domain is still verified FOR THAT ORG
 *      (`isDomainVerifiedForOrg`): lapsed, removed, deactivated or displaced
 *      to another org all refuse — nobody lands in the old org (feature RF2);
 *   3. the org's access-policy fingerprint is unchanged (any change to the
 *      effective values or the proven tenant since issue refuses), and the
 *      mode is not `off` (defensive: turning it off changes the fingerprint).
 * Then: any `portal_users` row in the org at the address → `existing_account`
 * (never modified, inv. 5); `approval` → a `self` access request (W3 queue);
 * `instant` → an `invited` + `granted` password account linked to its contact,
 * and a fresh invite token for `/accept-invite`, which applies the policy
 * itself (password, or the invitation-bound Microsoft sign-in under
 * `sso_only`).
 */
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { portalUsers } from '../../db/schema';
import { issuePortalCapabilityToken, type PortalSelfRegistrationPayload } from '../../routes/portal/capabilityTokens';
import { linkLoginToContact } from '../contacts/loginLink';
import { lockPortalInviteAddresses, portalLoginEmailEquals } from '../contacts/portalInvite';
import { initialPortalAccountState } from '../portalAccountState';
import { PortalAccessPolicyOrgNotFoundError, resolvePortalAccessPolicy } from '../portalAccessPolicy';
import { createPortalAccessRequest } from '../portalAccessRequests';
import { isDomainVerifiedForOrg } from '../portalDomainVerification';
import { getActiveOrgTenant } from '../tenantStatus';
import { emailDomainOf } from './emailDomain';

export type SelfRegistrationRefusal = 'org_inactive' | 'domain_not_verified' | 'policy_changed' | 'mode_off';

export type CompleteSelfRegistrationOutcome =
  | { outcome: 'refused'; reason: SelfRegistrationRefusal }
  | { outcome: 'existing_account'; orgId: string }
  | { outcome: 'request_sent'; orgId: string; requestId: string; created: boolean }
  | { outcome: 'request_unavailable'; orgId: string }
  /** `inviteToken` null: the token store went away after commit (D10 residual; the route answers 503). */
  | { outcome: 'account_created'; orgId: string; portalUserId: string; inviteToken: string | null };

const refused = (reason: SelfRegistrationRefusal): CompleteSelfRegistrationOutcome => ({ outcome: 'refused', reason });

async function hasAccountInOrg(orgId: string, email: string): Promise<boolean> {
  const rows = await withSystemDbAccessContext(() =>
    db
      .select({ id: portalUsers.id })
      .from(portalUsers)
      .where(and(eq(portalUsers.orgId, orgId), portalLoginEmailEquals(email)))
      .limit(1),
  );
  return rows.length > 0;
}

/**
 * The instant-mode account, in ONE system transaction: take the address lock
 * every login creator takes, refuse any account at the address (an invite
 * may have raced the click), bind the org's contact, insert the login.
 */
async function createSelfRegisteredAccount(
  payload: PortalSelfRegistrationPayload,
  domain: string,
  now: Date,
): Promise<
  | { kind: 'created'; portalUserId: string; authEpoch: number }
  | { kind: 'account_exists' }
  | { kind: 'refused'; reason: SelfRegistrationRefusal }
> {
  return withSystemDbAccessContext(async () => {
    await lockPortalInviteAddresses(db, payload.orgId, [payload.email]);
    // Re-check the domain and the policy INSIDE the admission transaction,
    // after the lock wait (quorum finding): the pre-checks above ran before
    // it, and an unauthenticated instant admission has no later MSP decision
    // to catch a domain removed or displaced in between. W5's read joins a
    // held system context.
    if (!(await isDomainVerifiedForOrg(domain, payload.orgId))) return { kind: 'refused' as const, reason: 'domain_not_verified' as const };
    const policy = await resolvePortalAccessPolicy(payload.orgId);
    if (policy.fingerprint !== payload.policyFingerprint) return { kind: 'refused' as const, reason: 'policy_changed' as const };

    const [existing] = await db
      .select({ id: portalUsers.id })
      .from(portalUsers)
      .where(and(eq(portalUsers.orgId, payload.orgId), portalLoginEmailEquals(payload.email)))
      .limit(1);
    if (existing) return { kind: 'account_exists' as const };

    const { contactId } = await linkLoginToContact(db, {
      orgId: payload.orgId,
      email: payload.email,
      name: payload.name,
      // No staff user acts: the requester proved the mailbox (as W4 instant mode).
      actor: { userId: null },
      roles: ['portal'],
      unionRoles: ['portal'],
    });

    const [created] = await db
      .insert(portalUsers)
      .values({
        orgId: payload.orgId,
        email: payload.email,
        name: payload.name,
        passwordHash: null,
        authMethod: 'password',
        ...initialPortalAccountState('self_registration_instant'),
        invitedAt: now,
        invitedBy: null,
        contactId,
      })
      .returning({ id: portalUsers.id, authEpoch: portalUsers.authEpoch });
    if (!created) throw new Error('portal user insert returned no row');
    return { kind: 'created' as const, portalUserId: created.id, authEpoch: created.authEpoch };
  });
}

/** No DB context held (public route). Re-validates per D8, then applies D10. */
export async function completePortalSelfRegistration(
  payload: PortalSelfRegistrationPayload,
  now: Date = new Date(),
): Promise<CompleteSelfRegistrationOutcome> {
  const { orgId } = payload;

  if (!(await getActiveOrgTenant(orgId))) return refused('org_inactive');

  // The domain is re-derived from the address: the payload's field must agree.
  const domain = emailDomainOf(payload.email);
  if (!domain || domain !== payload.domain) return refused('domain_not_verified');
  if (!(await isDomainVerifiedForOrg(domain, orgId))) return refused('domain_not_verified');

  let policy;
  try {
    policy = await resolvePortalAccessPolicy(orgId);
  } catch (err) {
    if (err instanceof PortalAccessPolicyOrgNotFoundError) return refused('org_inactive');
    throw err;
  }
  if (policy.fingerprint !== payload.policyFingerprint) return refused('policy_changed');
  const mode = policy.effective.selfRegistrationMode.value;
  if (mode === 'off') return refused('mode_off');

  if (await hasAccountInOrg(orgId, payload.email)) return { outcome: 'existing_account', orgId };

  if (mode === 'approval') {
    const request = await createPortalAccessRequest({ source: 'self', orgId, email: payload.email, name: payload.name }, now);
    if (request.kind === 'capped') return { outcome: 'request_unavailable', orgId };
    return { outcome: 'request_sent', orgId, requestId: request.requestId, created: request.kind === 'created' };
  }

  const account = await createSelfRegisteredAccount(payload, domain, now);
  if (account.kind === 'account_exists') return { outcome: 'existing_account', orgId };
  if (account.kind === 'refused') return refused(account.reason);

  // After commit: the account is durable whether or not the token is minted.
  // A store error (not just a missing client) maps to the documented null
  // residual, so the route still audits the account and answers 503.
  let inviteToken: string | null;
  try {
    inviteToken = await issuePortalCapabilityToken({
      purpose: 'invite',
      portalUserId: account.portalUserId,
      orgId,
      email: payload.email,
      authEpoch: account.authEpoch,
    });
  } catch (err) {
    console.error('[portal-self-registration] invite token issue failed after account creation', {
      orgId, error: err instanceof Error ? err.name : 'unknown',
    });
    inviteToken = null;
  }
  return { outcome: 'account_created', orgId, portalUserId: account.portalUserId, inviteToken };
}
