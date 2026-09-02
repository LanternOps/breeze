/**
 * Contact import pipeline: preview -> commit (issue #3258, epic #3249).
 *
 * Mirrors `services/orgImport/index.ts`. Preview annotates every row against a
 * snapshot; commit RE-DERIVES every annotation against fresh state and refuses
 * any row whose annotation moved, with identity pinning on the matched contact.
 * Preview is advisory; the database is authority.
 *
 * ── Why each row gets its own transaction ───────────────────────────────────
 * Per-row failure isolation is the contract ("per-row failure is recorded and
 * the remaining rows proceed"), and inside ONE Postgres transaction it is
 * unachievable: a failed statement aborts the transaction and every later
 * statement raises 25P02. Route handlers already run inside the request's
 * `withDbAccessContext` transaction, so each row's writes escape it via
 * `runOutsideDbContext` and open their own — the same escape, for the same
 * reason, that the org importer uses.
 *
 * ── What authorises a write ─────────────────────────────────────────────────
 * Because those writes ride in a SYSTEM context, RLS is not the guard: the
 * snapshot is. It is loaded filtered to the caller's partner AND to the
 * caller's own organization allowlist, because a partner user can be
 * restricted to a SUBSET of their partner's organizations (partnerOrgAccess
 * 'selected') — a partner filter alone would let them write contacts into
 * every tenant their MSP owns. A row whose `organizationId` is absent from the
 * snapshot is refused as `org-not-found`, the same annotation an unknown name
 * gets, so the response is never an existence oracle. Name resolution is
 * bounded to the same snapshot.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { contacts, contactExternalLinks } from '../../db/schema/contacts';
import { organizations, sites } from '../../db/schema/orgs';
import { normalizeContactEmail, reprojectPrimaryContact } from './crud';
import {
  CONTACT_ROLES,
  DEFAULT_CONTACT_IMPORT_SYSTEM,
  type AnnotatedContactRow,
  type CommitContactRowInput,
  type ContactImportActor,
  type ContactImportContext,
  type ContactImportErrorCode,
  type ContactImportErrorEntry,
  type ContactImportRow,
  type ContactImportSummary,
  type ContactRowAnnotation,
} from './types';

export { MAX_IMPORT_ROWS, DEFAULT_CONTACT_IMPORT_SYSTEM } from './types';
export type * from './types';

/** Whitespace- and case-insensitive key for every name-based lookup. */
export function normalizeContactName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

// NUL separator: Postgres text cannot contain NUL, so composite keys built
// from user data can never collide across their parts.
const SEP = '\u0000';
const key = (...parts: Array<string | null>) => parts.join(SEP);

const ROLE_SET = new Set<string>(CONTACT_ROLES);

interface SnapshotOrg { id: string; name: string }
interface SnapshotSite { id: string; orgId: string; name: string }
interface SnapshotContact {
  id: string;
  orgId: string;
  siteId: string | null;
  name: string | null;
  email: string | null;
  isPrimary: boolean;
}

interface Snapshot {
  orgById: Map<string, SnapshotOrg>;
  /** normalised name -> orgs under the caller's partner. */
  orgsByName: Map<string, SnapshotOrg[]>;
  /** `orgId + normalised site name` -> sites. */
  sitesByName: Map<string, SnapshotSite[]>;
  contactById: Map<string, SnapshotContact>;
  /** `orgId + lower(email)` -> contacts. Several is legal: shared mailboxes. */
  contactsByEmail: Map<string, SnapshotContact[]>;
  /** `orgId + normalised name` -> contacts. */
  contactsByName: Map<string, SnapshotContact[]>;
  /** `orgId + system + externalId` -> contactId. */
  contactByLink: Map<string, string>;
}

function pushInto<T>(map: Map<string, T[]>, k: string, value: T): void {
  const list = map.get(k);
  if (list) list.push(value);
  else map.set(k, [value]);
}

/**
 * Load the snapshot in two phases: the partner's organizations first, then the
 * sites/contacts/links of only the organizations these rows actually name. A
 * 1000-row batch can reference at most 1000 organizations, so the second phase
 * stays bounded instead of dragging in every contact the partner owns.
 */
