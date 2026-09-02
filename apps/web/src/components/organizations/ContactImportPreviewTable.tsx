import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

/**
 * Preview table for the CONTACT importer (#3258 W04).
 *
 * A sibling of OrgImportPreviewTable, deliberately not a generalization of it:
 * the two importers share a workflow (preview → acknowledge → commit) but not a
 * row contract, an annotation vocabulary, or a selection rule. `link-match`
 * here needs no acknowledgement (the durable external link IS the
 * acknowledgement), the two FUZZY annotations must pin the contact they
 * matched, and `org-not-found` has no org-importer analogue at all. Folding
 * them into one component would mean a union type whose every branch is
 * `if (kind === 'contact')`.
 *
 * Mirrors apps/api/src/services/contacts/types.ts — the JSON contract of
 * POST /orgs/contacts/import/preview and POST /orgs/contacts/import.
 */

export type ContactRowAnnotation =
  | 'create'
  | 'link-match'
  | 'email-match'
  | 'name-match'
  | 'conflict'
  | 'org-not-found';

/** The four annotations a client may acknowledge into a write. */
export type CommittableContactAnnotation = Exclude<
  ContactRowAnnotation,
  'conflict' | 'org-not-found'
>;

export interface ContactImportRow {
  organizationId?: string;
  organization?: string;
  /** The site NAME, not its id — resolved server-side within the organization. */
  site?: string;
  name?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  title?: string;
  roles?: string[];
  externalId?: string;
  externalSystem?: string;
}

export interface AnnotatedContactRow extends Omit<ContactImportRow, 'organizationId'> {
  /** Position in the submitted rows array. */
  index: number;
  annotation: ContactRowAnnotation;
  /** The RESOLVED organization, explicitly null when the row could not be placed. */
  organizationId: string | null;
  organizationName?: string;
  /** The resolved site pin; null means an organization-level contact. */
  siteId?: string | null;
  /** The matched contact (link-match / email-match / name-match). */
  contactId: string | null;
  matchedContactName?: string | null;
  matchedContactEmail?: string | null;
  /** Populated for `conflict` and `org-not-found`. */
  conflictReason?: string;
  /**
   * NON-FATAL disclosure: the row still applies exactly as `annotation` says.
   * Set when resolution made a judgement call — today, an email or name hint
   * that matched several contacts and was overridden into a `create` because
   * the row carries its own external id. Rendered amber beside the badge, never
   * red: a warning row is selectable and will be written.
   */
  warning?: string;
}

/** A row as submitted to a commit — mirrors `commitContactImportRowSchema`. */
export interface CommitContactRowInput extends ContactImportRow {
  expectedAnnotation?: CommittableContactAnnotation;
  expectedContactId?: string;
}

/** Mirrors `ContactImportErrorCode`. Branch on this, never on `error`. */
export type ContactImportErrorCode =
  | 'row-conflict'
  | 'org-not-found'
  | 'annotation-changed'
  | 'match-changed'
  | 'match-unconfirmed'
  | 'write-failed'
  | 'no-identifier'
  | 'invalid-role'
  | 'site-not-in-org';

export interface ContactImportResultEntry {
  index: number;
  organizationId: string;
  contactId: string;
  name: string | null;
  createdLink: boolean;
}

export interface ContactImportSummary {
  imported: ContactImportResultEntry[];
  updated: ContactImportResultEntry[];
  skipped: Array<{ index: number; organizationId: string; contactId: string; reason: string }>;
  errors: Array<{
    index: number;
    organization?: string;
    error: string;
    code: ContactImportErrorCode;
  }>;
}

const BADGE_STYLES: Record<ContactRowAnnotation, string> = {
  'create': 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  'link-match': 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400',
  'email-match': 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  'name-match': 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  'conflict': 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400',
  'org-not-found': 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400',
};

const BADGE_LABEL_KEYS: Record<ContactRowAnnotation, string> = {
  'create': 'contactImportPreview.badges.create',
  'link-match': 'contactImportPreview.badges.linkMatch',
  'email-match': 'contactImportPreview.badges.emailMatch',
  'name-match': 'contactImportPreview.badges.nameMatch',
  'conflict': 'contactImportPreview.badges.conflict',
  'org-not-found': 'contactImportPreview.badges.orgNotFound',
};

