/**
 * Contact CRUD (issue #3258, epic #3249 Phase 3).
 *
 * The routes in `routes/orgContacts.ts` are thin wrappers over these four
 * functions, and the `add_contact` AI tool reuses `createContact` directly —
 * so validation and the legacy-jsonb re-projection live HERE, not at the route.
 * Anything that bypasses this module bypasses both.
 *
 * ── The projection invariant ────────────────────────────────────────────────
 * `organizations.billing_contact` and `sites.contact` are a permanent
 * compatibility projection of the `is_primary` contact for their scope (see
 * services/contacts/compat.ts for why they cannot be dropped). Every write
 * here that creates, edits, deletes or re-assigns a primary contact re-projects
 * the affected scope through compat.ts, which is the ONLY writer of either
 * jsonb column. Route handlers already run inside the request's
 * `withDbAccessContext` transaction, so the row write and the projection commit
 * together or not at all.
 */

import { and, arrayContains, asc, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { contacts, type Contact } from '../../db/schema/contacts';
import { organizations, sites } from '../../db/schema/orgs';
import { pgErrorCode } from '../../utils/pgErrors';
import { replaceBillingContact, replaceSiteContact, type ContactExecutor } from './compat';
import { CONTACT_ROLES, type ContactRole } from './types';

export type { ContactExecutor } from './compat';

export interface ContactActor {
  userId: string | null;
}

export interface ContactListFilters {
  /** A string pins to that site; `null` selects org-level contacts only. */
  siteId?: string | null;
  role?: string;
  /**
   * The caller's site-axis allowlist (`AuthContext.allowedSiteIds`). Omit for
   * an unrestricted caller; an array confines the result to
   * `site_id IS NULL OR site_id = ANY(...)`, and an EMPTY array therefore
   * leaves ONLY the org-level contacts.
   *
   * Load-bearing, not belt-and-braces: RLS on `contacts` is the ORG axis only,
   * so a sub-org-restricted user reads every sibling site's contacts without
   * this. Org-level contacts stay visible on purpose — the site allowlist
   * confines a caller WITHIN an org, it does not narrow their org reach.
   */
  allowedSiteIds?: string[];
}

export interface CreateContactInput {
  orgId: string;
  siteId?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  title?: string | null;
  roles?: string[];
  isPrimary?: boolean;
  notes?: string | null;
}

export type UpdateContactInput = Partial<Omit<CreateContactInput, 'orgId'>>;

export type ContactValidationCode = 'no-identifier' | 'invalid-role' | 'site-not-in-org';

/** A 400-shaped refusal: the caller's input cannot produce a legal row. */
export class ContactValidationError extends Error {
  constructor(message: string, public readonly code: ContactValidationCode) {
    super(message);
    this.name = 'ContactValidationError';
  }
}

/** The projection every read returns. Mirrors the table minus `createdBy`. */
const contactColumns = () => ({
  id: contacts.id,
  orgId: contacts.orgId,
  siteId: contacts.siteId,
  name: contacts.name,
  email: contacts.email,
  phone: contacts.phone,
  mobile: contacts.mobile,
  title: contacts.title,
  roles: contacts.roles,
  isPrimary: contacts.isPrimary,
  notes: contacts.notes,
  createdAt: contacts.createdAt,
  updatedAt: contacts.updatedAt,
});

export type ContactRecord = Pick<
  Contact,
  'id' | 'orgId' | 'siteId' | 'name' | 'email' | 'phone' | 'mobile'
  | 'title' | 'roles' | 'isPrimary' | 'notes' | 'createdAt' | 'updatedAt'
>;

function clean(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Emails are stored lower-cased. `contacts_org_email_idx` is on
 * `(org_id, lower(email))` and the importer's email hint matches on the same
 * expression, so storing the source's casing would leave the two disagreeing
 * about which spelling is "the" address.
 */
export function normalizeContactEmail(value: string | null | undefined): string | null {
  const cleaned = clean(value);
  return cleaned === null ? null : cleaned.toLowerCase();
}

const ROLE_SET = new Set<string>(CONTACT_ROLES);

export function assertValidRoles(roles: string[] | undefined): ContactRole[] | undefined {
  if (roles === undefined) return undefined;
  for (const role of roles) {
    if (!ROLE_SET.has(role)) {
      throw new ContactValidationError(
        `Unknown contact role "${role}" — expected one of ${CONTACT_ROLES.join(', ')}`,
        'invalid-role',
      );
    }
  }
  return roles as ContactRole[];
}

type Identifiers = Pick<ContactRecord, 'name' | 'email' | 'phone' | 'mobile'>;

const NO_IDENTIFIER_MESSAGE = 'A contact needs at least one of name, email, phone, or mobile';

/** Mirrors `contacts_identifiable_chk`, so the DB constraint is never the first to complain. */
function assertIdentifiable(fields: Identifiers): void {
  if (fields.name === null && fields.email === null && fields.phone === null && fields.mobile === null) {
    throw new ContactValidationError(NO_IDENTIFIER_MESSAGE, 'no-identifier');
  }
}

/**
 * Take the row locks a primary re-projection is about to need, parent-first.
 *
 * ── The deadlock this closes (#3911 class) ──────────────────────────────────
 * This module writes the `contacts` row and THEN re-projects into
 * `organizations.billing_contact` / `sites.contact`, while
 * `compat.mergeBillingContact` (compat.ts:167, the billing-settings path)
 * updates `organizations` FIRST and the contact row second. Two concurrent
 * writers on one organization therefore end up holding each other's next lock —
 * A holds the contact row and wants the org row, B holds the org row and wants
 * the contact row — which Postgres breaks with 40P01. Acquiring the parent
 * first gives both writers the same order, so they queue instead of deadlock.
 *
 * FOR NO KEY UPDATE, not FOR UPDATE: the weakest mode that still conflicts with
 * itself and with the plain UPDATE compat issues (which takes NO KEY UPDATE
 * anyway), so an FK's KEY SHARE lock — taken by any unrelated child insert that
 * merely REFERENCES the org — stays compatible.
 *
 * Sites are locked after the organization and in id order, so two callers
 * moving a primary between the same two sites cannot deadlock on each other.
 */
async function lockProjectionScopes(
  exec: ContactExecutor,
  orgId: string,
  siteIds: Array<string | null>,
): Promise<void> {
  await exec
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .for('no key update');

  const pinned = [...new Set(siteIds.filter((id): id is string => id !== null))].sort();
  if (pinned.length === 0) return;
  await exec
    .select({ id: sites.id })
    .from(sites)
    .where(inArray(sites.id, pinned))
    .orderBy(asc(sites.id))
    .for('no key update');
}

/**
 * The composite FK `(site_id, org_id)` already makes a cross-org pin
 * unrepresentable, but a 23503 is a 500 to the caller. Check first so a bad
 * `siteId` is an honest 400.
 */
async function assertSiteInOrg(exec: ContactExecutor, orgId: string, siteId: string): Promise<void> {
  const [row] = await exec
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.id, siteId), eq(sites.orgId, orgId)))
    .limit(1);
  if (!row) {
    throw new ContactValidationError('Site does not belong to this organization', 'site-not-in-org');
  }
}

