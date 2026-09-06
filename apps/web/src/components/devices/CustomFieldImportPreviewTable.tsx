import { Fragment, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

/**
 * Preview table for the device custom-field VALUE importer (#3257 W09).
 *
 * Mirrors `apps/api/src/services/customFields/import/types.ts` — the JSON
 * contract of `POST /devices/custom-fields/import/preview` and
 * `POST /devices/custom-fields/import` (W08, #4776). Types are restated
 * structurally here rather than imported across the apps/api boundary, the
 * same convention `ContactImportPreviewTable.tsx` follows for the org/contact
 * importer.
 *
 * A sibling of `ContactImportPreviewTable.tsx`, not a generalization of it —
 * same reasoning that component documents: this importer's row contract
 * (per-VALUE outcomes, ranked device candidates) shares nothing with the
 * contact importer's (per-row fuzzy match) beyond the general preview/select
 * shape, so folding them into one component would mean a union type whose
 * every branch is `if (kind === 'device-value')`.
 *
 * This table renders the VALUES step only (Task 2 in the wave plan). The
 * definitions step (`CustomFieldDefinitionImportStep.tsx`) has its own,
 * much simpler row vocabulary (create / already-exists / type-conflict /
 * key-shadowed / org-not-found / partner-wide-denied — no device matching,
 * no per-value granularity) and renders it inline rather than through this
 * component, for the same non-generalization reason.
 */

export type DeviceMatchMethod = 'id' | 'link' | 'serial' | 'hostname';

export type ValueRowOutcome =
  | 'matched'
  | 'link-match'
  | 'ambiguous'
  | 'not-found'
  | 'org-not-found'
  | 'identity-conflict';

export interface DeviceCandidate {
  deviceId: string;
  hostname: string | null;
  displayName: string | null;
  serialNumber: string | null;
  osType: string | null;
  status: string | null;
  enrolledAt: string | null;
  lastSeenAt: string | null;
  siteId: string | null;
  method: DeviceMatchMethod;
}

export type MappingTarget =
  | { kind: 'customField'; fieldKey: string }
  | { kind: 'warranty'; field: 'warrantyStartDate' | 'warrantyEndDate' | 'manufacturer' };

export type ValueOutcome =
  | 'applied'
  | 'skipped-already-set'
  | 'skipped-provider-owned'
  | 'no-definition'
  | 'type-error'
  | 'not-applicable-to-device'
  | 'device-unresolved';

export type CustomFieldImportRejection =
  | 'invalid_type'
  | 'out_of_range'
  | 'not_a_choice'
  | 'too_long'
  | 'invalid_date';

interface ImportValueAdvice {
  target: MappingTarget;
  /**
   * Advisory, non-fatal — the value still applies exactly as `outcome` says.
   * Today the only producer is the reserved partner-integration identity key
   * warning (`asset_tag`/`inventory_id`/`external_id`); rendered amber, never
   * red, and never disables the row.
   */
  warning?: string;
}

/**
 * Discriminated on `outcome`, mirroring the API's own `AnnotatedImportValue`
 * (types.ts) exactly: `reason` is reachable ONLY on `type-error`. A flat
 * `reason?: CustomFieldImportRejection` would let a producer (or a test
 * fixture) construct `{ outcome: 'applied', reason: 'too_long' }`, and the
 * renderer below would show a stray rejection reason on a value the badge
 * says succeeded.
 */
export type AnnotatedImportValue = ImportValueAdvice & (
  | { outcome: 'type-error'; reason: CustomFieldImportRejection }
  | { outcome: Exclude<ValueOutcome, 'type-error'>; reason?: never }
);

export interface AnnotatedValueRow {
  index: number;
  outcome: ValueRowOutcome;
  deviceId: string | null;
  method: DeviceMatchMethod | null;
  organizationId: string | null;
  /** Ranked; populated only for `ambiguous` / `identity-conflict`. */
  candidates: DeviceCandidate[];
  conflictingMethods?: DeviceMatchMethod[];
  discardedIdentifiers?: DeviceMatchMethod[];
  values: AnnotatedImportValue[];
}

const OUTCOME_BADGE_STYLES: Record<ValueRowOutcome, string> = {
  matched: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  'link-match': 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400',
  ambiguous: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  'not-found': 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400',
  'org-not-found': 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400',
  'identity-conflict': 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400',
};

const OUTCOME_LABEL_KEYS: Record<ValueRowOutcome, string> = {
  matched: 'customFieldImportPreview.rowOutcomes.matched',
  'link-match': 'customFieldImportPreview.rowOutcomes.linkMatch',
  ambiguous: 'customFieldImportPreview.rowOutcomes.ambiguous',
  'not-found': 'customFieldImportPreview.rowOutcomes.notFound',
  'org-not-found': 'customFieldImportPreview.rowOutcomes.orgNotFound',
  'identity-conflict': 'customFieldImportPreview.rowOutcomes.identityConflict',
};

const VALUE_OUTCOME_LABEL_KEYS: Record<ValueOutcome, string> = {
  applied: 'customFieldImportPreview.valueOutcomes.applied',
  'skipped-already-set': 'customFieldImportPreview.valueOutcomes.skippedAlreadySet',
  'skipped-provider-owned': 'customFieldImportPreview.valueOutcomes.skippedProviderOwned',
  'no-definition': 'customFieldImportPreview.valueOutcomes.noDefinition',
  'type-error': 'customFieldImportPreview.valueOutcomes.typeError',
  'not-applicable-to-device': 'customFieldImportPreview.valueOutcomes.notApplicable',
  'device-unresolved': 'customFieldImportPreview.valueOutcomes.deviceUnresolved',
};

const VALUE_OUTCOME_STYLES: Record<ValueOutcome, string> = {
  applied: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  'skipped-already-set': 'bg-muted text-muted-foreground',
  'skipped-provider-owned': 'bg-muted text-muted-foreground',
  'no-definition': 'bg-red-500/10 text-red-700 dark:text-red-400',
  'type-error': 'bg-red-500/10 text-red-700 dark:text-red-400',
  'not-applicable-to-device': 'bg-muted text-muted-foreground',
  'device-unresolved': 'bg-muted text-muted-foreground',
};

/** Row outcomes that resolved to exactly one device without operator input. */
const AUTO_RESOLVED: ReadonlySet<ValueRowOutcome> = new Set(['matched', 'link-match']);

/**
 * The ONLY outcome a candidate pick can turn into a commit. `identity-conflict`
 * is deliberately excluded: the server's own commit loop (`valueImport.ts`)
 * refuses it unconditionally via `REFUSED_OUTCOMES`, checked BEFORE it ever
 * reads `expectedDeviceId` — no pin, however confident, changes the outcome.
 * The only real fix for a conflicting-identifiers row is correcting the file
 * and re-running preview, so letting the UI make it "pickable" would train an
 * operator to trust a control that has no effect on the wire.
 */
const SELECTABLE_VIA_PICK: ReadonlySet<ValueRowOutcome> = new Set(['ambiguous']);

/** Row outcomes whose ranked candidates are worth showing at all — as an
 *  actionable pick for `ambiguous`, or as read-only diagnostic evidence
 *  ("here is what each identifier on this row matched") for `identity-conflict`. */
const SHOWS_CANDIDATES: ReadonlySet<ValueRowOutcome> = new Set(['ambiguous', 'identity-conflict']);

/**
 * Every row the table lets the user tick. `ambiguous` becomes selectable only
 * once the caller has recorded a pick for that row — ticking one before that
 * would commit with no `expectedDeviceId` to pin. `identity-conflict` is never
 * selectable, picked or not (see `SELECTABLE_VIA_PICK`).
 */
export function isValueRowSelectable(row: AnnotatedValueRow, picks: ReadonlyMap<number, string>): boolean {
  if (AUTO_RESOLVED.has(row.outcome)) return true;
  if (SELECTABLE_VIA_PICK.has(row.outcome)) return picks.has(row.index);
  return false;
}

/**
 * The rows select-all is allowed to touch. `ambiguous`/`identity-conflict`
 * are EXCLUDED even once picked: a bulk toggle here would still be widening
 * one checkbox click into "trust every automatic candidate resolution in
 * this file", exactly the blast radius the required per-row pick exists to
 * prevent. Mirrors `bulkSelectableContactRows`.
 */
export function bulkSelectableValueRows(rows: readonly AnnotatedValueRow[]): AnnotatedValueRow[] {
  return rows.filter((r) => AUTO_RESOLVED.has(r.outcome));
}

/** The selection a fresh preview starts with: matched + link-match only. */
export function defaultValueImportSelection(rows: readonly AnnotatedValueRow[]): Set<number> {
  return new Set(bulkSelectableValueRows(rows).map((r) => r.index));
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

interface Props {
  rows: AnnotatedValueRow[];
  /** Indexes the user has acknowledged for commit. Owned by the host. */
  selected: ReadonlySet<number>;
  /** A `useState` setter — every change derives from the previous selection. */
  onSelectedChange: Dispatch<SetStateAction<Set<number>>>;
  /** Row index → the candidate deviceId picked for an ambiguous/identity-conflict row. */
  picks: ReadonlyMap<number, string>;
  onPick: (rowIndex: number, deviceId: string) => void;
}

export default function CustomFieldImportPreviewTable({ rows, selected, onSelectedChange, picks, onPick }: Props) {
  const { t } = useTranslation('devices');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const bulkRows = bulkSelectableValueRows(rows);

  function toggleRow(row: AnnotatedValueRow) {
    onSelectedChange((prev) => {
      const next = new Set(prev);
      if (next.has(row.index)) next.delete(row.index);
      else if (isValueRowSelectable(row, picks)) next.add(row.index);
      return next;
    });
  }

  function toggleAll() {
    onSelectedChange((prev) => {
      const next = new Set(prev);
      if (bulkRows.every((r) => next.has(r.index))) {
        for (const r of bulkRows) next.delete(r.index);
      } else {
        for (const r of bulkRows) next.add(r.index);
      }
      return next;
    });
  }

  function toggleExpand(index: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function targetLabel(target: MappingTarget): string {
    return target.kind === 'warranty'
      ? t(/* i18n-dynamic */ `customFieldImportPreview.warrantyFields.${target.field}`, { defaultValue: target.field })
      : target.fieldKey;
  }

  return (
    <div className="mt-2 max-h-[32rem] overflow-y-auto rounded-md border">
      <table className="w-full text-sm" data-testid="cf-import-table">
        <thead>
          <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
            <th className="w-8 px-2 py-1.5">
              <input
                type="checkbox"
                data-testid="cf-import-select-all"
                aria-label={t('customFieldImportPreview.selectAll')}
                checked={bulkRows.length > 0 && bulkRows.every((r) => selected.has(r.index))}
                onChange={toggleAll}
              />
            </th>
            <th className="px-2 py-1.5">{t('customFieldImportPreview.columns.device')}</th>
            <th className="px-2 py-1.5">{t('customFieldImportPreview.columns.status')}</th>
            <th className="px-2 py-1.5">{t('customFieldImportPreview.columns.values')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const selectable = isValueRowSelectable(row, picks);
            const canExpand = SHOWS_CANDIDATES.has(row.outcome) && row.candidates.length > 0;
            const canPick = row.outcome === 'ambiguous';
            const isExpanded = expanded.has(row.index);
            const pickedId = picks.get(row.index);
            return (
              <Fragment key={row.index}>
                <tr
                  data-testid={`cf-import-row-${row.index}`}
                  aria-disabled={!selectable}
                  className={`border-b border-border/50 last:border-0 ${!selectable ? 'opacity-70' : ''}`}
                >
                  <td className="px-2 py-1.5 align-top">
                    <input
                      type="checkbox"
                      data-testid={`cf-import-select-${row.index}`}
                      checked={selected.has(row.index)}
                      disabled={!selectable}
                      onChange={() => toggleRow(row)}
                    />
                  </td>
                  <td className="px-2 py-1.5 align-top text-muted-foreground">
                    {row.deviceId ?? t('customFieldImportPreview.unresolved')}
                  </td>
                  <td className="px-2 py-1.5 align-top">
                    <span
                      data-testid={`cf-import-badge-${row.index}`}
                      className={`inline-flex rounded-full border px-2 py-0.5 text-xs ${OUTCOME_BADGE_STYLES[row.outcome]}`}
                    >
                      {t(/* i18n-dynamic */ OUTCOME_LABEL_KEYS[row.outcome])}
                    </span>
                    {canExpand && (
                      <button
                        type="button"
                        data-testid={`cf-import-expand-${row.index}`}
                        onClick={() => toggleExpand(row.index)}
                        className="ml-2 text-xs font-medium text-primary underline-offset-2 hover:underline"
                      >
                        {isExpanded
                          ? t('customFieldImportPreview.hideCandidates')
                          : t('customFieldImportPreview.showCandidates', { count: row.candidates.length })}
                      </button>
                    )}
                    {pickedId && (
                      <span
                        data-testid={`cf-import-picked-${row.index}`}
                        className="ml-2 text-xs text-muted-foreground"
                      >
                        {t('customFieldImportPreview.picked', { deviceId: pickedId })}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 align-top">
                    <ul className="space-y-1">
                      {row.values.map((v, vi) => (
                        <li key={vi} className="flex flex-wrap items-center gap-1.5 text-xs">
                          <span className="text-muted-foreground">{targetLabel(v.target)}:</span>
                          <span
                            data-testid={`cf-import-value-outcome-${v.outcome}`}
                            className={`inline-flex rounded px-1.5 py-0.5 ${VALUE_OUTCOME_STYLES[v.outcome]}`}
                          >
                            {t(/* i18n-dynamic */ VALUE_OUTCOME_LABEL_KEYS[v.outcome])}
                          </span>
                          {v.warning && (
                            <span
                              data-testid="cf-import-reserved-key-warning"
                              className="text-amber-700 dark:text-amber-400"
                            >
                              {v.warning}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
                {canExpand && isExpanded && (
                  <tr className="border-b border-border/50 bg-muted/20">
                    <td />
                    <td colSpan={3} className="px-2 py-2">
                      {row.outcome === 'identity-conflict' && (
                        <p data-testid={`cf-import-conflict-note-${row.index}`} className="mb-2 text-xs text-destructive">
                          {t('customFieldImportPreview.identityConflictNote')}
                        </p>
                      )}
                      <ul className="space-y-2">
                        {row.candidates.map((c, ci) => (
                          <li
                            key={c.deviceId}
                            data-testid={`cf-import-candidate-${ci}`}
                            className="flex flex-wrap items-center gap-3 rounded-md border bg-background p-2 text-xs"
                          >
                            <span className="font-medium text-foreground">
                              {c.displayName ?? c.hostname ?? c.deviceId}
                            </span>
                            <span data-testid="cf-import-candidate-serial" className="text-muted-foreground">
                              {t('customFieldImportPreview.candidate.serial', { value: c.serialNumber ?? '—' })}
                            </span>
                            <span data-testid="cf-import-candidate-os" className="text-muted-foreground">
                              {t('customFieldImportPreview.candidate.os', { value: c.osType ?? '—' })}
                            </span>
                            <span data-testid="cf-import-candidate-enrolled" className="text-muted-foreground">
                              {t('customFieldImportPreview.candidate.enrolled', { value: formatDate(c.enrolledAt) })}
                            </span>
                            <span data-testid="cf-import-candidate-last-seen" className="text-muted-foreground">
                              {t('customFieldImportPreview.candidate.lastSeen', { value: formatDate(c.lastSeenAt) })}
                            </span>
                            {canPick && (
                              <button
                                type="button"
                                data-testid={`cf-import-candidate-${ci}-pick`}
                                onClick={() => onPick(row.index, c.deviceId)}
                                className={`ml-auto rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted ${
                                  pickedId === c.deviceId ? 'border-primary bg-primary/10 text-primary' : ''
                                }`}
                              >
                                {pickedId === c.deviceId
                                  ? t('customFieldImportPreview.candidate.picked')
                                  : t('customFieldImportPreview.candidate.pick')}
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
