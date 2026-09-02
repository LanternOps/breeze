/**
 * Shared types for the contact import pipeline (issue #3258, epic #3249).
 *
 * Mirrors `services/orgImport/types.ts`: preview annotates, commit re-derives
 * every annotation against fresh state and refuses rows whose annotation moved.
 * Preview is advisory; the database is authority.
 *
 * The dedicated contact importer exists for the many-contacts-per-org case the
 * ORG importer cannot express — its single `contact` field per row can only
 * ever carry the headline contact.
 *
 * ── Merge semantics: an empty cell means "no data", never "clear this" ──────
 * RULING (review round 2, no behaviour change): the importer MERGES. A field a
 * row does not carry — an absent CSV column, or a column present but blank —
 * leaves the stored value alone, and `roles` is likewise only ever replaced
 * when the row supplies a non-empty list. There is deliberately no way to CLEAR
 * a field through an import.
 *
 * The reason is that a CSV cannot distinguish the two intents: a blank cell is
 * overwhelmingly an exporter that had nothing to put there, not an operator
 * asking to erase a phone number. Reading blanks as clears would let one
 * partial export from a PSA silently wipe contact details across a whole
 * tenant, and there is no undo. Clearing a field is a deliberate act and lives
 * on `PATCH /contacts/:contactId`, which CAN say it: an explicit `null` there
 * is a real clear, and an omitted key is not.
 *
 * ── A malformed row fails the whole batch ───────────────────────────────────
 * Row shape is validated by Zod at the route (`contactImportRowSchema` /
 * `commitContactImportRowSchema`), which rejects the entire request when ANY
 * row fails — a wholly blank row included, since it satisfies no identifier.
 * That mirrors the org importer, and it is the honest answer for a
 * wire-contract violation: the per-row error buckets below report rows that
 * were well-formed but could not be RESOLVED, which is a different thing from
 * a request the server could not parse. Clients that append trailing blank
 * lines (every spreadsheet export does) must filter them before upload.
 */

// TYPE-ONLY, so it is erased at compile time and this module keeps its
// dependency-free runtime shape (route suites mock ./crud wholesale).
import type { ContactValidationCode } from './crud';

/** Same cap as the org importer, applied by the routes to the rows array. */
export const MAX_IMPORT_ROWS = 1000;

/**
 * Written to `contact_external_links.system` when a row names no source.
 *
 * Defined here, in the dependency-free types module, and re-exported by
 * `./import` so callers that already hold the pipeline barrel need not reach
 * past it. There is no second copy.
 */
export const DEFAULT_CONTACT_IMPORT_SYSTEM = 'csv';

/**
 * App-validated role vocabulary for `contacts.roles` (a `text[]`, so there is
 * no database enum to lean on). Grown per import source, per the schema note
 * in `db/schema/contacts.ts`.
 */
export const CONTACT_ROLES = [
  'billing',
  'technical',
  'escalation',
  'admin',
  'site',
  'after_hours',
  'portal',
] as const;

export type ContactRole = (typeof CONTACT_ROLES)[number];

export interface ContactImportRow {
  /** Preferred: names the organization outright. */
  organizationId?: string;
  /** Else resolved by name within the CALLER'S partner only. */
  organization?: string;
  /** Optional site name within that organization. */
  site?: string;
  /**
   * Optional, matching the nullable column: `contacts_identifiable_chk` needs
   * one of name/email/phone/mobile, not a name specifically. A blob of the
   * form `{"email": "ap@acme.com"}` is a real contact.
   */
  name?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  title?: string;
  roles?: string[];
  /** The source's stable contact id — the ONLY durable re-import identity. */
  externalId?: string;
  /** 'datto_rmm' | 'connectwise' | ... ; defaults to DEFAULT_CONTACT_IMPORT_SYSTEM. */
  externalSystem?: string;
}

/**
 * How a row resolved against existing state.
 *
 * - `link-match` resolves through `contact_external_links`. What commit does
 *   with it is the caller's `ContactImportMode` (below): skipped by default,
 *   applied in `update` mode. No acknowledgement is ever required — the durable
 *   link IS the acknowledgement.
 * - `email-match` / `name-match` are HINTS and are never committed without the
 *   client echoing `expectedAnnotation`, in either mode.
 * - `org-not-found` covers "no such organization" and "not yours" alike, so the
 *   annotation is never an existence oracle for another partner's tenants.
 */
export type ContactRowAnnotation =
  | 'create'
  | 'link-match'
  | 'email-match'
  | 'name-match'
  | 'conflict'
  | 'org-not-found';

/**
 * What a COMMIT does with a `link-match` row. Mirrors the org importer's
 * `mode` (`routes/orgs.ts` `commitOrgImportSchema`), including its `skip`
 * default, so the two importers answer "I re-uploaded the same file" the same
 * way.
 *
 * - `skip` (default): a linked contact is left exactly as it is and reported
 *   under `skipped`, so re-importing an unchanged file writes nothing at all.
 * - `update`: the row is applied to the contact its link names and reported
 *   under `updated`. Still a MERGE — see the merge-never-clear ruling above —
 *   so an absent column cannot erase stored data, and the mode never relaxes
 *   the acknowledgement a fuzzy `email-match` / `name-match` requires.
 */
export type ContactImportMode = 'skip' | 'update';

/**
 * The submitted row echoed back with its resolution. `organizationId` is
 * omitted from the base and redeclared: on the way IN it is an optional hint,
 * on the way OUT it is the RESOLVED organization, explicitly null when the row
 * could not be placed.
 */
