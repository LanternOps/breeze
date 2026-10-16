import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { contacts } from '../../db/schema/contacts';
import { contactRoles } from '../../db/schema/contactRoles';
import { organizations, sites } from '../../db/schema/orgs';
import { recordDestinationChangeWithExecutor } from '../callerVerification/destinations';
import { reconcileLegacyContactResponsibilities } from './responsibilities';

/**
 * Dual-write bridge between the `contacts` table and the legacy
 * `organizations.billing_contact` / `sites.contact` jsonb columns (#3258).
 *
 * ── Why the jsonb columns are not going away ────────────────────────────────
 * They are NOT a deprecated shim awaiting a drop migration. Three shipped
 * contracts depend on `sites.contact` continuing to exist under that name:
 *
 *   1. `breeze_partner_export_sites_update()` detects change with a hardcoded
 *      tuple that reads `old_row.contact` / `new_row.contact`
 *      (2026-07-18-partner-export-org-locks.sql:279-284). Move the data out
 *      and a contact-only edit silently stops bumping
 *      `sites.partner_export_updated_at`, so partner-API consumers polling the
 *      sites cursor never observe it.
 *   2. `partnerSiteContactSchema` is a `.strict()` PUBLIC partner-API DTO
 *      (routes/partnerApi/schemas.ts) and export records are content-hashed,
 *      so changing the emitted shape re-hashes every site record and forces a
 *      full re-sync across every partner consumer.
 *   3. `organizations.billing_contact` is deliberately EXCLUDED from the
 *      partner API (negative regression test in
 *      routes/partnerApi/organizations.test.ts) while `sites.contact` is
 *      included. A single table cannot express that asymmetry; the two jsonb
 *      columns keep expressing it.
 *
 * So this module is the ONLY writer of either representation, and it keeps
 * them in step forever rather than temporarily.
 *
 * ── Two different projections ──────────────────────────────────────────────
 * `sites.contact` projects the SITE's primary contact. `organizations.billing_contact`
 * projects the org's BILLING contact — the org-level contact holding the
 * `billing` role (see `billingContactOrder` for the tiebreak) — and NOT the
 * org's primary contact. Invoices, quotes and the accounting sync read their
 * recipient from that column (`resolveBillingEmail`), so tying it to
 * `is_primary` meant that making a technical contact primary, or saving the
 * Billing tab, re-pointed or rewrote the wrong person. When no org-level
 * contact holds the role the column is null: there is no fallback to the
 * primary contact, because a fallback couples "who is the headline contact"
 * back to "who receives invoices" and makes unassigning the role a no-op
 * whenever the same person is both.
 *
 * The billing entry points below EDIT that billing contact (creating one when
 * none exists) and never touch any other contact. Clearing every field
 * unassigns the `billing` role and leaves the row — a real person with
 * tickets, portal logins and external links — exactly as it was.
 */

export type ContactExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The shape both legacy jsonb columns hold: `{name?, email?, phone?}`. */
export interface ContactBlob {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}

type ContactFields = { name: string | null; email: string | null; phone: string | null };

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Read a legacy blob defensively. `organizations.billing_contact` is validated
 * with `z.any()` on the org routes, so the column can legally hold a string, a
 * number, or an array — not just an object.
 */
export function readContactBlob(value: unknown): ContactFields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { name: null, email: null, phone: null };
  }
  const record = value as Record<string, unknown>;
  return { name: clean(record.name), email: clean(record.email), phone: clean(record.phone) };
}

function isEmpty(fields: ContactFields): boolean {
  return fields.name === null && fields.email === null && fields.phone === null;
}

/**
 * Apply a patch to a SITE's primary contact row.
 *
 * `undefined` leaves a field alone; `null` clears it. When the result carries
 * no identifying field at all the row is DELETED rather than updated —
 * `contacts_identifiable_chk` forbids a wholly empty contact, and "the user
 * cleared the last field" has to mean "there is no contact" rather than a
 * constraint violation.
 *
 * Site scope only. The organization's `billing_contact` goes through
 * `applyToBillingContact`, which never deletes and never targets the primary.
 */
