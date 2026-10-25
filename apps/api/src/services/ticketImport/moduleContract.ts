import type { z } from 'zod';
import type { ImportedTicket } from './importedTicket';
import type { SourceClient } from './sourceFetch';

/**
 * The contract between the import framework and a module (#8313 W4; spec
 * docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md
 * §5.1–§5.2). A module reads one source and converts it into Breeze's model.
 * It never touches the database, and the framework never parses a source.
 *
 * Ids: ticket keys and every comment and attachment source id are unique
 * across the whole source and stable between passes. They are resume keys
 * per principal, so a module that reused per-ticket ids would see later
 * tickets' comments skipped as already imported. A module documents its id
 * grammar and answers `isSourceArticleId` for the comments that are source
 * articles rather than notes it composed (§5.3).
 *
 * Times are UTC instants. The framework clamps a time up to
 * TICKET_IMPORT_MAX_CLOCK_SKEW_MS in the future to now and counts it; beyond
 * that the ticket fails `clock_skew` (§5.2).
 */

/** A source credential: a few named strings (a token, an email and a key, ...), sealed row-bound. */
export type SourceCredentials = Record<string, string>;

/** What a module is handed for every call: the source, already decrypted, and the only way to reach it. */
export type SourceHandle<Options = unknown> = {
  sourceId: string;
  /** The stored base URL (normalized, no trailing slash). */
  baseUrl: string;
  credentials: SourceCredentials;
  options: Options;
  /** Requests go to `baseUrl` plus a fixed path; no URL is ever taken from a response (§5.6). */
  http: SourceClient;
};

export type ConnectReport = {
  /** Who the credential acts as, in the source. */
  identity: { key: string | null; name: string | null; email: string | null };
  /** What the credential may do, as the source names it. */
  permissions: string[];
  /** Things the admin should know before mapping (inactive groups, a token without admin access, ...). */
  warnings: Array<{ code: string; detail?: string }>;
  /** The source clock minus Breeze's, from the response `Date` header; null when the source sent none. */
  clockSkewMs: number | null;
  /** The source's own version string, as it reports it; null when the credential may not read it. */
  sourceVersion?: string | null;
};

export type SourceCatalogEntry = {
  key: string;
  name: string;
  /** False for an inactive entry (a deactivated group, whose tickets no token can see). */
  active?: boolean;
  /** False when the credential cannot read it. */
  readable?: boolean;
};

/** What the wizard maps (§5.11): orgs, groups (inactive ones included), priorities, states, attributes. */
export type SourceCatalog = {
  orgs: SourceCatalogEntry[];
  groups: SourceCatalogEntry[];
  priorities: SourceCatalogEntry[];
  states: SourceCatalogEntry[];
  attributes: SourceCatalogEntry[];
  /** Counts the preflight shows (users, states, ...). */
  counts: Record<string, number>;
};

/**
 * One row of the source's ticket list. `version` orders a ticket's states in
 * the source (Zammad: updated_at) and is compared for equality only, never
 * across tickets. `orgKey` decides the target org without loading the ticket.
 * `number` (an addition to the spec's shape) is the source's human-facing
 * number, for the report rows of tickets that are never loaded.
 */
export type SourceRow = {
  key: string;
  version: string;
  orgKey: string | null;
  number?: string | null;
  summary: unknown;
  /**
   * The module could key this row but not read the rest (a malformed record
   * in an otherwise good page): the framework fails this ticket with `code`
   * without loading it, and the page goes on. The next run retries it.
   */
  failure?: { code: string };
};

/**
 * Everything a conversion needs, with no file bytes. `needs` names the Breeze
 * lookups the conversion will consult, so the framework can resolve them
 * before calling the pure `convert` (§5.2): the emails of users that may be
 * assignees and of requesters that may be contacts.
 */
export type LoadedTicket = {
  row: SourceRow;
  data: unknown;
  needs?: { userEmails?: readonly string[]; contactEmails?: readonly string[] };
};

/**
 * The Breeze side of one conversion, resolved by the framework (§5.2, §5.8).
 * Emails are keys in lower case.
 */
export type ConversionContext<Options = unknown> = {
  /** The Breeze org this ticket imports into: its source org's mapping, else the fallback. */
  orgId: string;
  /** Source org key -> Breeze org; `fallbackOrgId` serves a NULL or unmapped key. */
  orgIdBySourceOrg: ReadonlyMap<string, string>;
  fallbackOrgId: string | null;
  /** Source group key -> partner category. An unmapped group has no category. */
  categoryIdBySourceGroup: ReadonlyMap<string, string>;
  /**
   * Users of the partner whose org is null or this ticket's org, deactivated
   * included: the users import eligibility accepts as assignees (F16).
   */
  userIdByEmail: ReadonlyMap<string, string>;
  /** Contacts of this ticket's org, only where exactly one has the email (F15). */
  contactIdByEmail: ReadonlyMap<string, string>;
  options: Options;
  now: Date;
  /** Measured at the slice's start, like the preflight's (§5.2). */
  clockSkewMs: number | null;
};

