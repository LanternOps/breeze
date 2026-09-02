import { and, eq, sql } from 'drizzle-orm';
import { contacts } from '../../db/schema/contacts';
import { INBOUND_CONTACT_LOCK_NAMESPACE } from '../inboundEmail/resolveOrg';
import {
  createContact,
  normalizeContactEmail,
  updateContact,
  type ContactActor,
  type ContactExecutor,
} from './crud';

/**
 * How a LOGIN resolved to the org's CONTACT for its address (#3258).
 *
 *  - `linked`           — the org already had exactly one contact there.
 *  - `created`          — it had none, so one was created with the portal role.
 *  - `ambiguous`        — several contacts share the address (a shared mailbox);
 *                         we declined to guess, so the login stays UNLINKED.
 *  - `unusable-address` — the login carries nothing that could identify a person.
 *
 * Recorded by every caller in its own audit/log line, because a null
 * `contact_id` is not self-explaining after the fact: an unlinked login cannot
 * see the tickets that address emailed in (routes/portal/ticketOwnership.ts),
 * and only the outcome says whether that was a refusal or an absence.
 */
export type LoginContactOutcome = 'linked' | 'created' | 'ambiguous' | 'unusable-address';

export interface LinkLoginToContactInput {
  /** The LOGIN's own org. Never re-derived from the address — see the tenancy note below. */
  orgId: string;
  email: string | null | undefined;
  /** Display name for a contact this has to create. Null when the source has none. */
  name?: string | null;
  /** The acting Breeze user, or `{ userId: null }` for a self-provisioning login. */
  actor: ContactActor;
}

export interface LinkLoginToContactResult {
  contactId: string | null;
  outcome: LoginContactOutcome;
}

/**
 * Bind a portal LOGIN to the org's CONTACT for its address, creating the
 * contact when the org has none.
 *
 * `contacts` is the person and `portal_users` is a login attached to one
 * (#3258). Every path that mints a login must therefore resolve the person too:
 * a login with `contact_id` null cannot see the tickets its own address emailed
 * in, because `portalTicketOwnership` matches on the contact, not the login.
 *
 * ── Tenancy ─────────────────────────────────────────────────────────────────
 * `orgId` is the LOGIN'S OWN org and is never re-derived from the address here.
 * That keeps every link org-bounded by construction, which is what the
 * same-org composite FK on `portal_users.contact_id` requires — the existing
 * single-column FK cannot prove it, so the call sites must.
 *
 * ── Concurrency ─────────────────────────────────────────────────────────────
 * The check-then-insert is not atomic and `contacts_org_email_idx` is
 * deliberately NON-unique (shared mailboxes are real), so the database will not
 * stop two callers each creating a contact for the same new address. The
 * advisory lock is taken FIRST, in the SAME namespace and on the SAME
 * (org, address) key inbound email uses, so an invite, a first email, an Entra
 * first-login and an add-in requester all serialise against each other.
 * Transaction-scoped: every caller runs inside `withDbAccessContext`, which IS
 * a transaction, so the lock is held to the end of that request/job and
 * released with it.
 *
 * ── Why not `matchContactByEmail` ───────────────────────────────────────────
 * That helper returns only an id and pins it with `FOR KEY SHARE` for callers
 * about to write a `tickets.requester_contact_id` FK. This one needs the
 * contact's `roles` to union the grant into, and issues exactly ONE read. The
 * two are deliberately separate readings of the same index.
 */
export async function linkLoginToContact(
  exec: ContactExecutor,
  input: LinkLoginToContactInput,
): Promise<LinkLoginToContactResult> {
  const normalized = normalizeContactEmail(input.email);
  // Bail BEFORE the lock: locking on `<org>:` would serialise every
  // address-less login in the org against each other for the rest of the
  // transaction, and there is nothing to look up anyway.
  if (!normalized) return { contactId: null, outcome: 'unusable-address' };

  await exec.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${INBOUND_CONTACT_LOCK_NAMESPACE}), hashtext(${`${input.orgId}:${normalized}`}))`,
  );

  // limit(2) is all the arithmetic this needs: two rows means "at least two".
  const found = await exec
    .select({ id: contacts.id, roles: contacts.roles })
    .from(contacts)
    .where(and(eq(contacts.orgId, input.orgId), sql`lower(${contacts.email}) = ${normalized}`))
    .limit(2);

  // Several contacts on one address is a supported state, and there is no
  // honest way to pick one: picking by display name keys attribution off a
  // header the sender controls, and picking oldest or newest is a coin flip
  // wearing a rule. Leaving it unlinked is visible; guessing wrong hands one
  // person's ticket history to another.
  if (found.length > 1) return { contactId: null, outcome: 'ambiguous' };

  if (found.length === 1) {
    const existing = found[0] as { id: string; roles: string[] | null };
    // A UNION, never a replace: an existing billing/technical contact does not
    // stop being one because someone gave them a login. Skipped when the role
    // is already there, so a repeat login writes nothing (and does not churn
    // `updated_at`).
    const roles = existing.roles ?? [];
    if (!roles.includes('portal')) {
      await updateContact(exec, existing.id, input.orgId, { roles: [...roles, 'portal'] }, input.actor);
    }
    return { contactId: existing.id, outcome: 'linked' };
  }

  const created = await createContact(
    exec,
    { orgId: input.orgId, email: normalized, name: input.name ?? null, roles: ['portal'] },
    input.actor,
  );
  return { contactId: created.id, outcome: 'created' };
}