async function applyToSiteContactRow(
  exec: ContactExecutor,
  params: {
    orgId: string;
    siteId: string;
    patch: ContactBlob;
    replace: boolean;
    actorId?: string | null;
  },
): Promise<void> {
  const { orgId, siteId, patch, replace, actorId } = params;

  // `mobile` is selected but never patched: the legacy blob has no key for it,
  // so it can only ever have been set by a path that writes `contacts`
  // directly. It still has to be read, because it decides whether a row with
  // no name/email/phone left is empty — see the delete guard below.
  const [existing] = await exec
    .select({
      id: contacts.id,
      name: contacts.name,
      email: contacts.email,
      phone: contacts.phone,
      mobile: contacts.mobile,
    })
    .from(contacts)
    .where(and(eq(contacts.siteId, siteId), eq(contacts.isPrimary, true)))
    .limit(1);

  const base: ContactFields = replace || !existing
    ? { name: null, email: null, phone: null }
    : { name: existing.name, email: existing.email, phone: existing.phone };

  const next: ContactFields = {
    name: patch.name === undefined ? base.name : clean(patch.name),
    email: patch.email === undefined ? base.email : clean(patch.email),
    phone: patch.phone === undefined ? base.phone : clean(patch.phone),
  };

  // "No identifying field left" has to be judged against contacts_identifiable_chk,
  // which accepts `mobile` alone — NOT against the three fields the blob models.
  // A mobile-only contact is legal and invisible to the blob, so deleting on
  // isEmpty(next) alone would destroy it (and cascade contact_external_links,
  // taking the re-import identity key with it). When mobile survives, fall
  // through and clear the three modelled fields instead.
  if (isEmpty(next) && (existing?.mobile ?? null) === null) {
    if (existing) await exec.delete(contacts).where(eq(contacts.id, existing.id));
    return;
  }

  if (existing) {
    await exec
      .update(contacts)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(contacts.id, existing.id));
    await recordDestinationChangeWithExecutor(exec, {
      orgId, contactId: existing.id, kind: 'email', value: next.email, source: 'technician', userId: actorId ?? null,
    });
    return;
  }

  const [created] = await exec.insert(contacts).values({
    orgId,
    siteId,
    ...next,
    roles: ['site'],
    isPrimary: true,
    createdBy: actorId ?? null,
  }).returning({ id: contacts.id, siteId: contacts.siteId, roles: contacts.roles });
  await reconcileLegacyContactResponsibilities(exec, {
    contactId: created!.id, orgId, siteId: created!.siteId, roles: created!.roles,
  });
  await recordDestinationChangeWithExecutor(exec, {
    orgId, contactId: created!.id, kind: 'email', value: next.email, source: 'technician', userId: actorId ?? null,
  });
}

// ── The organization's billing contact ─────────────────────────────────────

export const BILLING_ROLE = 'billing';

/** Emails are stored lower-cased, matching `crud.normalizeContactEmail` and `contacts_org_email_idx`. */
function cleanEmail(value: unknown): string | null {
  const cleaned = clean(value);
  return cleaned === null ? null : cleaned.toLowerCase();
}

/** Org-level contacts holding the `billing` role — the only rows the billing path may touch. */
function billingContactWhere(orgId: string): SQL {
  return and(
    eq(contacts.orgId, orgId),
    sql`EXISTS (
      SELECT 1 FROM ${contactRoles}
      WHERE ${contactRoles.contactId} = ${contacts.id}
        AND ${contactRoles.orgId} = ${contacts.orgId}
        AND ${contactRoles.role} = ${BILLING_ROLE}
        AND ${contactRoles.siteId} IS NULL
        AND ${contactRoles.deviceGroupId} IS NULL
    )`,
  )!;
}

