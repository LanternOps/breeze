/**
 * Shared types for the org import pipeline (issue #3242, epic #3249).
 *
 * The pipeline is preview → commit with a source seam: CSV is a pass-through
 * of client-parsed rows, and future sources (PSA `getCompanies()` — #3246,
 * QuickBooks once migrated onto the seam) implement `OrgImportSource`.
 */

export interface ImportRowContact {
  name?: string;
  email?: string;
  phone?: string;
}

/**
 * Structured billing address for the ORGANIZATION (not the site). Written to
 * the `organizations.billing_address_*` columns when a group creates the org;
 * values are clamped to the column widths and `country` is only persisted when
 * it is a genuine 2-letter code (the column is char(2)).
 */
export interface ImportRowBillingAddress {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
}

export interface ImportRow {
  /** Organization name. Repeat across rows to attach multiple sites. */
  organization: string;
  /** Site name; a group with no sites gets one default site named after the org. */
  site?: string;
  /** The source vendor's stable UID — preferred dedupe key. */
  externalId?: string;
  /** 'datto_rmm' | 'ninjaone' | 'csv' | ... ; defaults to 'csv'. */
  externalSystem?: string;
  /** IANA timezone for the site, validated by isValidIanaTimezone. */
  timezone?: string;
  /** Site address, stored as-is into the sites.address JSONB. */
  address?: unknown;
  contact?: ImportRowContact;
  /**
   * Organization billing address, applied only when the group CREATES the org.
   * Sources that carry billing data (QuickBooks) set it; CSV/PSA leave it unset
   * — an absent value never clears existing columns.
   */
  billingAddress?: ImportRowBillingAddress;
}

export type RowAnnotation =
  | 'create'
  | 'link-match'
  | 'name-match'
  | 'matched-soft-deleted'
  | 'conflict';

export interface AnnotatedRow extends ImportRow {
  /** Position in the submitted rows array. */
  index: number;
  annotation: RowAnnotation;
  /** Slug that a `create` would use; null when the row matched an existing org. */
  slug: string | null;
  /** The matched organization's id (link-match / name-match / matched-soft-deleted). */
  organizationId: string | null;
  /** The matched organization's current name, for the preview UI. */
  matchedOrganizationName?: string;
  /**
   * HOW the row matched, when it matched. `'link'` means the durable
   * `(system, external_id)` linkage resolved it; `'name'` means only the
   * normalised name did. The annotation alone does not carry this:
   * `matched-soft-deleted` is reached from BOTH branches, and a caller that
   * treats a name-matched dead org as "already imported" blocks the row
   * forever (the QuickBooks customer list did exactly that).
   */
  matchedBy?: 'link' | 'name';
  /**
   * True when the matched organization ALREADY carries a link row for this
   * row's `externalSystem` — i.e. it is spoken for by a DIFFERENT external id.
   * Callers must not offer "confirm this match": the link unique index is
   * `(partner_id, system, external_id)`, so confirming would happily add a
   * SECOND link row and collapse two source records onto one tenant.
   */
  matchedOrganizationLinkedToSystem?: boolean;
  /** Populated when annotation === 'conflict'. */
  conflictReason?: string;
}

export interface CommitRowInput extends ImportRow {
  /**
   * The annotation the client saw at preview time. Commit re-derives the
   * annotation from fresh DB state and rejects any row whose annotation
   * changed — preview is advisory, the unique index is authority. A
   * `name-match` is never committed as a match without this explicit
   * acknowledgement.
   */
  expectedAnnotation?: RowAnnotation;
  /**
   * The organizationId the client saw the row match at preview time. When
   * provided, commit rejects the row if the re-derived match resolves to a
   * DIFFERENT organization — an acknowledgement ("yes, this is org X") must
   * never be silently transferred to org Y that took over the name/link
   * between preview and commit.
   */
  expectedOrganizationId?: string;
  /**
   * Explicit opt-in to reactivate a soft-deleted matched org. Without it,
   * `matched-soft-deleted` rows are refused: never silently attach sites to a
   * dead tenant, never silently mint a duplicate beside it.
   */
  reactivate?: boolean;
  /**
   * Explicit "this is NOT that organization — create a new one anyway".
   * Honored for `name-match` and `matched-soft-deleted` rows, where it creates
   * a fresh, slug-suffixed org instead of touching the match.
   *
   * Without it, a source record that merely collides by name with a
   * soft-deleted org is unimportable by ANY route: the match can only be
   * satisfied with `reactivate`, and reactivating an unrelated dead tenant is
   * wrong. `reactivate` and `forceCreate` are mutually exclusive.
   */
  forceCreate?: boolean;
}