/** The two annotations that are HINTS: applied only on an explicit tick. */
const FUZZY_ANNOTATIONS: ReadonlySet<ContactRowAnnotation> = new Set(['email-match', 'name-match']);

/**
 * Every row the table lets the user tick. `conflict` and `org-not-found` are
 * absent from the server's commit enum — a row carrying either as an
 * acknowledgement fails Zod and rejects the WHOLE batch, not just that row.
 */
export function isContactRowSelectable(row: AnnotatedContactRow): boolean {
  return row.annotation !== 'conflict' && row.annotation !== 'org-not-found';
}

/**
 * The rows select-all is allowed to touch. A fuzzy email/name hint is a per-row
 * human judgement ("yes, that really is the same person"), so a bulk toggle
 * must never opt 500 of them into merging onto contacts nobody looked at.
 */
export function bulkSelectableContactRows(
  rows: readonly AnnotatedContactRow[],
): AnnotatedContactRow[] {
  return rows.filter((r) => r.annotation === 'create' || r.annotation === 'link-match');
}

/** The selection a fresh preview starts with: create + link-match only. */
export function defaultContactPreviewSelection(
  rows: readonly AnnotatedContactRow[],
): Set<number> {
  return new Set(bulkSelectableContactRows(rows).map((r) => r.index));
}

/**
 * Map an acknowledged preview row onto its commit payload.
 *
 * A fuzzy acknowledgement is dropped wholesale when the row carries no
 * `contactId` to pin: the server REQUIRES `expectedContactId` alongside an
 * `email-match`/`name-match` acknowledgement and rejects the entire request
 * without it, so half an acknowledgement would cost the operator every other
 * row in the file. Sending none instead lets the commit apply its own
 * unconfirmed-match refusal to this row alone.
 */