/**
 * Which billing-role contact is THE billing contact when several hold the role:
 *   1. the org's primary contact, if it holds the role;
 *   2. the contact invoices already go to — identified by the `contactId` the
 *      projection stores, so editing that contact's own email does not hand
 *      the recipient to someone else, and granting the role to a second,
 *      older contact (or an org merge bringing one in) never silently
 *      re-points invoices;
 *   3. for a column written before `contactId` existed, the contact whose
 *      email matches it;
 *   4. the oldest, then `id`, so the order is total.
 *
 * Shared by the projection and by the billing entry points, so the contact the
 * Billing setting edits is always the one invoices are sent to. Both read the
 * column, so a caller must not write a request's value into it first.
 *
 * `keepContactId` names a contact the caller KNOWS was the recipient before its
 * write (read with `currentBillingContactId` beforehand). It ranks with the
 * incumbent, for the one case the stored column cannot answer: a column that
 * predates `contactId` identifies its contact by email, and this write just
 * changed that contact's email.
 */
function billingContactOrder(orgId: string, keepContactId?: string | null): SQL[] {
  const current = (key: string) =>
    sql`(SELECT ${organizations.billingContact} ->> ${key} FROM ${organizations} WHERE ${organizations.id} = ${orgId})`;
  const storedIncumbent = sql`COALESCE(${contacts.id}::text = ${current('contactId')}, false)`;
  const incumbent = keepContactId
    ? sql`(${contacts.id} = ${keepContactId} OR ${storedIncumbent})`
    : storedIncumbent;
  const legacyIncumbent = sql`COALESCE(lower(${contacts.email}) = lower(${current('email')}), false)`;
  return [desc(contacts.isPrimary), desc(incumbent), desc(legacyIncumbent), asc(contacts.createdAt), asc(contacts.id)];
}

/**
 * The id of the org's billing contact as things stand — read BEFORE a write
 * that may change that contact's email, and handed back to
 * `projectBillingContact` as `keepContactId`.
 */
export async function currentBillingContactId(exec: ContactExecutor, orgId: string): Promise<string | null> {
  const [row] = await exec
    .select({ id: contacts.id })
    .from(contacts)
    .where(billingContactWhere(orgId))
    .orderBy(...billingContactOrder(orgId))
    .limit(1);
  return (row as { id: string } | undefined)?.id ?? null;
}

/**
 * Parent-first lock on the organization row — the order every writer that
 * re-projects `organizations.billing_contact` takes (see crud.ts
 * `lockProjectionScopes` for the #3911 deadlock it closes).
 */
export async function lockOrganizationForProjection(exec: ContactExecutor, orgId: string): Promise<void> {
  await exec
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .for('no key update');
}

/**
 * What `organizations.billing_contact` holds: the billing contact's modelled
 * fields plus its id, which is what keeps it the billing contact across its own
 * edits (see `billingContactOrder`). Readers use `email`/`name` only.
 */
export interface BillingContactProjection {
  contactId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
}

/**
 * Re-derive `organizations.billing_contact` from the org's billing contact, or
 * write null when no org-level contact holds the `billing` role.
 *
 * ONE-WAY: reads `contacts`, writes only the jsonb column. It never writes a
 * contact row, so a re-projection can never edit, unassign or delete anyone.
 * Returns the blob it wrote. The caller must already hold the organization
 * row lock (`lockOrganizationForProjection`, or an UPDATE of that row).
 */
export async function projectBillingContact(
  exec: ContactExecutor,
  orgId: string,
  options: { keepContactId?: string | null } = {},
): Promise<BillingContactProjection | null> {
  const [billing] = await exec
    .select({ id: contacts.id, name: contacts.name, email: contacts.email, phone: contacts.phone })
    .from(contacts)
    .where(billingContactWhere(orgId))
    .orderBy(...billingContactOrder(orgId, options.keepContactId))
    .limit(1);

  // A mobile-only contact has nothing the three-key blob can model. Write null
  // rather than an all-null object so the column keeps meaning "no contact"
  // instead of "an empty one".
  const blob: BillingContactProjection | null = billing && (billing.name !== null || billing.email !== null || billing.phone !== null)
    ? { contactId: billing.id, name: billing.name, email: billing.email, phone: billing.phone }
    : null;

  await exec
    .update(organizations)
    .set({ billingContact: blob as never })
    .where(eq(organizations.id, orgId));
  return blob;
}

