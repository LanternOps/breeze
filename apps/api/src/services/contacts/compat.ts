import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { contacts } from '../../db/schema/contacts';
import { organizations, sites } from '../../db/schema/orgs';

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
 * ── Semantics are deliberately unchanged ────────────────────────────────────
 * Each entry point reproduces its caller's EXISTING jsonb behaviour exactly:
 * `mergeBillingContact` keeps `invoiceService`'s atomic `||` merge (no
 * read-modify-write, so no lost update), and `replaceBillingContact` keeps the
 * org routes' whole-blob replace. The pre-existing race between the two — a
 * whole-blob PATCH clobbering keys the merge wrote — is NOT fixed here. Fixing
 * it means changing observable API behaviour, which belongs in its own change
 * with its own integration tests rather than riding along with the table
 * introduction.
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
 * Apply a patch to the canonical contact row for an org or a site.
 *
 * `undefined` leaves a field alone; `null` clears it. When the result carries
 * no identifying field at all the row is DELETED rather than updated —
 * `contacts_identifiable_chk` forbids a wholly empty contact, and "the user
 * cleared the last field" has to mean "there is no contact" rather than a
 * constraint violation.
 */
async function applyToContactRow(
  exec: ContactExecutor,
  params: {
    orgId: string;
    siteId: string | null;
    patch: ContactBlob;
    replace: boolean;
    defaultRoles: string[];
    actorId?: string | null;
  },
): Promise<void> {
  const { orgId, siteId, patch, replace, defaultRoles, actorId } = params;

  const where = siteId === null
    ? and(eq(contacts.orgId, orgId), isNull(contacts.siteId), eq(contacts.isPrimary, true))
    : and(eq(contacts.siteId, siteId), eq(contacts.isPrimary, true));

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
    .where(where)
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
  // taking the re-import identity key with it) the first time someone cleared
  // the billing email. When mobile survives, fall through and clear the three
  // modelled fields instead.
  if (isEmpty(next) && (existing?.mobile ?? null) === null) {
    if (existing) await exec.delete(contacts).where(eq(contacts.id, existing.id));
    return;
  }

  if (existing) {
    await exec
      .update(contacts)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(contacts.id, existing.id));
    return;
  }

  await exec.insert(contacts).values({
    orgId,
    siteId,
    ...next,
    roles: defaultRoles,
    isPrimary: true,
    createdBy: actorId ?? null,
  });
}

/**
 * Merge `{name, email}` into an organization's billing contact.
 *
 * Mirrors `invoiceService.updateOrgBillingSettings`: the jsonb side uses an
 * atomic `COALESCE(...) || ...::jsonb` so a concurrent writer's keys are never
 * lost to a read-modify-write round-trip.
 */
export async function mergeBillingContact(
  exec: ContactExecutor,
  orgId: string,
  patch: ContactBlob,
  actorId?: string | null,
): Promise<void> {
  const jsonPatch: Record<string, unknown> = {};
  if (patch.name !== undefined) jsonPatch.name = patch.name;
  if (patch.email !== undefined) jsonPatch.email = patch.email;
  if (patch.phone !== undefined) jsonPatch.phone = patch.phone;
  if (Object.keys(jsonPatch).length === 0) return;

  await exec
    .update(organizations)
    .set({
      billingContact: sql`COALESCE(${organizations.billingContact}, '{}'::jsonb) || ${JSON.stringify(jsonPatch)}::jsonb`,
    })
    .where(eq(organizations.id, orgId));

  await applyToContactRow(exec, {
    orgId, siteId: null, patch, replace: false, defaultRoles: ['billing'], actorId,
  });
}

/**
 * Replace an organization's billing contact blob wholesale.
 *
 * Callers pass whatever the (unvalidated, `z.any()`) request body carried;
 * `readContactBlob` is what makes a non-object value safe here.
 *
 * ⚠️ Production caller: ONLY `reprojectPrimaryContact` in `./crud` (#3258
 * W02), which owns the `contacts` row and re-projects the org-level primary
 * after every primary-affecting create/update/delete. The org PATCH/PUT route
 * deliberately does NOT call this: it needs a guarded WHERE — it re-asserts
 * partner-ownership and suspended-status in the UPDATE itself (#2879) so a
 * concurrent change cannot let a write land on an org that stopped
 * qualifying — and this function writes with a bare
 * `eq(organizations.id, orgId)`, which would silently drop that guard. That
 * route writes the column inside its own guarded UPDATE and then calls
 * `syncBillingContactRow`. If you are reaching for this from a route that
 * already has conditions on its UPDATE, you want `syncBillingContactRow`
 * instead.
 */
export async function replaceBillingContact(
  exec: ContactExecutor,
  orgId: string,
  blob: unknown,
  actorId?: string | null,
): Promise<void> {
  await exec
    .update(organizations)
    .set({ billingContact: (blob ?? null) as never })
    .where(eq(organizations.id, orgId));

  await applyToContactRow(exec, {
    orgId, siteId: null, patch: readContactBlob(blob), replace: true, defaultRoles: ['billing'], actorId,
  });
}

/**
 * Mirror an organization's billing contact into `contacts` WITHOUT touching
 * the jsonb column — for callers that already wrote it as part of a larger
 * insert (org create), where a second UPDATE would be wasted work.
 */
export async function syncBillingContactRow(
  exec: ContactExecutor,
  orgId: string,
  blob: unknown,
  actorId?: string | null,
): Promise<void> {
  await applyToContactRow(exec, {
    orgId, siteId: null, patch: readContactBlob(blob), replace: true, defaultRoles: ['billing'], actorId,
  });
}

/**
 * Replace a site's contact blob and keep its `contacts` row in step.
 *
 * The site PATCH route writes `contact` through a `{...data}` spread with no
 * literal `contact:` token at the write site, so a grep-driven sweep does not
 * find it.
 *
 * ⚠️ Production caller: ONLY `reprojectPrimaryContact` in `./crud` (#3258
 * W02), re-projecting a site-level primary after a primary-affecting
 * create/update/delete. The site PATCH route deliberately does NOT call this:
 * that spread write is a single UPDATE whose 0-row result is load-bearing (it
 * detects an RLS rejection that the prior SELECT missed), so the route keeps
 * its own write and calls `syncSiteContactRow` afterwards rather than issuing
 * a second UPDATE here. Same rule as `replaceBillingContact`: if your caller
 * already writes the column, use the `sync*` mirror instead of this.
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

  await applyToContactRow(exec, {
    orgId, siteId, patch: readContactBlob(blob), replace: true, defaultRoles: ['site'], actorId,
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
  await applyToContactRow(exec, {
    orgId, siteId, patch: readContactBlob(blob), replace: true, defaultRoles: ['site'], actorId,
  });
}