async function loadSnapshot(rows: ContactImportRow[], ctx: ContactImportContext): Promise<Snapshot> {
  const snapshot: Snapshot = {
    orgById: new Map(),
    orgsByName: new Map(),
    sitesByName: new Map(),
    contactById: new Map(),
    contactsByEmail: new Map(),
    contactsByName: new Map(),
    contactByLink: new Map(),
  };

  // null/undefined reach means system scope, which is unrestricted. An EMPTY
  // array is a caller who can reach nothing, and must resolve to zero
  // organizations rather than degrade into "no filter".
  const reach = ctx.accessibleOrgIds ?? null;
  if (reach !== null && reach.length === 0) return snapshot;

  const orgRows = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(and(
        eq(organizations.partnerId, ctx.partnerId),
        isNull(organizations.deletedAt),
        ...(reach ? [inArray(organizations.id, reach)] : []),
      ))
  )) as SnapshotOrg[];

  for (const org of orgRows) {
    snapshot.orgById.set(org.id, org);
    pushInto(snapshot.orgsByName, normalizeContactName(org.name), org);
  }

  // Only organizations this batch can actually resolve to.
  const referenced = new Set<string>();
  for (const row of rows) {
    if (row.organizationId && snapshot.orgById.has(row.organizationId)) {
      referenced.add(row.organizationId);
      continue;
    }
    if (!row.organizationId && row.organization) {
      const matches = snapshot.orgsByName.get(normalizeContactName(row.organization)) ?? [];
      if (matches.length === 1) referenced.add(matches[0]!.id);
    }
  }
  const orgIds = [...referenced];
  if (orgIds.length === 0) return snapshot;

  const { siteRows, contactRows, linkRows } = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const loadedSites = await db
      .select({ id: sites.id, orgId: sites.orgId, name: sites.name })
      .from(sites)
      .where(inArray(sites.orgId, orgIds)) as SnapshotSite[];
    const loadedContacts = await db
      .select({
        id: contacts.id,
        orgId: contacts.orgId,
        siteId: contacts.siteId,
        name: contacts.name,
        email: contacts.email,
        isPrimary: contacts.isPrimary,
      })
      .from(contacts)
      .where(inArray(contacts.orgId, orgIds)) as SnapshotContact[];
    const loadedLinks = await db
      .select({
        contactId: contactExternalLinks.contactId,
        orgId: contactExternalLinks.orgId,
        system: contactExternalLinks.system,
        externalId: contactExternalLinks.externalId,
      })
      .from(contactExternalLinks)
      .where(inArray(contactExternalLinks.orgId, orgIds)) as Array<{
        contactId: string; orgId: string; system: string; externalId: string;
      }>;
    return { siteRows: loadedSites, contactRows: loadedContacts, linkRows: loadedLinks };
  }));

  for (const site of siteRows) {
    pushInto(snapshot.sitesByName, key(site.orgId, normalizeContactName(site.name)), site);
  }
  for (const contact of contactRows) {
    snapshot.contactById.set(contact.id, contact);
    if (contact.email) {
      pushInto(snapshot.contactsByEmail, key(contact.orgId, contact.email.toLowerCase()), contact);
    }
    if (contact.name) {
      pushInto(snapshot.contactsByName, key(contact.orgId, normalizeContactName(contact.name)), contact);
    }
  }
  for (const link of linkRows) {
    snapshot.contactByLink.set(key(link.orgId, link.system, link.externalId), link.contactId);
  }
  return snapshot;
}

interface NormalizedRow {
  index: number;
  row: ContactImportRow;
  name: string | null;
  normalizedName: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  title: string | null;
  roles: string[] | null;
  system: string;
  externalId: string | null;
}

