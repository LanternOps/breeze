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
  /**
   * Roles stamped on a contact this CREATES. Defaults to `['portal']`.
   *
   * Pass `[]` from a path that grants no portal access — a contact's roles
   * describe what the org has actually given the person, and the add-in's
   * ticket requester has been given nothing (inbound email uses `[]` for the
   * same reason).
   */
  roles?: string[];
  /**
   * Roles UNIONED onto a contact that already exists. Defaults to `roles`.
   *
   * An EMPTY list means "never write to the existing contact", which is what a
   * caller holding only `tickets:write` must pass: filing a ticket is not
   * licence to mutate the customer's contact record.
   */
  unionRoles?: string[];
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
 * That keeps every link org-bounded by construction. `portal_users.contact_id`
 * carries only a SINGLE-COLUMN FK today, which cannot prove same-org on its own
 * (#4593 makes it composite); until then this rule is the only thing that does,
 * so no caller may pass an org derived from the address.
 *
 * Callers run under a bounded DB context, but not all the same one: the invite
 * and add-in paths are in the caller's request context (`withDbAccessContext`,
 * partner scope, RLS enforced), while the Entra exchange runs under
 * `withSystemDbAccessContext` — RLS bypassed, bounded instead by the fact that
 * `orgId` is server-derived from the `client_ai_tenant_mappings` row for the
 * token's tenant and never from anything the caller sent.
 *
 * ── Concurrency ─────────────────────────────────────────────────────────────
 * The check-then-insert is not atomic and `contacts_org_email_idx` is
 * deliberately NON-unique (shared mailboxes are real), so the database will not
 * stop two callers each creating a contact for the same new address. The
 * advisory lock is taken FIRST, in the SAME namespace and on the SAME
 * (org, address) key inbound email uses, so an invite, a first email, an Entra
 * first-login and an add-in requester all serialise against each other.
 * Transaction-scoped: every context helper opens a transaction, so the lock is
 * held to the end of that request/job and released with it.
 *
 * That lock serialises CREATORS of an address. It does nothing about a
 * concurrent `deleteContact` of a row we matched — and every caller writes an
 * FK to that row next, so a deleted row would surface as a raw 23503 instead of
 * an outcome. The matched row is therefore pinned with `FOR KEY SHARE` in the
 * SAME statement as the read, which leaves no window between observing it and
 * holding it. The pin lasts until the caller's transaction ends, which is after
 * the FK write in every path.
 *
 * ── Why not `matchContactByEmail` ───────────────────────────────────────────
 * That helper returns only an id, and pins with a SECOND round trip. This one
 * needs the contact's `roles` to union into, and does the read and the pin in
 * one statement. The two are deliberately separate readings of the same index.
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
  // `FOR KEY SHARE` pins whatever is returned for the rest of the transaction —
  // see the concurrency note above. It is the weakest row lock that still
  // blocks a DELETE, so it never contends with ordinary contact edits.
  const found = await exec
    .select({ id: contacts.id, roles: contacts.roles })
    .from(contacts)
    .where(and(eq(contacts.orgId, input.orgId), sql`lower(${contacts.email}) = ${normalized}`))
    .for('key share')
    .limit(2);

  // Several contacts on one address is a supported state, and there is no
  // honest way to pick one: picking by display name keys attribution off a
  // header the sender controls, and picking oldest or newest is a coin flip
  // wearing a rule. Leaving it unlinked is visible; guessing wrong hands one
  // person's ticket history to another.
  if (found.length > 1) return { contactId: null, outcome: 'ambiguous' };

  const createRoles = input.roles ?? ['portal'];
  const unionRoles = input.unionRoles ?? createRoles;

  if (found.length === 1) {
    const existing = found[0] as { id: string; roles: string[] | null };
    // A UNION, never a replace: an existing billing/technical contact does not
    // stop being one because someone gave them a login.
    const roles = existing.roles ?? [];
    const missing = unionRoles.filter((role) => !roles.includes(role));
    // The short-circuit is load-bearing, not an optimisation. `updateContact`
    // runs the primary-contact re-projection chain (lockProjectionScopes ->
    // reprojectPrimaryContact -> replaceBillingContact, which updates
    // `organizations` by bare id per the warning in contacts/compat.ts), and on
    // the Entra path that chain is reachable from the UNAUTHENTICATED
    // /client-ai/auth/exchange under a system context whenever the matched
    // contact happens to be the org's primary. Writing only when a role is
    // genuinely missing makes it at most once per contact and idempotent
    // thereafter, so a token replayed in a loop cannot drive repeated org-row
    // writes. An empty `unionRoles` skips it outright.
    if (missing.length > 0) {
      await updateContact(exec, existing.id, input.orgId, { roles: [...roles, ...missing] }, input.actor);
    }
    return { contactId: existing.id, outcome: 'linked' };
  }

  const created = await createContact(
    exec,
    { orgId: input.orgId, email: normalized, name: input.name ?? null, roles: createRoles },
    input.actor,
  );
  return { contactId: created.id, outcome: 'created' };
}