/** `WHERE` for the single primary contact of one scope (org-level or one site). */
function primaryScopeWhere(orgId: string, siteId: string | null): SQL {
  return siteId === null
    ? and(eq(contacts.orgId, orgId), isNull(contacts.siteId), eq(contacts.isPrimary, true))!
    : and(eq(contacts.orgId, orgId), eq(contacts.siteId, siteId), eq(contacts.isPrimary, true))!;
}

/**
 * Clear any existing primary in a scope so the new one cannot collide with
 * `contacts_org_primary_uniq` / `contacts_site_primary_uniq`.
 *
 * Auto-demotion rather than a 409: "make this the primary" is one intent, and
 * the unique indexes permit exactly one holder per scope, so requiring the
 * client to demote the incumbent first would make the flow racy and force it to
 * know who the incumbent is.
 */
async function demoteScopePrimary(
  exec: ContactExecutor,
  orgId: string,
  siteId: string | null,
  exceptContactId?: string,
): Promise<void> {
  const scope = primaryScopeWhere(orgId, siteId);
  await exec
    .update(contacts)
    .set({ isPrimary: false, updatedAt: new Date() })
    .where(exceptContactId ? and(scope, ne(contacts.id, exceptContactId))! : scope);
}

/**
 * Re-derive one scope's legacy jsonb from whatever contact now holds
 * `is_primary` there (or clear it when nothing does).
 *
 * Deliberately routed through compat's `replace*` entry points — the two
 * functions reserved for exactly this caller — so the jsonb keeps a single
 * writer. They also re-assert the row side, which is a redundant no-op UPDATE
 * here; correctness of the invariant is worth one statement.
 *
 * Exported because the contact IMPORTER edits primary contacts too (an
 * acknowledged match can land on one), and the invariant has to hold on every
 * path that writes the table, not just the CRUD one.
 */
export async function reprojectPrimaryContact(
  exec: ContactExecutor,
  orgId: string,
  siteId: string | null,
  actorId: string | null,
): Promise<void> {
  const [primary] = await exec
    .select({
      name: contacts.name,
      email: contacts.email,
      phone: contacts.phone,
      mobile: contacts.mobile,
    })
    .from(contacts)
    .where(primaryScopeWhere(orgId, siteId))
    .limit(1);

  // A mobile-only primary has nothing the three-key blob can model. Write null
  // rather than `{name:null,email:null,phone:null}` so the column keeps meaning
  // "no contact" instead of "an empty one".
  const blob = primary && (primary.name !== null || primary.email !== null || primary.phone !== null)
    ? { name: primary.name, email: primary.email, phone: primary.phone }
    : null;

  if (siteId === null) {
    await replaceBillingContact(exec, orgId, blob, actorId);
  } else {
    await replaceSiteContact(exec, orgId, siteId, blob, actorId);
  }
}

