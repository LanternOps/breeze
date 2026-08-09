import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

/**
 * The org-import preview table, shared by every import SOURCE (#3246).
 *
 * `POST /orgs/import` (CSV) and `POST /psa/connections/:id/import` accept the
 * identical row contract (apps/api/src/services/orgImport/schemas.ts), so the
 * acknowledgement UI — what is pre-selected, what must be ticked deliberately,
 * what can never be selected — belongs in ONE component. Nothing in this file
 * knows where the rows came from: it takes annotated preview rows plus the
 * row-level selection state and reports selection changes back to the host.
 *
 * The i18n keys deliberately stay under `settings:bulkOrgImport.*`. They are
 * source-neutral strings ("Organization", "Site", "New", "Conflict", …) that
 * predate the extraction; renaming them would churn seven locale catalogs for
 * no user-visible gain.
 */

// Mirrors apps/api/src/services/orgImport/types.ts — the JSON contract of
// POST /orgs/import/preview and POST /orgs/import.
export type RowAnnotation = 'create' | 'link-match' | 'name-match' | 'matched-soft-deleted' | 'conflict';

export interface ImportRow {
  organization: string;
  site?: string;
  externalId?: string;
  externalSystem?: string;
  timezone?: string;
}

export interface AnnotatedRow extends ImportRow {
  index: number;
  annotation: RowAnnotation;
  slug: string | null;
  organizationId: string | null;
  matchedOrganizationName?: string;
  /**
   * True when the organization this row matched BY NAME already carries a link
   * row for this row's `externalSystem` — i.e. it is spoken for by a DIFFERENT
   * external id. The link table's unique index is
   * `(partner_id, system, external_id)`, so confirming the match would happily
   * write a SECOND link row and collapse two source companies onto one Breeze
   * tenant. Such a row is never confirmable from this table; `forceCreate`
   * ("this is NOT that org, make a new one") stays the legitimate escape hatch.
   *
   * The API refuses it server-side too (`OrgImportErrorCode`
   * `'match-already-linked'`) — this flag exists so the UI never OFFERS the
   * confirmation in the first place.
   */
  matchedOrganizationLinkedToSystem?: boolean;
  conflictReason?: string;
}

/** A row as submitted to a commit — mirrors `commitImportRowSchema`. */
export interface CommitRowInput extends ImportRow {
  /**
   * Optional, exactly as on the server: a row with no acknowledgement is one
   * the UI refuses to confirm (see `toCommitRow`), and the commit then applies
   * its own unconfirmed-match refusal.
   */
  expectedAnnotation?: RowAnnotation;
  expectedOrganizationId?: string;
  reactivate?: boolean;
  forceCreate?: boolean;
}

export interface OrgImportSummary {
  imported: Array<{ index: number; organization: string; organizationId: string }>;
  updated: Array<{ index: number; organization: string; organizationId: string }>;
  skipped: Array<{ index: number; organization: string; reason: string }>;
  errors: Array<{ index: number; organization?: string; error: string }>;
}

const BADGE_STYLES: Record<RowAnnotation, string> = {
  'create': 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  'link-match': 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400',
  'name-match': 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  'matched-soft-deleted': 'border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400',
  'conflict': 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400',
};

const BADGE_LABEL_KEYS: Record<RowAnnotation, string> = {
  'create': 'bulkOrgImport.badges.create',
  'link-match': 'bulkOrgImport.badges.linkMatch',
  'name-match': 'bulkOrgImport.badges.nameMatch',
  'matched-soft-deleted': 'bulkOrgImport.badges.softDeleted',
  'conflict': 'bulkOrgImport.badges.conflict',
};

/**
 * A row whose match cannot be confirmed at all: the matched organization is
 * ALREADY linked to this row's external system under a different external id,
 * so accepting the match would merge two source records onto one tenant.
 */
export function isMatchAlreadyLinked(row: AnnotatedRow): boolean {
  return row.matchedOrganizationLinkedToSystem === true;
}

/** Every row the table lets the user tick, in bulk or individually. */
export function isRowSelectable(row: AnnotatedRow): boolean {
  return row.annotation !== 'conflict' && !isMatchAlreadyLinked(row);
}

/**
 * The rows select-all is allowed to touch. name-match acknowledgement and
 * soft-deleted reactivation are per-row decisions — a bulk toggle must never
 * opt 500 rows into reactivating dead tenants in one click. Conflict rows and
 * already-linked matches are never selectable at all.
 */
export function bulkSelectableRows(rows: readonly AnnotatedRow[]): AnnotatedRow[] {
  return rows.filter(
    (r) => (r.annotation === 'create' || r.annotation === 'link-match') && isRowSelectable(r),
  );
}

/** The selection a fresh preview starts with: create + link-match only. */
export function defaultPreviewSelection(rows: readonly AnnotatedRow[]): Set<number> {
  return new Set(bulkSelectableRows(rows).map((r) => r.index));
}

/**
 * Map an acknowledged preview row onto its commit payload.
 *
 * `includeExternalSystem` is false for sources where the SERVER owns the value
 * (the PSA import forces it to the connection's provider slug, so sending one
 * is at best ignored and at worst a mismatched dedupe key).
 *
 * A row whose match is already linked to this system under a different id
 * carries NO acknowledgement at all — no `expectedAnnotation`, no
 * `expectedOrganizationId`, no `reactivate`. The table never lets such a row be
 * ticked, so this is defence in depth against a host that hands us a stale
 * selection: an acknowledgement is exactly the thing that would let the commit
 * write a second link row onto one tenant.
 */