export interface AnnotatedContactRow extends Omit<ContactImportRow, 'organizationId'> {
  /** Position in the submitted rows array. */
  index: number;
  annotation: ContactRowAnnotation;
  organizationId: string | null;
  /** The resolved organization's current name, for the preview UI. */
  organizationName?: string;
  /** The resolved site pin, when the row named one. */
  siteId?: string | null;
  /** The matched contact's id (link-match / email-match / name-match). */
  contactId: string | null;
  /** The matched contact's current name and email, for the preview UI. */
  matchedContactName?: string | null;
  matchedContactEmail?: string | null;
  /** Populated for `conflict` and `org-not-found`. */
  conflictReason?: string;
  /**
   * NON-FATAL disclosure: the row still applies exactly as its `annotation`
   * says. Set when resolution made a judgement call the operator should see —
   * today, an email or name hint that matched SEVERAL existing contacts and was
   * overridden into a `create` because the row carries its own `externalId`.
   * Without it that near-duplicate reads as an ordinary fresh contact.
   */
  warning?: string;
}

export interface CommitContactRowInput extends ContactImportRow {
  /**
   * The annotation the client saw at preview time. Commit re-derives the
   * annotation and rejects any row whose annotation changed. An `email-match`
   * or `name-match` is never applied without this explicit acknowledgement.
   */
  expectedAnnotation?: ContactRowAnnotation;
  /**
   * Identity pinning: the contact the client saw the row match. When present,
   * commit refuses the row if the re-derived match resolves to a DIFFERENT
   * contact — an acknowledgement ("yes, this is Jane") must never be
   * transferred to whoever took over that address between preview and commit.
   */
  expectedContactId?: string;
}

export interface ContactImportActor {
  userId: string | null;
}

export interface ContactImportContext {
  /** Name resolution and organization reach are bounded to this partner. */
  partnerId: string;
  /**
   * The caller's own organization allowlist (`AuthContext.accessibleOrgIds`).
   * `null` is system scope, i.e. unrestricted; an EMPTY array reaches nothing.
   *
   * Load-bearing, not belt-and-braces: the importer's snapshot READS and its
   * row writes both run in a system DB context — on the preview path as much as
   * on commit — so RLS is not enforcing tenancy on either. A partner user
   * restricted to a subset of their partner's organizations would otherwise be
   * able to read, and write, contacts in every tenant the MSP owns.
   */
  accessibleOrgIds?: string[] | null;
  /**
   * The caller's site-axis allowlist (`AuthContext.allowedSiteIds`).
   * `null`/absent is unrestricted; an array confines the caller to those sites
   * plus every ORG-LEVEL contact, because the site allowlist narrows a caller
   * WITHIN an org rather than narrowing their org reach.
   *
   * Even more load-bearing than `accessibleOrgIds`: RLS never covered the site
   * axis on ANY path, in a system context or out of one, so this is the only
   * boundary that exists for it.
   */
  allowedSiteIds?: string[] | null;
}

/**
 * Why a row failed. Callers MUST branch on this rather than on the message
 * text: the messages are UI copy for the import screen and get reworded.
 */
export type ContactImportErrorCode =
  /** The row is malformed, or ambiguous against existing state. */
  | 'row-conflict'
  /** No such organization under this partner (or it is not the caller's). */
  | 'org-not-found'
  /** The re-derived annotation differs from the client's acknowledgement. */
  | 'annotation-changed'
  /** The acknowledged contact is no longer the one the row resolves to. */
  | 'match-changed'
  /** An email/name match was not acknowledged. */
  | 'match-unconfirmed'
  /** A database write failed. `cause` carries the original error. */
  | 'write-failed'
  /**
   * The CRUD service refused the row on a rule only it can see — the merged row
   * lost its last identifier, an unknown role, a site that is not the
   * organization's. Reported under the service's OWN code (`no-identifier`,
   * `invalid-role`, `site-not-in-org`) with its own copy, because "check the
   * server log" would hide a row the operator can actually fix.
   */
  | ContactValidationCode;

export interface ContactImportErrorEntry {
  index: number;
  organization?: string;
  /**
   * Human-readable copy, safe to display. Callers must branch on `code`, never
   * on this. For `write-failed` it is FIXED copy chosen from the SQLSTATE, not
   * the driver's message: a pg error's `.message` carries column values and
   * constraint text, so it is never put on the wire.
   */
  error: string;
  code: ContactImportErrorCode;
  /**
   * The ORIGINAL thrown error for `write-failed`, so error trackers keep the
   * stack and pg SQLSTATE that the fixed `error` copy discards. NON-ENUMERABLE,
   * so it never reaches a JSON response body — read it in-process only.
   */
  cause?: unknown;
}

export interface ContactImportResultEntry {
  index: number;
  organizationId: string;
  contactId: string;
  /** The contact's name as written, for the result table. */
  name: string | null;
  /** True when this row also wrote a `contact_external_links` row. */
  createdLink: boolean;
}

export interface ContactImportSkipEntry {
  index: number;
  organizationId: string;
  contactId: string;
  /** Only reason today: the durable link already names this contact. */
  reason: 'already_linked';
}

/**
 * Always returned with HTTP 200, including when `errors` is non-empty — the web
 * caller consumes this through `runAction`, which treats a `success: false`
 * body as a hard failure and would hide an otherwise-successful partial import.
 */
export interface ContactImportSummary {
  imported: ContactImportResultEntry[];
  updated: ContactImportResultEntry[];
  skipped: ContactImportSkipEntry[];
  errors: ContactImportErrorEntry[];
}