function clean(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeRows(rows: ContactImportRow[]): NormalizedRow[] {
  return rows.map((row, index) => {
    const name = clean(row.name);
    return {
      index,
      row,
      name,
      normalizedName: name === null ? null : normalizeContactName(name),
      email: normalizeContactEmail(row.email),
      phone: clean(row.phone),
      mobile: clean(row.mobile),
      title: clean(row.title),
      roles: row.roles === undefined ? null : row.roles.map((r) => r.trim()).filter(Boolean),
      system: clean(row.externalSystem) ?? DEFAULT_CONTACT_IMPORT_SYSTEM,
      externalId: clean(row.externalId),
    };
  });
}

interface Resolution {
  annotation: ContactRowAnnotation;
  organizationId: string | null;
  organizationName?: string;
  siteId: string | null;
  contactId: string | null;
  matched?: SnapshotContact;
  conflictReason?: string;
}

/**
 * Derive one row's annotation against the snapshot. Called at preview AND
 * again at commit against a freshly loaded snapshot, so a row whose state moved
 * in between is caught by `checkExpectation` rather than silently re-targeted.
 */
function resolveRow(
  normalized: NormalizedRow,
  snapshot: Snapshot,
  duplicateLinkKeys: Set<string>,
): Resolution {
  const miss = (annotation: ContactRowAnnotation, conflictReason: string): Resolution =>
    ({ annotation, organizationId: null, siteId: null, contactId: null, conflictReason });

  const { row } = normalized;

  // 1. Organization. An id outside the partner snapshot is indistinguishable
  //    from a name that matches nothing — deliberately, so neither answer
  //    reveals that another partner's organization exists.
  let org: SnapshotOrg | undefined;
  if (row.organizationId) {
    org = snapshot.orgById.get(row.organizationId);
    if (!org) return miss('org-not-found', 'No such organization under this partner');
  } else if (clean(row.organization)) {
    const candidates = snapshot.orgsByName.get(normalizeContactName(row.organization!)) ?? [];
    if (candidates.length === 0) {
      return miss('org-not-found', `No organization named "${row.organization!.trim()}"`);
    }
    if (candidates.length > 1) {
      return miss('conflict', `Multiple organizations are named "${row.organization!.trim()}"`);
    }
    org = candidates[0]!;
  } else {
    return miss('conflict', 'Row names no organization');
  }

  const base = { organizationId: org.id, organizationName: org.name };

  // 2. The row must be able to produce a legal contacts row.
  const rowConflict = (conflictReason: string): Resolution =>
    ({ ...base, annotation: 'conflict', siteId: null, contactId: null, conflictReason });

  if (normalized.name === null && normalized.email === null
    && normalized.phone === null && normalized.mobile === null) {
    return rowConflict('Row has no name, email, phone, or mobile');
  }
  const badRole = normalized.roles?.find((role) => !ROLE_SET.has(role));
  if (badRole) return rowConflict(`Unknown contact role "${badRole}"`);

  // 3. Optional site pin. An unresolvable pin is a conflict, never a silent
  //    demotion to an org-level contact — that would file the contact under the
  //    wrong scope and silently change which jsonb column projects it.
  let siteId: string | null = null;
  const siteName = clean(row.site);
  if (siteName) {
    const candidates = snapshot.sitesByName.get(key(org.id, normalizeContactName(siteName))) ?? [];
    if (candidates.length === 0) return rowConflict(`No site named "${siteName}" in ${org.name}`);
    if (candidates.length > 1) {
      return rowConflict(`Multiple sites in ${org.name} are named "${siteName}"`);
    }
    siteId = candidates[0]!.id;
  }

  const resolved = { ...base, siteId };

  // 4. Identity. The durable link wins; email and name are hints only.
  if (normalized.externalId) {
    if (duplicateLinkKeys.has(key(normalized.system, normalized.externalId))) {
      return { ...resolved, annotation: 'conflict', contactId: null,
        conflictReason: `External id "${normalized.externalId}" appears on more than one row in this file` };
    }
    const linked = snapshot.contactByLink.get(key(org.id, normalized.system, normalized.externalId));
    const contact = linked ? snapshot.contactById.get(linked) : undefined;
    if (contact) {
      return { ...resolved, annotation: 'link-match', contactId: contact.id, matched: contact };
    }
    // No link yet: fall through, so a first import still SEES the person who is
    // already there rather than minting a duplicate beside them.
  }

  // A shared mailbox is one address belonging to several real people, so an
  // ambiguous hint cannot identify one of them. That is only FATAL for a row
  // with no durable identity of its own: a row carrying an externalId gets a
  // link row on create, so the source has vouched for a distinct person and
  // every later import resolves it by link. Refusing those would make the
  // fourth person on a shared mailbox permanently unimportable — the very
  // shape contacts_org_email_idx is non-unique to allow.
  const identified = normalized.externalId !== null;
  const ambiguous = (reason: string): Resolution => (identified
    ? { ...resolved, annotation: 'create', contactId: null }
    : { ...resolved, annotation: 'conflict', contactId: null, conflictReason: reason });

  if (normalized.email) {
    const candidates = snapshot.contactsByEmail.get(key(org.id, normalized.email)) ?? [];
    if (candidates.length === 1) {
      return { ...resolved, annotation: 'email-match', contactId: candidates[0]!.id, matched: candidates[0] };
    }
    if (candidates.length > 1) {
      return ambiguous(`${candidates.length} contacts in ${org.name} already use ${normalized.email}`
        + ' — give the row an externalId to say which person it is');
    }
  }

  if (normalized.normalizedName) {
    const candidates = snapshot.contactsByName.get(key(org.id, normalized.normalizedName)) ?? [];
    if (candidates.length === 1) {
      return { ...resolved, annotation: 'name-match', contactId: candidates[0]!.id, matched: candidates[0] };
    }
    if (candidates.length > 1) {
      return ambiguous(`${candidates.length} contacts in ${org.name} are named "${normalized.name}"`
        + ' — give the row an externalId to say which person it is');
    }
  }

  return { ...resolved, annotation: 'create', contactId: null };
}

/** `(system, externalId)` pairs used by more than one row in this batch. */
function findDuplicateLinkKeys(normalized: NormalizedRow[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of normalized) {
    if (!row.externalId) continue;
    const k = key(row.system, row.externalId);
    if (seen.has(k)) duplicates.add(k);
    else seen.add(k);
  }
  return duplicates;
}

export async function previewContactImport(
  rows: ContactImportRow[],
  ctx: ContactImportContext,
): Promise<AnnotatedContactRow[]> {
  const snapshot = await loadSnapshot(rows, ctx);
  const normalized = normalizeRows(rows);
  const duplicates = findDuplicateLinkKeys(normalized);

  return normalized.map((r) => {
    const resolution = resolveRow(r, snapshot, duplicates);
    return {
      ...r.row,
      index: r.index,
      annotation: resolution.annotation,
      organizationId: resolution.organizationId,
      ...(resolution.organizationName ? { organizationName: resolution.organizationName } : {}),
      siteId: resolution.siteId,
      contactId: resolution.contactId,
      ...(resolution.matched
        ? { matchedContactName: resolution.matched.name, matchedContactEmail: resolution.matched.email }
        : {}),
      ...(resolution.conflictReason ? { conflictReason: resolution.conflictReason } : {}),
    };
  });
}

interface ExpectationProblem {
  error: string;
  code: ContactImportErrorCode;
}

/**
 * Validate a commit row's re-derived annotation against the client's
 * acknowledgement. Mirrors `orgImport`'s `checkExpectation`: the annotation
 * guard runs first, then identity pinning, then the "never auto-apply a fuzzy
 * match" refusal.
 */
function checkExpectation(
  row: CommitContactRowInput,
  derived: ContactRowAnnotation,
  matchedContactId: string | null,
  matchedName: string | null | undefined,
): ExpectationProblem | null {
  // Handled by the caller, which reports the conflict reason instead.
  if (derived === 'conflict' || derived === 'org-not-found') return null;

  if (row.expectedAnnotation && row.expectedAnnotation !== derived) {
    return {
      code: 'annotation-changed',
      error: `Annotation changed since preview: expected "${row.expectedAnnotation}", now "${derived}" — re-run preview`,
    };
  }
  // Identity pinning: an acknowledgement made against contact X must not be
  // transferred to whoever took over that address or name since preview.
  if (row.expectedContactId && matchedContactId && matchedContactId !== row.expectedContactId) {
    return {
      code: 'match-changed',
      error: 'Match changed since preview: the row now resolves to a different contact — re-run preview',
    };
  }
  if (row.expectedContactId && !matchedContactId) {
    return {
      code: 'match-changed',
      error: 'Match changed since preview: the previously matched contact no longer matches — re-run preview',
    };
  }
  if ((derived === 'email-match' || derived === 'name-match') && row.expectedAnnotation !== derived) {
    return {
      code: 'match-unconfirmed',
      error: `Row matches existing contact "${matchedName ?? 'unnamed'}" by `
        + `${derived === 'email-match' ? 'email address' : 'name'}`
        + ` — confirm by committing with expectedAnnotation "${derived}"`,
    };
  }
  return null;
}

/**
 * Attach the original thrown error WITHOUT making it serializable: routes hand
 * the summary straight to `c.json(...)`, and a stack trace (or a pg error
 * carrying query text) must never reach a response body.
 */
function withCause(entry: ContactImportErrorEntry, cause: unknown): ContactImportErrorEntry {
  Object.defineProperty(entry, 'cause', { value: cause, enumerable: false, writable: false });
  return entry;
}

/** Fields the row actually carries. An absent column never clears stored data. */
function presentFields(r: NormalizedRow): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (r.name !== null) fields.name = r.name;
  if (r.email !== null) fields.email = r.email;
  if (r.phone !== null) fields.phone = r.phone;
  if (r.mobile !== null) fields.mobile = r.mobile;
  if (r.title !== null) fields.title = r.title;
  if (r.roles && r.roles.length > 0) fields.roles = r.roles;
  return fields;
}