export function toCommitRow(
  row: AnnotatedRow,
  options: { includeExternalSystem?: boolean } = {},
): CommitRowInput {
  const { includeExternalSystem = true } = options;
  const alreadyLinked = isMatchAlreadyLinked(row);
  return {
    organization: row.organization,
    ...(row.site ? { site: row.site } : {}),
    ...(row.externalId ? { externalId: row.externalId } : {}),
    ...(includeExternalSystem && row.externalSystem ? { externalSystem: row.externalSystem } : {}),
    ...(row.timezone ? { timezone: row.timezone } : {}),
    ...(alreadyLinked
      ? {}
      : {
          expectedAnnotation: row.annotation,
          // Pin the identity the user acknowledged: commit re-derives the match
          // and rejects the row if it now resolves to a DIFFERENT organization.
          ...(row.organizationId ? { expectedOrganizationId: row.organizationId } : {}),
          ...(row.annotation === 'matched-soft-deleted' ? { reactivate: true } : {}),
        }),
  };
}

interface Props {
  rows: AnnotatedRow[];
  /** Indexes the user has acknowledged for commit. Owned by the host. */
  selected: ReadonlySet<number>;
  /**
   * A `useState` setter, NOT a plain callback: every selection change here
   * derives from the previous selection, so the table always passes a
   * functional updater. Reading `selected` (a prop captured at render) to
   * build the next set would drop one of two toggles fired in the same tick.
   */
  onSelectedChange: Dispatch<SetStateAction<Set<number>>>;
  /**
   * Prefix for every `data-testid` this table emits, e.g. `bulk-org-import`
   * yields `bulk-org-import-table`, `-select-all`, `-row-N`, `-select-N`,
   * `-badge-N`. E2E specs key off these, so a host must not change its prefix
   * once shipped.
   */
  testIdPrefix: string;
}

export default function OrgImportPreviewTable({
  rows,
  selected,
  onSelectedChange,
  testIdPrefix,
}: Props) {
  const { t } = useTranslation('settings');
  const bulkRows = bulkSelectableRows(rows);

  function toggleRow(row: AnnotatedRow) {
    onSelectedChange((prev) => {
      const next = new Set(prev);
      if (next.has(row.index)) next.delete(row.index);
      // Un-ticking an unselectable row is always allowed (a host may hand us a
      // stale selection); ticking one never is.
      else if (isRowSelectable(row)) next.add(row.index);
      return next;
    });
  }

  function toggleAll() {
    onSelectedChange((prev) => {
      const next = new Set(prev);
      if (bulkRows.every((r) => next.has(r.index))) {
        // Deselect the bulk set; explicit per-row opt-ins (name-match /
        // reactivate) stay as ticked.
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
                aria-label={t('bulkOrgImport.preview.selectAll')}
                checked={bulkRows.length > 0 && bulkRows.every((r) => selected.has(r.index))}
                onChange={toggleAll}
              />
            </th>
            <th className="px-2 py-1.5">{t('bulkOrgImport.preview.organization')}</th>
            <th className="px-2 py-1.5">{t('bulkOrgImport.preview.site')}</th>
            <th className="px-2 py-1.5">{t('bulkOrgImport.preview.externalId')}</th>
            <th className="px-2 py-1.5">{t('bulkOrgImport.preview.status')}</th>
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
                  disabled={!isRowSelectable(r)}
                  onChange={() => toggleRow(r)}
                />
              </td>
              <td className="px-2 py-1.5">{r.organization}</td>
              <td className="px-2 py-1.5 text-muted-foreground">{r.site ?? '—'}</td>
              <td className="px-2 py-1.5 text-muted-foreground">{r.externalId ?? '—'}</td>
              <td className="px-2 py-1.5">
                <span
                  data-testid={`${testIdPrefix}-badge-${r.index}`}
                  className={`inline-flex rounded-full border px-2 py-0.5 text-xs ${BADGE_STYLES[r.annotation]}`}
                >
                  {t(/* i18n-dynamic */ BADGE_LABEL_KEYS[r.annotation])}
                </span>
                {r.annotation === 'name-match' && r.matchedOrganizationName && !isMatchAlreadyLinked(r) && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {t('bulkOrgImport.preview.matches', { name: r.matchedOrganizationName })}
                  </span>
                )}
                {r.annotation === 'matched-soft-deleted' && !isMatchAlreadyLinked(r) && (
                  <span className="ml-2 text-xs text-orange-700 dark:text-orange-400">
                    {t('bulkOrgImport.preview.reactivateHint')}
                  </span>
                )}
                {/* Confirming this match would write a SECOND link row for the
                    same (system, org) pair and merge two source records onto
                    one tenant. The checkbox above is disabled; this says why. */}
                {isMatchAlreadyLinked(r) && (
                  <span
                    data-testid={`${testIdPrefix}-already-linked-${r.index}`}
                    className="ml-2 text-xs text-red-700 dark:text-red-400"
                  >
                    {t('bulkOrgImport.preview.matchAlreadyLinked', {
                      name: r.matchedOrganizationName ?? r.organization,
                    })}
                  </span>
                )}
                {r.annotation === 'conflict' && r.conflictReason && (
                  <span className="ml-2 text-xs text-red-700 dark:text-red-400">{r.conflictReason}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