/** A ticket-to-ticket link the conversion asks for, by source keys (merges, §6.6). */
export type ImportedLink = {
  sourceKey: string;
  targetKey: string;
  linkType: 'duplicate_of' | 'related' | 'caused_by' | 'resolves';
  at: Date;
};

/**
 * What a conversion reports beside the ticket (§5.10). The framework turns
 * each into counters and, where the report lists one, an issue row.
 */
export type ReportNote =
  /** A historic owner matched no user: the ticket is unassigned with the owner note. Once per distinct owner per run. */
  | { kind: 'owner_unmatched'; sourceUserKey: string }
  /** The requester stays display-only (no contact, or several share the email). */
  | { kind: 'requester_without_contact' }
  /** A body was clamped and carries the truncation marker. */
  | { kind: 'content_truncated'; count?: number }
  /** System articles skipped (#8313 answer 5). */
  | { kind: 'comments_system_skipped'; count: number }
  /** Alternative parts not imported (an HTML mail's message.html copy). */
  | { kind: 'attachments_alternative_ignored'; count: number }
  /** A custom attribute with a value, not imported in v1. */
  | { kind: 'custom_attribute'; name: string; count?: number }
  /**
   * A module-specific count the report lists by name, with no issue row
   * (Zammad: a legacy `removed` state, tags cut to Breeze's limits, a body
   * the source could not render). Names are fixed strings of the module,
   * never source content.
   */
  | { kind: 'module_count'; name: string; count?: number };

export type Conversion =
  | { kind: 'ticket'; ticket: ImportedTicket; links: ImportedLink[]; notes: ReportNote[] }
  | { kind: 'skip'; code: 'no_org' | 'unsupported'; notes: ReportNote[] };

/** One source file, as importTicket asks for it, with the ticket it belongs to. */
export type AttachmentRef = { sourceId: string; ticketKey: string };

/**
 * A probe of a ticket the scan did not see (§5.9 deletions). `present` carries
 * the ticket's row, so the framework can import a ticket an offset shift
 * skipped: a deviation from §5.2's bare `'present'`, which gave the framework
 * no row to load.
 */
export type ProbeResult =
  | { state: 'present'; row: SourceRow }
  | { state: 'deleted' }
  | { state: 'hidden' };

export interface TicketImportModule<Options = unknown, Cursor = unknown> {
  /** Stored on the source row (varchar(32)). */
  readonly id: string;
  readonly label: string;
  /** Module options (priority map, toggles). Never an org or category id: those are the maps. */
  readonly optionsSchema: z.ZodType<Options>;
  /** Identity, permissions and warnings; the live test of a credential. */
  connect(src: SourceHandle<Options>): Promise<ConnectReport>;
  catalog(src: SourceHandle<Options>): Promise<SourceCatalog>;
  /** One page of the ticket list; `next` null after the last page. */
  scan(src: SourceHandle<Options>, cursor: Cursor | null): Promise<{ rows: SourceRow[]; next: Cursor | null }>;
  load(src: SourceHandle<Options>, row: SourceRow): Promise<LoadedTicket>;
  /** Pure and synchronous. */
  convert(loaded: LoadedTicket, ctx: ConversionContext<Options>): Conversion;
  /**
   * One file's original bytes, at most `maxBytes`. A source 404/403 surfacing
   * as a SourceHttpError is a permanent `not_found` skip; a SourceUnavailableError
   * is transient (the ticket is retried by the next run).
   */
  fetchAttachment(src: SourceHandle<Options>, ref: AttachmentRef, maxBytes: number): Promise<Uint8Array>;
  probe(src: SourceHandle<Options>, sourceTicketKey: string): Promise<ProbeResult>;
  /**
   * A comment id the writer stored that this pass's conversion no longer
   * sends: is it a source article deleted in the source (§5.3 item 3)? False
   * for a note the module composed. `loaded` is the ticket this pass loaded,
   * so a module can also answer false for an article the source still holds
   * but did not send as a comment (it became the description, a toggle now
   * skips it) or moved to another ticket (a merge in the source, W0's note):
   * none of those was deleted.
   */
  isSourceArticleId(commentSourceId: string, loaded?: LoadedTicket): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTicketImportModule = TicketImportModule<any, any>;