function contactListWhere(orgId: string, filters: ContactListFilters): SQL {
  const conditions: SQL[] = [eq(contacts.orgId, orgId)];
  if (filters.siteId === null) {
    conditions.push(isNull(contacts.siteId));
  } else if (typeof filters.siteId === 'string') {
    conditions.push(eq(contacts.siteId, filters.siteId));
  }
  if (filters.role) {
    // roles is text[]: membership is array containment, not equality.
    conditions.push(arrayContains(contacts.roles, [filters.role]));
  }
  if (filters.allowedSiteIds) {
    // The empty case is spelled out rather than left to `inArray([])`: a caller
    // who can reach no site still sees the ORG-LEVEL contacts, so the clause
    // has to collapse to `site_id IS NULL` and not to a false constant.
    conditions.push(
      filters.allowedSiteIds.length === 0
        ? isNull(contacts.siteId)
        : or(isNull(contacts.siteId), inArray(contacts.siteId, filters.allowedSiteIds))!,
    );
  }
  return and(...conditions)!;
}

export async function listContacts(
  exec: ContactExecutor,
  orgId: string,
  filters: ContactListFilters = {},
  page: { limit: number; offset: number } | null = null,
): Promise<ContactRecord[]> {
  const query = exec
    .select(contactColumns())
    .from(contacts)
    .where(contactListWhere(orgId, filters))
    // `id` last so the order is total: two contacts can share a name and a
    // creation timestamp, and a non-total order makes paging drop/repeat rows.
    .orderBy(asc(contacts.name), asc(contacts.createdAt), asc(contacts.id));
  return (page ? query.limit(page.limit).offset(page.offset) : query) as Promise<ContactRecord[]>;
}

/** Total matching `listContacts` with the same filters, for the page envelope. */
export async function countContacts(
  exec: ContactExecutor,
  orgId: string,
  filters: ContactListFilters = {},
): Promise<number> {
  const [row] = await exec
    .select({ count: sql<number>`count(*)` })
    .from(contacts)
    .where(contactListWhere(orgId, filters));
  return Number((row as { count: number | string } | undefined)?.count ?? 0);
}

export async function getContact(
  exec: ContactExecutor,
  contactId: string,
  orgId: string,
): Promise<ContactRecord | null> {
  const [row] = await exec
    .select(contactColumns())
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.orgId, orgId)))
    .limit(1);
  return (row as ContactRecord | undefined) ?? null;
}

/**
 * The organization AND site a contact belongs to, for the `/contacts/:id`
 * routes, which carry neither in their path. Returns null when no such contact
 * is visible — under RLS that already collapses "not yours" into "not there",
 * and the routes re-assert the caller's org reach on top.
 *
 * The site comes back with the org because the site axis is app-layer only:
 * the route cannot decide whether a site-confined caller may touch this contact
 * without knowing which site it is pinned to, and a second query for that would
 * be a second chance to forget the check.
 */
export async function findContactScope(
  exec: ContactExecutor,
  contactId: string,
): Promise<{ orgId: string; siteId: string | null } | null> {
  const [row] = await exec
    .select({ orgId: contacts.orgId, siteId: contacts.siteId })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);
  return (row as { orgId: string; siteId: string | null } | undefined) ?? null;
}

export async function createContact(
  exec: ContactExecutor,
  input: CreateContactInput,
  actor: ContactActor,
): Promise<ContactRecord> {
  const siteId = input.siteId ?? null;
  const fields: Identifiers = {
    name: clean(input.name),
    email: normalizeContactEmail(input.email),
    phone: clean(input.phone),
    mobile: clean(input.mobile),
  };
  assertIdentifiable(fields);
  const roles = assertValidRoles(input.roles);
  if (siteId !== null) await assertSiteInOrg(exec, input.orgId, siteId);

  const isPrimary = input.isPrimary === true;
  // Parent-first, before the demotion UPDATE and the INSERT — see
  // lockProjectionScopes. A non-primary create re-projects nothing and takes
  // no lock, so ordinary contact creation never serialises on the org row.
  if (isPrimary) {
    await lockProjectionScopes(exec, input.orgId, [siteId]);
    await demoteScopePrimary(exec, input.orgId, siteId);
  }

  const [created] = await exec
    .insert(contacts)
    .values({
      orgId: input.orgId,
      siteId,
      ...fields,
      title: clean(input.title),
      ...(roles ? { roles } : {}),
      isPrimary,
      notes: clean(input.notes),
      createdBy: actor.userId,
    })
    .returning(contactColumns());

  if (isPrimary) await reprojectPrimaryContact(exec, input.orgId, siteId, actor.userId);
  return created as ContactRecord;
}