export async function commitContactImport(
  rows: CommitContactRowInput[],
  ctx: ContactImportContext,
  actor: ContactImportActor,
): Promise<ContactImportSummary> {
  // Re-derived against state loaded NOW, not against whatever preview saw.
  const snapshot = await loadSnapshot(rows, ctx);
  const normalized = normalizeRows(rows);
  const duplicates = findDuplicateLinkKeys(normalized);

  const summary: ContactImportSummary = { imported: [], updated: [], skipped: [], errors: [] };

  for (const r of normalized) {
    const row = r.row as CommitContactRowInput;
    const resolution = resolveRow(r, snapshot, duplicates);
    const organization = clean(row.organization) ?? resolution.organizationName;

    if (resolution.annotation === 'conflict' || resolution.annotation === 'org-not-found') {
      summary.errors.push({
        index: r.index,
        ...(organization ? { organization } : {}),
        error: resolution.conflictReason ?? 'Row is in conflict',
        code: resolution.annotation === 'org-not-found' ? 'org-not-found' : 'row-conflict',
      });
      continue;
    }

    const problem = checkExpectation(row, resolution.annotation, resolution.contactId, resolution.matched?.name);
    if (problem) {
      summary.errors.push({
        index: r.index,
        ...(organization ? { organization } : {}),
        error: problem.error,
        code: problem.code,
      });
      continue;
    }

    const orgId = resolution.organizationId!;

    if (resolution.annotation === 'link-match') {
      // The durable link already says this row IS that contact, so re-importing
      // the same file writes nothing at all.
      summary.skipped.push({
        index: r.index, organizationId: orgId, contactId: resolution.contactId!, reason: 'already_linked',
      });
      continue;
    }

    try {
      if (resolution.annotation === 'create') {
        const result = await createImportedContact(r, orgId, resolution.siteId, actor);
        summary.imported.push({ index: r.index, organizationId: orgId, ...result });
      } else {
        const result = await applyMatchedContact(r, orgId, resolution.matched!, actor);
        summary.updated.push({ index: r.index, organizationId: orgId, ...result });
      }
    } catch (err) {
      console.error('[contact-import] row failed', {
        partnerId: ctx.partnerId,
        index: r.index,
        error: err instanceof Error ? err.message : String(err),
      });
      summary.errors.push(withCause({
        index: r.index,
        ...(organization ? { organization } : {}),
        error: err instanceof Error ? err.message : String(err),
        code: 'write-failed',
      }, err));
    }
  }

  return summary;
}