/**
 * Apply a patch to the org's BILLING contact — never to any other contact.
 *
 *  - A billing contact exists: its name/email/phone take the patch (merge or
 *    whole-blob replace).
 *  - None exists: a new org-level contact is created with the `billing` role.
 *    It is the primary contact only when the org has no primary yet (org
 *    create / import parity); otherwise the incumbent primary is left alone.
 *  - "No billing contact": the billing contact's `billing` role is removed and
 *    NOTHING else about the row changes. Never a DELETE and never a field
 *    wipe — the row is a person who can carry tickets, portal logins, other
 *    roles, a mobile number or the re-import identity in
 *    `contact_external_links`. What counts as "no billing contact" depends on
 *    the entry point: a whole-blob REPLACE with no name, email or phone; or a
 *    MERGE that sets the email to null ("no recipient" — the billing-settings
 *    field is the address invoices go to, not the person's address book
 *    entry) or leaves nothing identifying.
 */
async function applyToBillingContact(
  exec: ContactExecutor,
  params: { orgId: string; patch: ContactBlob; replace: boolean; actorId?: string | null },
): Promise<string | null> {
  const { orgId, patch, replace, actorId } = params;

  const [existing] = await exec
    .select({ id: contacts.id, name: contacts.name, email: contacts.email, phone: contacts.phone })
    .from(contacts)
    .where(billingContactWhere(orgId))
    .orderBy(...billingContactOrder(orgId))
    .limit(1);

  const base: ContactFields = replace || !existing
    ? { name: null, email: null, phone: null }
    : { name: existing.name, email: existing.email, phone: existing.phone };

  const next: ContactFields = {
    name: patch.name === undefined ? base.name : clean(patch.name),
    email: patch.email === undefined ? base.email : cleanEmail(patch.email),
    phone: patch.phone === undefined ? base.phone : clean(patch.phone),
  };

  const unassign = isEmpty(next) || (!replace && patch.email === null);
  if (unassign) {
    if (existing) {
      const [updated] = await exec
        .update(contacts)
        .set({ roles: sql`array_remove(${contacts.roles}, ${BILLING_ROLE})`, updatedAt: new Date() })
        .where(and(eq(contacts.id, existing.id), eq(contacts.orgId, orgId)))
        .returning({ id: contacts.id, siteId: contacts.siteId, roles: contacts.roles });
      if (updated) {
        await reconcileLegacyContactResponsibilities(exec, {
          contactId: updated.id, orgId, siteId: updated.siteId, roles: updated.roles,
        });
      }
    }
    return null;
  }

  if (existing) {
    await exec
      .update(contacts)
      .set({ ...next, updatedAt: new Date() })
      .where(and(eq(contacts.id, existing.id), eq(contacts.orgId, orgId)));
    await recordDestinationChangeWithExecutor(exec, {
      orgId, contactId: existing.id, kind: 'email', value: next.email, source: 'technician', userId: actorId ?? null,
    });
    // `existing` was chosen by the same order the projection uses, so it IS the
    // current recipient — keep it one even though its email just changed.
    return existing.id;
  }

  const [primary] = await exec
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.orgId, orgId), isNull(contacts.siteId), eq(contacts.isPrimary, true)))
    .limit(1);

  const [created] = await exec.insert(contacts).values({
    orgId,
    siteId: null,
    ...next,
    roles: [BILLING_ROLE],
    isPrimary: !primary,
    createdBy: actorId ?? null,
  }).returning({ id: contacts.id, siteId: contacts.siteId, roles: contacts.roles });
  await reconcileLegacyContactResponsibilities(exec, {
    contactId: created!.id, orgId, siteId: created!.siteId, roles: created!.roles,
  });
  await recordDestinationChangeWithExecutor(exec, {
    orgId, contactId: created!.id, kind: 'email', value: next.email, source: 'technician', userId: actorId ?? null,
  });
  return created!.id;
}