export function toContactCommitRow(row: AnnotatedContactRow): CommitContactRowInput {
  const committable = isContactRowSelectable(row);
  const pinned = row.contactId ?? undefined;
  const fuzzyWithoutPin = FUZZY_ANNOTATIONS.has(row.annotation) && pinned === undefined;
  return {
    ...(row.organizationId ? { organizationId: row.organizationId } : {}),
    ...(row.organization ? { organization: row.organization } : {}),
    ...(row.site ? { site: row.site } : {}),
    ...(row.name ? { name: row.name } : {}),
    ...(row.email ? { email: row.email } : {}),
    ...(row.phone ? { phone: row.phone } : {}),
    ...(row.mobile ? { mobile: row.mobile } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(row.roles && row.roles.length > 0 ? { roles: row.roles } : {}),
    ...(row.externalId ? { externalId: row.externalId } : {}),
    ...(row.externalSystem ? { externalSystem: row.externalSystem } : {}),
    ...(committable && !fuzzyWithoutPin
      ? {
          expectedAnnotation: row.annotation as CommittableContactAnnotation,
          // Pin the identity the user acknowledged: commit re-derives the match
          // and refuses the row if it now resolves to a DIFFERENT contact.
          ...(pinned ? { expectedContactId: pinned } : {}),
        }
      : {}),
  };
}

interface Props {
  rows: AnnotatedContactRow[];
  /** Indexes the user has acknowledged for commit. Owned by the host. */
  selected: ReadonlySet<number>;
  /**
   * A `useState` setter, NOT a plain callback: every selection change derives
   * from the previous selection, so the table always passes a functional
   * updater and two toggles in one tick cannot drop each other.
   */
  onSelectedChange: Dispatch<SetStateAction<Set<number>>>;
  /**
   * Prefix for every `data-testid` this table emits, e.g. `bulk-contact-import`
   * yields `-table`, `-select-all`, `-row-N`, `-select-N`, `-badge-N`. E2E
   * specs key off these, so a host must not change its prefix once shipped.
   */
  testIdPrefix: string;
}

export default function ContactImportPreviewTable({
  rows,
  selected,
  onSelectedChange,
  testIdPrefix,
}: Props) {
  const { t } = useTranslation('settings');
  const bulkRows = bulkSelectableContactRows(rows);

  function toggleRow(row: AnnotatedContactRow) {
    onSelectedChange((prev) => {
      const next = new Set(prev);
      if (next.has(row.index)) next.delete(row.index);
      // Un-ticking an unselectable row is always allowed (a host may hand us a
      // stale selection); ticking one never is.
      else if (isContactRowSelectable(row)) next.add(row.index);
      return next;
    });
  }

  function toggleAll() {
    onSelectedChange((prev) => {
      const next = new Set(prev);
      if (bulkRows.every((r) => next.has(r.index))) {
        // Deselect the bulk set only; an explicit fuzzy opt-in stays ticked.
        for (const r of bulkRows) next.delete(r.index);
      } else {
        for (const r of bulkRows) next.add(r.index);
      }
      return next;
    });
  }

  return (
    <div className="mt-2 max-h-96 overflow-y-auto rounded-md border">
      <table className="w-full text-sm" data-testid={`${testIdPrefix}-table`}>
        <thead>
          <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
            <th className="w-8 px-2 py-1.5">
              <input
                type="checkbox"
                data-testid={`${testIdPrefix}-select-all`}
                aria-label={t('contactImportPreview.selectAll')}
                checked={bulkRows.length > 0 && bulkRows.every((r) => selected.has(r.index))}
                onChange={toggleAll}
              />
            </th>
            <th className="px-2 py-1.5">{t('contactImportPreview.columns.name')}</th>
            <th className="px-2 py-1.5">{t('contactImportPreview.columns.email')}</th>
            <th className="px-2 py-1.5">{t('contactImportPreview.columns.site')}</th>
            <th className="px-2 py-1.5">{t('contactImportPreview.columns.status')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.index}
              data-testid={`${testIdPrefix}-row-${r.index}`}
              className="border-b border-border/50 last:border-0"
            >
              <td className="px-2 py-1.5">
                <input
                  type="checkbox"
                  data-testid={`${testIdPrefix}-select-${r.index}`}
                  checked={selected.has(r.index)}
                  disabled={!isContactRowSelectable(r)}
                  onChange={() => toggleRow(r)}
                />
              </td>
              <td className="px-2 py-1.5">{r.name ?? '—'}</td>
              <td className="px-2 py-1.5 text-muted-foreground">{r.email ?? '—'}</td>
              <td className="px-2 py-1.5 text-muted-foreground">
                {r.site ?? t('contactImportPreview.organizationLevel')}
              </td>
              <td className="px-2 py-1.5">
                <span
                  data-testid={`${testIdPrefix}-badge-${r.index}`}
                  className={`inline-flex rounded-full border px-2 py-0.5 text-xs ${BADGE_STYLES[r.annotation]}`}
                >
                  {t(/* i18n-dynamic */ BADGE_LABEL_KEYS[r.annotation])}
                </span>
                {FUZZY_ANNOTATIONS.has(r.annotation) && r.matchedContactName && (
                  <span
                    data-testid={`${testIdPrefix}-match-${r.index}`}
                    className="ml-2 text-xs text-muted-foreground"
                  >
                    {t('contactImportPreview.matches', { name: r.matchedContactName })}
                  </span>
                )}
                {/* Advisory, not fatal: the row still applies as annotated, so
                    this reads amber and the checkbox above stays enabled. */}
                {r.warning && (
                  <span
                    data-testid={`${testIdPrefix}-warning-${r.index}`}
                    className="ml-2 text-xs text-amber-700 dark:text-amber-400"
                  >
                    {r.warning}
                  </span>
                )}
                {!isContactRowSelectable(r) && r.conflictReason && (
                  <span
                    data-testid={`${testIdPrefix}-conflict-${r.index}`}
                    className="ml-2 text-xs text-red-700 dark:text-red-400"
                  >
                    {r.conflictReason}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
