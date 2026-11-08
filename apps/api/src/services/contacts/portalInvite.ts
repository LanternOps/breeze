/**
 * Invite a CONTACT to the customer portal (portal registration W1, #11378).
 *
 * The MSP names the contact, so the login binds to THAT contact directly: no
 * address lookup, no `ambiguous`. Binding a contact grants its ticket history
 * (routes/portal/ticketOwnership.ts), which is why every refusal below writes
 * nothing and an existing binding is never replaced (spec §5.5: the MSP
 * unbinds first).
 *
 * Two parts:
 *  - `planContactInvite` — pure: given the org's logins that touch this
 *    contact or address, decide create / reuse / refuse.
 *  - `bindContactLoginForInvite` — locked: take the same advisory lock every
 *    other creator of this address takes, re-read under it, plan, and write
 *    only for create/reuse.
 *
 * Callers run it inside `withDbTransaction` (a savepoint) with their catch
 * outside, so a `ContactGoneError` rolls back every bind in a batch.
 *
 * W2 (#11379) routes every `status` writer through a state module. The two
 * writes here (`status: 'invited'`) are on that census.
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { AlreadyHasAccessReason } from '@breeze/shared';
import { contacts } from '../../db/schema/contacts';
import { portalUsers } from '../../db/schema';
import { INBOUND_CONTACT_LOCK_NAMESPACE } from '../inboundEmail/resolveOrg';
import { normalizeContactEmail, updateContact, type ContactExecutor } from './crud';

export interface InviteableContact {
  id: string;
  orgId: string;
  siteId: string | null;
  name: string | null;
  email: string | null;
}

/**
 * The org's contacts among `contactIds`. Always bounded by `(org_id, id)`
 * together: a contact id alone is never trusted, because a sibling org of the
 * same partner is visible under RLS.
 */
export async function loadOrgContactsForPortalInvite(
  exec: ContactExecutor,
  orgId: string,
  contactIds: readonly string[],
): Promise<InviteableContact[]> {
  if (contactIds.length === 0) return [];
  return exec
    .select({ id: contacts.id, orgId: contacts.orgId, siteId: contacts.siteId, name: contacts.name, email: contacts.email })
    .from(contacts)
    .where(and(eq(contacts.orgId, orgId), inArray(contacts.id, [...contactIds])));
}

export interface InviteLoginCandidate {
  id: string;
  email: string;
  contactId: string | null;
  authMethod: string;
  status: string;
  passwordHash: string | null;
  createdAt: Date;
}

export type InvitePlan =
  | { action: 'create' }
  | { action: 'reuse'; login: InviteLoginCandidate; contactLink: 'kept' | 'direct' }
  | { action: 'has_access'; login: InviteLoginCandidate; reason: AlreadyHasAccessReason }
  | { action: 'conflict'; login: InviteLoginCandidate };

const isActiveWithPassword = (l: InviteLoginCandidate) => Boolean(l.passwordHash) && l.status === 'active';

/** active-with-password (0) → pending (1) → disabled (2). */
function accessRank(l: InviteLoginCandidate): number {
  if (l.status === 'disabled') return 2;
  if (isActiveWithPassword(l)) return 0;
  return 1;
}

const newestFirst = (a: InviteLoginCandidate, b: InviteLoginCandidate) => b.createdAt.getTime() - a.createdAt.getTime();

/**
 * Decide what inviting `contactId` at `normalizedEmail` does, given every
 * login in the org bound to that contact or holding that address.
 *
 * Only password-method logins can be (re)invited. An external-identity row
 * (AI for Office / Entra) is reported, never paired with a new password row:
 * browser access for those users is W2/W3's call.
 */
export function planContactInvite(
  contactId: string,
  normalizedEmail: string,
  candidates: InviteLoginCandidate[],
): InvitePlan {
  const sameAddress = (l: InviteLoginCandidate) => l.email.trim().toLowerCase() === normalizedEmail;
  const password = candidates.filter((l) => l.authMethod === 'password');
  const external = candidates.filter((l) => l.authMethod !== 'password');

  // 1. A login already bound to this contact decides, whatever its address.
  const bound = password
    .filter((l) => l.contactId === contactId)
    .sort((a, b) => accessRank(a) - accessRank(b) || newestFirst(a, b));
  const own = bound[0];
  if (own) {
    if (own.status === 'disabled') return { action: 'has_access', login: own, reason: 'disabled' };
    if (isActiveWithPassword(own)) return { action: 'has_access', login: own, reason: 'active' };
    // The contact's email was edited after the bind. Re-inviting would mail
    // the OLD address a link into this contact's history; refuse instead.
    if (!sameAddress(own)) return { action: 'has_access', login: own, reason: 'login_email_differs' };
    return { action: 'reuse', login: own, contactLink: 'kept' };
  }

  // 2. The address belongs to a login bound to someone else: never re-point it.
  const other = password.find((l) => sameAddress(l) && l.contactId !== null && l.contactId !== contactId);
  if (other) return { action: 'conflict', login: other };

  // 3. An unbound login with this address: bind it, unless it already has access.
  const unbound = password.filter((l) => sameAddress(l) && l.contactId === null).sort(newestFirst)[0];
  if (unbound) {
    if (unbound.status === 'disabled') return { action: 'has_access', login: unbound, reason: 'disabled' };
    // A refusal writes nothing, so an active login is reported, not bound.
    if (isActiveWithPassword(unbound)) return { action: 'has_access', login: unbound, reason: 'active' };
    return { action: 'reuse', login: unbound, contactLink: 'direct' };
  }

  // 4. Only an external identity holds this contact or address.
  const ext = [...external].sort(newestFirst)[0];
  if (ext) return { action: 'has_access', login: ext, reason: 'external_identity' };

  return { action: 'create' };
}