/** One row's own transaction — see the module header on failure isolation. */
async function createImportedContact(
  r: NormalizedRow,
  orgId: string,
  siteId: string | null,
  actor: ContactImportActor,
): Promise<{ contactId: string; name: string | null; createdLink: boolean }> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [created] = await db.insert(contacts).values({
      orgId,
      siteId,
      name: r.name,
      email: r.email,
      phone: r.phone,
      mobile: r.mobile,
      title: r.title,
      ...(r.roles && r.roles.length > 0 ? { roles: r.roles } : {}),
      isPrimary: false,
      createdBy: actor.userId,
    }).returning({ id: contacts.id });

    const contactId = (created as { id: string }).id;
    const createdLink = await attachLink(r, orgId, contactId, actor);
    return { contactId, name: r.name, createdLink };
  }));
}

/**
 * Apply an acknowledged email/name match. Only fields the row carries are
 * written, so a CSV missing a column never blanks stored data, and the legacy
 * jsonb is re-projected when the edit landed on a primary contact.
 */
async function applyMatchedContact(
  r: NormalizedRow,
  orgId: string,
  matched: SnapshotContact,
  actor: ContactImportActor,
): Promise<{ contactId: string; name: string | null; createdLink: boolean }> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    await db.update(contacts)
      .set({ ...presentFields(r), updatedAt: new Date() })
      .where(and(eq(contacts.id, matched.id), eq(contacts.orgId, orgId)));

    // Persist the acknowledgement as a durable link so the next import
    // link-matches instead of asking for the same confirmation again.
    const createdLink = await attachLink(r, orgId, matched.id, actor);

    if (matched.isPrimary) {
      await reprojectPrimaryContact(db, orgId, matched.siteId, actor.userId);
    }
    return { contactId: matched.id, name: r.name ?? matched.name, createdLink };
  }));
}

async function attachLink(
  r: NormalizedRow,
  orgId: string,
  contactId: string,
  actor: ContactImportActor,
): Promise<boolean> {
  if (!r.externalId) return false;
  await db.insert(contactExternalLinks).values({
    contactId,
    orgId,
    system: r.system,
    externalId: r.externalId,
    createdBy: actor.userId,
  });
  return true;
}