/** Returns null when the contact does not exist under this organization. */
export async function updateContact(
  exec: ContactExecutor,
  contactId: string,
  orgId: string,
  patch: UpdateContactInput,
  actor: ContactActor,
): Promise<ContactRecord | null> {
  const existing = await getContact(exec, contactId, orgId);
  if (!existing) return null;

  const roles = assertValidRoles(patch.roles);
  const nextSiteId = patch.siteId === undefined ? existing.siteId : (patch.siteId ?? null);
  const fields: Identifiers = {
    name: patch.name === undefined ? existing.name : clean(patch.name),
    email: patch.email === undefined ? existing.email : normalizeContactEmail(patch.email),
    phone: patch.phone === undefined ? existing.phone : clean(patch.phone),
    mobile: patch.mobile === undefined ? existing.mobile : clean(patch.mobile),
  };
  assertIdentifiable(fields);
  if (nextSiteId !== null && nextSiteId !== existing.siteId) {
    await assertSiteInOrg(exec, orgId, nextSiteId);
  }

  const nextIsPrimary = patch.isPrimary === undefined ? existing.isPrimary : patch.isPrimary;

  // Both the vacated and the claimed scope can have lost or gained a primary.
  // This is also EXACTLY the set of parents the re-projection will write, so the
  // pre-lock and the re-projection below cannot drift apart.
  const scopes = new Set<string | null>();
  if (existing.isPrimary) scopes.add(existing.siteId);
  if (nextIsPrimary) scopes.add(nextSiteId);
  if (scopes.size > 0) await lockProjectionScopes(exec, orgId, [...scopes]);

  // Demote the incumbent whenever this row is claiming a primary slot it does
  // not already hold — a scope move counts, even with is_primary unchanged.
  if (nextIsPrimary && !(existing.isPrimary && existing.siteId === nextSiteId)) {
    await demoteScopePrimary(exec, orgId, nextSiteId, contactId);
  }

  // SET only what the patch actually names. Writing all four identifiers (and
  // site/primary) back on every PATCH made two concurrent disjoint patches
  // overwrite each other: a caller changing only the phone re-wrote the name
  // and email it had read moments earlier. `fields` above is still computed —
  // it is the MERGED row the identifier check has to be made against — but only
  // the named columns are written. An explicit null stays a real clear.
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = fields.name;
  if (patch.email !== undefined) set.email = fields.email;
  if (patch.phone !== undefined) set.phone = fields.phone;
  if (patch.mobile !== undefined) set.mobile = fields.mobile;
  if (patch.siteId !== undefined) set.siteId = nextSiteId;
  if (patch.title !== undefined) set.title = clean(patch.title);
  if (roles) set.roles = roles;
  if (patch.isPrimary !== undefined) set.isPrimary = patch.isPrimary;
  if (patch.notes !== undefined) set.notes = clean(patch.notes);

  let updated: ContactRecord | undefined;
  try {
    [updated] = await exec
      .update(contacts)
      .set(set)
      .where(and(eq(contacts.id, contactId), eq(contacts.orgId, orgId)))
      .returning(contactColumns()) as ContactRecord[];
  } catch (err) {
    // 23514 on `contacts` can only be `contacts_identifiable_chk` — it is the
    // table's only CHECK. The in-process pre-check above reads the STORED row,
    // so a concurrent patch that cleared the other identifier between that read
    // and this write lands here instead; it is the same refusal and must be the
    // caller's 400, not an uncaught 500.
    if (pgErrorCode(err) === '23514') {
      throw new ContactValidationError(NO_IDENTIFIER_MESSAGE, 'no-identifier');
    }
    throw err;
  }

  for (const scope of scopes) await reprojectPrimaryContact(exec, orgId, scope, actor.userId);

  return updated as ContactRecord;
}

/** Returns null when the contact does not exist under this organization. */
export async function deleteContact(
  exec: ContactExecutor,
  contactId: string,
  orgId: string,
  actor: ContactActor,
): Promise<ContactRecord | null> {
  const existing = await getContact(exec, contactId, orgId);
  if (!existing) return null;

  // Parent-first before the DELETE, for the same reason updateContact does it.
  if (existing.isPrimary) await lockProjectionScopes(exec, orgId, [existing.siteId]);

  await exec.delete(contacts).where(and(eq(contacts.id, contactId), eq(contacts.orgId, orgId)));

  if (existing.isPrimary) await reprojectPrimaryContact(exec, orgId, existing.siteId, actor.userId);
  return existing;
}