export type ContactInviteDecision =
  | { kind: 'invite'; portalUserId: string; email: string; created: boolean; contactLink: 'kept' | 'direct' }
  | { kind: 'already_has_access'; portalUserId: string; reason: AlreadyHasAccessReason }
  | { kind: 'email_bound_to_other_contact'; portalUserId: string };

/** The contact was deleted (or moved out of the org) after it was loaded. */
export class ContactGoneError extends Error {
  constructor() {
    super('Contact not found');
    this.name = 'ContactGoneError';
  }
}

/**
 * The contact's email changed after it was loaded, so the invite address no
 * longer equals it. Binding anyway would hand the contact's history to an
 * address the MSP did not pick.
 */
export class ContactEmailChangedError extends Error {
  constructor() {
    super('Contact email changed');
    this.name = 'ContactEmailChangedError';
  }
}

/**
 * Take the per-address advisory lock for each distinct address, in sorted
 * order. The key and namespace are the ones `linkLoginToContact` and inbound
 * email use, so an invite serialises against every other creator of the
 * address. A batch calls this up front: one global order means two
 * overlapping batches cannot deadlock on each other, and no batch holds an
 * organization row lock (taken by the role union) while waiting for an
 * address. Re-taking a held advisory lock in the same transaction is a no-op.
 */
export async function lockPortalInviteAddresses(
  exec: ContactExecutor,
  orgId: string,
  normalizedEmails: readonly string[],
): Promise<void> {
  const distinct = [...new Set(normalizedEmails)].sort();
  for (const email of distinct) {
    await exec.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${INBOUND_CONTACT_LOCK_NAMESPACE}), hashtext(${`${orgId}:${email}`}))`,
    );
  }
}

export interface BindContactLoginInput {
  orgId: string;
  contact: InviteableContact;
  /** `normalizeContactEmail(contact.email)`, already checked equal to the invite address. */
  normalizedEmail: string;
  /** Name the MSP typed, if any. */
  name: string | null;
  actor: { userId: string };
  now: Date;
}

export async function bindContactLoginForInvite(
  exec: ContactExecutor,
  input: BindContactLoginInput,
): Promise<ContactInviteDecision> {
  const { orgId, contact, normalizedEmail, actor, now } = input;

  await lockPortalInviteAddresses(exec, orgId, [normalizedEmail]);

  // Pin the contact for the rest of the transaction: the login row written
  // below carries an FK to it, and a concurrent delete would otherwise turn
  // that write into a raw 23503.
  const [locked] = await exec
    .select({ id: contacts.id, email: contacts.email, roles: contacts.roles })
    .from(contacts)
    .where(and(eq(contacts.id, contact.id), eq(contacts.orgId, orgId)))
    .for('key share')
    .limit(1);
  if (!locked) throw new ContactGoneError();
  if (normalizeContactEmail(locked.email) !== normalizedEmail) throw new ContactEmailChangedError();

  const candidates: InviteLoginCandidate[] = await exec
    .select({
      id: portalUsers.id,
      email: portalUsers.email,
      contactId: portalUsers.contactId,
      authMethod: portalUsers.authMethod,
      status: portalUsers.status,
      passwordHash: portalUsers.passwordHash,
      createdAt: portalUsers.createdAt,
    })
    .from(portalUsers)
    .where(and(
      eq(portalUsers.orgId, orgId),
      or(eq(portalUsers.contactId, contact.id), sql`lower(${portalUsers.email}) = ${normalizedEmail}`),
    ));

  const plan = planContactInvite(contact.id, normalizedEmail, candidates);
  if (plan.action === 'has_access') {
    return { kind: 'already_has_access', portalUserId: plan.login.id, reason: plan.reason };
  }
  if (plan.action === 'conflict') {
    return { kind: 'email_bound_to_other_contact', portalUserId: plan.login.id };
  }

  let decision: ContactInviteDecision;
  if (plan.action === 'reuse') {
    await exec
      .update(portalUsers)
      .set({
        name: input.name ?? undefined,
        status: 'invited',
        authEpoch: sql`${portalUsers.authEpoch} + 1`,
        invitedBy: actor.userId,
        invitedAt: now,
        updatedAt: now,
        contactId: contact.id,
      })
      .where(and(eq(portalUsers.id, plan.login.id), eq(portalUsers.orgId, orgId)))
      .returning({ id: portalUsers.id });
    decision = { kind: 'invite', portalUserId: plan.login.id, email: plan.login.email, created: false, contactLink: plan.contactLink };
  } else {
    const [created] = await exec
      .insert(portalUsers)
      .values({
        orgId,
        email: normalizedEmail,
        name: input.name ?? contact.name,
        passwordHash: null,
        authMethod: 'password',
        status: 'invited',
        invitedBy: actor.userId,
        invitedAt: now,
        contactId: contact.id,
      })
      .returning({ id: portalUsers.id });
    decision = { kind: 'invite', portalUserId: created!.id, email: normalizedEmail, created: true, contactLink: 'direct' };
  }

  // A UNION, never a replace, and only when missing: `updateContact` locks the
  // organization row for an org-level contact (see loginLink.ts), so an
  // idempotent re-invite must not write.
  const roles = locked.roles ?? [];
  if (!roles.includes('portal')) {
    await updateContact(exec, contact.id, orgId, { roles: [...roles, 'portal'] }, actor);
  }
  return decision;
}