/** 'skip' leaves matched orgs untouched; 'update' patches only fields present in the row. */
export type OrgImportMode = 'skip' | 'update';

export interface OrgImportActor {
  userId: string | null;
}

/**
 * Why a row was skipped. Typed so adapters switch on a value instead of
 * pattern-matching prose.
 */
export type OrgImportSkipReason =
  | 'already_linked'
  | 'name_match_confirmed'
  | 'created_concurrently';

/**
 * Why a row failed. Adapters MUST branch on this rather than on the message
 * text: the messages are UI copy for the bulk-import screen and get reworded,
 * whereas these codes are the contract.
 */
export type OrgImportErrorCode =
  /** The row (or its batch group) is malformed or internally ambiguous. */
  | 'row-conflict'
  /** The re-derived annotation differs from the client's acknowledgement. */
  | 'annotation-changed'
  /** The acknowledged organization no longer matches. */
  | 'match-changed'
  /** A name match was not acknowledged (and no forceCreate). */
  | 'name-match-unconfirmed'
  /** A soft-deleted match carried neither reactivate nor forceCreate. */
  | 'soft-deleted-unconfirmed'
  /** The external id was linked to a DIFFERENT org by a concurrent import. */
  | 'external-id-conflict'
  /** A database write failed. `cause` carries the original error. */
  | 'write-failed';

export interface OrgImportErrorEntry {
  index: number;
  organization?: string;
  /** Human-readable copy. Adapters must branch on `code`, never on this. */
  error: string;
  code: OrgImportErrorCode;
  /**
   * The ORIGINAL thrown error for `write-failed`, so error trackers keep the
   * stack, `cause` chain and pg SQLSTATE that `error` (a flattened `.message`)
   * throws away. Defined as NON-ENUMERABLE, so it never reaches a JSON
   * response body — read it in-process, never serialize it.
   */
  cause?: unknown;
}

export interface OrgImportSummary {
  imported: Array<{
    index: number;
    organization: string;
    organizationId: string;
    /** Site created for THIS row (one per row; a group shares the org). */
    siteId: string | null;
    siteName: string | null;
    /** True on the group's first row — the row that created the org. */
    createdOrganization: boolean;
    /** True when a link row was written for this row's group. */
    createdLink: boolean;
    slug: string | null;
  }>;
  updated: Array<{
    index: number;
    organization: string;
    organizationId: string;
    /** Site created/updated for this row under the matched org, if any. */
    siteId: string | null;
    siteName: string | null;
    createdSite: boolean;
    createdLink: boolean;
    reactivated: boolean;
    /** Non-fatal note (e.g. the optional link persistence failed) — first row only. */
    warning?: string;
  }>;
  skipped: Array<{
    index: number;
    organization: string;
    organizationId: string | null;
    reason: OrgImportSkipReason;
    /**
     * True on the group's first row when the commit persisted the link row for
     * an acknowledged match (so future imports resolve by id, not name).
     */
    createdLink: boolean;
    /** Non-fatal note (e.g. the optional link persistence failed) — first row only. */
    warning?: string;
  }>;
  errors: OrgImportErrorEntry[];
}

export interface OrgImportContext {
  partnerId: string;
}

/**
 * Source seam (#3246): a source produces rows; the shared pipeline does
 * preview/commit. CSV is a pass-through of client-parsed rows.
 */
export interface OrgImportSource {
  /** Value written to organization_external_links.system. */
  system: string;
  list(ctx: OrgImportContext): Promise<ImportRow[]>;
}
