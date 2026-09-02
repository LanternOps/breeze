import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { portalUsers } from '../../db/schema/portal';

/**
 * Create (or reuse) a password-less portal-user contact for the Outlook tech
 * add-in's "create contact" requester option (spec §3.2, Task 16).
 *
 * Deliberately NOT `inboundEmail/resolveOrg.resolveEmailRequester` (formerly
 * `findOrCreateEmailContact`): that one is an ingest side-effect on the poller
 * path, where contact creation is an automatic consequence of a message
 * arriving. Here it is a TECHNICIAN-CONFIRMED action inside a request — the
 * tech explicitly chose "create a contact for this sender" in the pane — so it
 * lives on the add-in's own service surface and can evolve (audit, contact
 * linkage) without changing ingest behaviour.
 *
 * KNOWN GAP (#3258 W03, deliberately out of scope): this path still creates a
 * contact-less `portal_users` row, so an add-in-confirmed requester has a login
 * with no `contacts` row behind it. Same for the Entra SSO provisioning in
 * `clientAiExchange.ts`. Repointing both is follow-up work.
 *
 * Runs in-request, so it executes under the caller's partner-scope RLS context
 * (the middleware's transaction). A null `passwordHash` is inherently non-login,
 * matching the Entra and inbound password-less rows.
 *
 * `portal_users` has no (org_id, email) unique index, so the select-then-insert
 * is not atomic. The pre-check is a convenience that keeps a technician who
 * clicks twice from minting two rows; a genuine concurrent double-create yields
 * a benign duplicate in the same org (identical to the ingest path's tolerance).
 */
export async function createConfirmedContact(
  orgId: string,
  input: { email: string; name?: string | null }
): Promise<{ portalUserId: string }> {
  const email = input.email.trim().toLowerCase();

  const existing = await db
    .select({ id: portalUsers.id })
    .from(portalUsers)
    .where(and(eq(portalUsers.orgId, orgId), eq(portalUsers.email, email)))
    .limit(1);
  if (existing[0]) return { portalUserId: existing[0].id };

  const inserted = await db
    .insert(portalUsers)
    .values({
      orgId,
      email,
      name: input.name ?? null,
      passwordHash: null,
      authMethod: 'password',
      status: 'active',
    })
    .returning({ id: portalUsers.id });

  const row = inserted[0];
  if (!row) throw new Error('failed to create add-in contact');
  return { portalUserId: row.id };
}

/**
 * Look up (never create) the portal user a sender address resolves to within
 * ONE org, for Task 17's link-email route. Mirrors
 * `inboundEmailService.findPortalUserInPartner` but org-scoped (the caller
 * already has the target ticket's org) rather than partner-scoped, and read-only
 * — linking an email to an existing ticket is not licensed to mint a contact,
 * unlike `createConfirmedContact` above which is a technician-confirmed action.
 */
export async function findPortalUserByEmail(
  orgId: string,
  email: string
): Promise<{ id: string; name: string | null } | null> {
  const lower = email.trim().toLowerCase();
  const rows = await db
    .select({ id: portalUsers.id, name: portalUsers.name })
    .from(portalUsers)
    .where(and(eq(portalUsers.orgId, orgId), eq(portalUsers.email, lower)))
    .limit(1);
  return rows[0] ?? null;
}
