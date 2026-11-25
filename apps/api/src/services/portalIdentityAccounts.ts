/**
 * The identity-only portal account writer (portal registration W4 #11381,
 * plan Task 5). One writer for the two ways an SSO person gets a brand-new
 * account (spec §5.6 step 4):
 *  - an MSP approving a pending `entra` / `google` access request
 *    (services/portalAccessRequests.ts, writer `sso_request_approved`);
 *  - a first Microsoft sign-in under the `instant` new-person mode
 *    (services/portalOidc/accountResolution.ts, writer `sso_instant`).
 *
 * The account is identity-only (W3 D2): `auth_method` names the provider,
 * never `password`, and it has no password hash. The identity row is the only
 * record of the external identity (W10: the legacy `portal_users.entra_*`
 * columns are no longer written). Status and browser access come from
 * services/portalAccountState.ts.
 *
 * Runs on the caller's transaction (`tx`), every statement in sequence.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { portalUserIdentities, portalUsers } from '../db/schema';
import { linkLoginToContact } from './contacts/loginLink';
import { lockPortalInviteAddresses } from './contacts/portalInvite';
import { initialPortalAccountState } from './portalAccountState';
import { PORTAL_GOOGLE_ISSUER, entraIssuer, type IdentityExecutor } from './portalUserIdentities';

export type CreateIdentityOnlyAccountInput = {
  orgId: string;
  /** The login's address, lowercased (plan D10: the linkable address, else the UPN). */
  email: string;
  name: string | null;
  /**
   * The address to bind the login's contact to, or null for no contact link.
   * Only a linkable address (resolveLinkableEntraAddress) or an address an MSP
   * approved is ever passed here (D10).
   */
  contactAddress: string | null;
  /** The approving Breeze user, or null for a self-provisioning (instant) sign-in. */
  actorUserId: string | null;
  /**
   * W9 (#11386, plan D4): `scim_provision` / `scim_provision_inactive` — a SCIM
   * POST. The identity is `linked_via = 'scim'` and carries {@link scim}; the
   * caller passes `contactAddress: null` (a SCIM userName is not a verified
   * claim, quorum D4). The inactive writer starts the login disabled by SCIM
   * and the identity with the `scim` blocker, in this same insert.
   */
  writer: 'sso_request_approved' | 'sso_instant' | 'scim_provision' | 'scim_provision_inactive';
  /** Required for the SCIM writers: the SCIM attributes as received. */
  scim?: { userName: string; displayName: string | null; givenName: string | null; familyName: string | null };
  now: Date;
} & ({ provider: 'entra'; tid: string; oid: string } | { provider: 'google'; sub: string });

export type CreateIdentityOnlyAccountOutcome =
  | { kind: 'created'; portalUserId: string; authEpoch: number; identityId: string }
  | { kind: 'account_exists' }
  | { kind: 'identity_linked' };

/**
 * Create an identity-only account and its identity.
 *
 * 1. Take the address lock every creator of a login takes (MSP invite,
 *    contact link, inbound email) — `portal_users.email` is not unique (spec
 *    F3), so the lock is what keeps a concurrent creator from making a second
 *    account — then refuse when ANY account in the org is at the address:
 *    `account_exists`. Never link by email (spec §5.6 step 4, inv. 5). Nothing
 *    has been written yet.
 * 2. Bind the login to the org's contact for `contactAddress`, when given.
 * 3. Insert the login and then the identity, both `ON CONFLICT DO NOTHING`
 *    (no target: every unique key), so a taken identity never raises 23505.
 *    The identity can conflict on `(issuer, subject)` (the login on no key
 *    of its own any more: W10 dropped the legacy entra_* write). Either way the
 *    identity is linked elsewhere — possibly in an org this context cannot
 *    see — and the outcome is `identity_linked`.
 *
 * On `identity_linked` the contact link and possibly the login row HAVE been
 * written on `tx`: the caller must roll its transaction back (both callers
 * throw out of it).
 */
export async function createIdentityOnlyAccount(
  tx: IdentityExecutor,
  input: CreateIdentityOnlyAccountInput,
): Promise<CreateIdentityOnlyAccountOutcome> {
  const scimWriter = input.writer === 'scim_provision' || input.writer === 'scim_provision_inactive';
  if (scimWriter && (!input.scim || input.provider !== 'entra')) {
    throw new Error('createIdentityOnlyAccount: a SCIM writer needs entra scim attributes');
  }
  const addresses = [...new Set([input.email, input.contactAddress].filter((a): a is string => Boolean(a)))];

  await lockPortalInviteAddresses(tx, input.orgId, addresses);
  const [existing] = await tx
    .select({ id: portalUsers.id })
    .from(portalUsers)
    .where(and(eq(portalUsers.orgId, input.orgId), inArray(sql`lower(${portalUsers.email})`, addresses)))
    .limit(1);
  if (existing) return { kind: 'account_exists' };

  const contactId = input.contactAddress
    ? (await linkLoginToContact(tx, {
      orgId: input.orgId,
      email: input.contactAddress,
      name: input.name,
      actor: { userId: input.actorUserId },
      roles: ['portal'],
      unionRoles: ['portal'],
    })).contactId
    : null;

  const initial = initialPortalAccountState(input.writer);
  const [created] = await tx
    .insert(portalUsers)
    .values({
      orgId: input.orgId,
      email: input.email,
      name: input.name,
      passwordHash: null,
      authMethod: input.provider,
      status: initial.status,
      browserAccess: initial.browserAccess,
      // W9: non-null only for scim_provision_inactive ('scim').
      disabledBy: initial.disabledBy,
      contactId,
    })
    .onConflictDoNothing()
    .returning({ id: portalUsers.id, authEpoch: portalUsers.authEpoch });
  if (!created) return { kind: 'identity_linked' };

  const [identity] = await tx
    .insert(portalUserIdentities)
    .values({
      orgId: input.orgId,
      portalUserId: created.id,
      provider: input.provider,
      issuer: input.provider === 'entra' ? entraIssuer(input.tid) : PORTAL_GOOGLE_ISSUER,
      subject: input.provider === 'entra' ? input.oid : input.sub,
      entraTenantId: input.provider === 'entra' ? input.tid : null,
      linkedVia: scimWriter ? 'scim' : 'jit',
      // The instant sign-in uses the identity right now; an approval does not.
      ...(input.writer === 'sso_instant' ? { lastUsedAt: input.now } : {}),
      ...(scimWriter && input.scim ? {
        scimUserName: input.scim.userName,
        scimDisplayName: input.scim.displayName,
        scimGivenName: input.scim.givenName,
        scimFamilyName: input.scim.familyName,
        scimProvisionedAt: input.now,
      } : {}),
      // SCIM created the person inactive: the identity carries SCIM's blocker
      // from the start (W8 D1 shape), matching the login's disabled_by 'scim'.
      ...(input.writer === 'scim_provision_inactive' ? {
        disabledAt: input.now,
        disabledReason: 'scim_deactivated' as const,
        disabledBlockers: ['scim' as const],
      } : {}),
    })
    .onConflictDoNothing()
    .returning({ id: portalUserIdentities.id });
  if (!identity) return { kind: 'identity_linked' };

  return { kind: 'created', portalUserId: created.id, authEpoch: created.authEpoch, identityId: identity.id };
}