/**
 * Merge `{name, email, phone}` into the org's billing contact, then re-project
 * `organizations.billing_contact` from it. The billing-settings path
 * (`invoiceService.updateOrgBillingSettings`). Returns the projected blob.
 *
 * `undefined` leaves a field alone. `email: null` means "no recipient" and
 * unassigns the billing role; a null name or phone clears that field on the
 * billing contact (see `applyToBillingContact`).
 */
export async function mergeBillingContact(
  exec: ContactExecutor,
  orgId: string,
  patch: ContactBlob,
  actorId?: string | null,
): Promise<BillingContactProjection | null | undefined> {
  if (patch.name === undefined && patch.email === undefined && patch.phone === undefined) return undefined;

  await lockOrganizationForProjection(exec, orgId);
  const keepContactId = await applyToBillingContact(exec, { orgId, patch, replace: false, actorId });
  return projectBillingContact(exec, orgId, { keepContactId });
}

/**
 * Whole-blob replace of the org's billing contact, for callers that have
 * already locked the org row with a statement of their own — the org
 * create/import INSERT, and the org PATCH route's guarded UPDATE (#2879),
 * which must keep its own WHERE. The column is then re-projected from the
 * contact, and the projected blob is returned so the caller can answer with
 * what was actually stored. A caller must not write the request's value into
 * `organizations.billing_contact` before calling this on an org that may
 * already have billing contacts: the target is chosen by reading the column.
 *
 * Callers pass whatever the (unvalidated, `z.any()`) request body carried;
 * `readContactBlob` is what makes a non-object value safe here.
 */
export async function syncBillingContactRow(
  exec: ContactExecutor,
  orgId: string,
  blob: unknown,
  actorId?: string | null,
): Promise<BillingContactProjection | null> {
  const keepContactId = await applyToBillingContact(exec, { orgId, patch: readContactBlob(blob), replace: true, actorId });
  return projectBillingContact(exec, orgId, { keepContactId });
}

/**
 * Replace a site's contact blob and keep its `contacts` row in step.
 *
 * The site PATCH route writes `contact` through a `{...data}` spread with no
 * literal `contact:` token at the write site, so a grep-driven sweep does not
 * find it.
 *
 * ⚠️ Production caller: ONLY `reprojectSiteContact` in `./crud` (#3258
 * W02), re-projecting a site-level primary after a primary-affecting
 * create/update/delete. The site PATCH route deliberately does NOT call this:
 * that spread write is a single UPDATE whose 0-row result is load-bearing (it
 * detects an RLS rejection that the prior SELECT missed), so the route keeps
 * its own write and calls `syncSiteContactRow` afterwards rather than issuing
 * a second UPDATE here. If your caller already writes the column, use the
 * `sync*` mirror instead of this.
 */
export async function replaceSiteContact(
  exec: ContactExecutor,
  orgId: string,
  siteId: string,
  blob: unknown,
  actorId?: string | null,
): Promise<void> {
  await exec
    .update(sites)
    .set({ contact: (blob ?? null) as never })
    .where(eq(sites.id, siteId));

  await applyToSiteContactRow(exec, {
    orgId, siteId, patch: readContactBlob(blob), replace: true, actorId,
  });
}

/**
 * Mirror a site contact into `contacts` WITHOUT touching the jsonb column —
 * for callers that already wrote it as part of the site insert.
 */
export async function syncSiteContactRow(
  exec: ContactExecutor,
  orgId: string,
  siteId: string,
  blob: unknown,
  actorId?: string | null,
): Promise<void> {
  await applyToSiteContactRow(exec, {
    orgId, siteId, patch: readContactBlob(blob), replace: true, actorId,
  });
}
