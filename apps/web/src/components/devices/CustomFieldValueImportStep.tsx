import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { MAX_IMPORT_ROWS, MAX_IMPORT_VALUES, type CustomFieldType } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { runAction } from '../../lib/runAction';
import { parseCsv } from '../../lib/csvParse';
import { asList } from '@/lib/asList';
import { coerceCellForType, type CustomFieldImportDateFormat } from './customFieldImportCoercion';
import type { ImportSystem } from './CustomFieldDefinitionImportStep';
import CustomFieldImportPreviewTable, {
  bulkSelectableValueRows,
  defaultValueImportSelection,
  isValueRowSelectable,
  type AnnotatedValueRow,
  type MappingTarget,
} from './CustomFieldImportPreviewTable';

/**
 * Step 2 of the "Import from another RMM" wizard (#3257 W09): the VALUES
 * half, driving `POST /devices/custom-fields/import/preview` and
 * `POST /devices/custom-fields/import` (W08, #4776).
 *
 * Unlike the definitions step, this is a genuine column-mapped data import
 * (one CSV row is one device), so it follows `BulkContactImport.tsx`'s
 * upload → map → preview → commit shape — with two additions the plan calls
 * for: a per-column TARGET (identifier | custom field | warranty | ignore)
 * rather than a fixed field list, and chunked preview/commit against the
 * shared `MAX_IMPORT_ROWS` / `MAX_IMPORT_VALUES` caps, since a real fleet
 * export routinely exceeds either cap in one file.
 */

type IdentifierField = 'organizationId' | 'deviceId' | 'externalSystem' | 'externalId' | 'serialNumber' | 'hostname';

const IDENTIFIER_FIELDS: IdentifierField[] = [
  'deviceId',
  'externalSystem',
  'externalId',
  'serialNumber',
  'hostname',
  'organizationId',
];

const WARRANTY_FIELDS: Array<'warrantyStartDate' | 'warrantyEndDate' | 'manufacturer'> = [
  'warrantyStartDate',
  'warrantyEndDate',
  'manufacturer',
];

/** One column's role. Encoded as a single string for a plain `<select>`. */
type ColumnRole =
  | 'ignore'
  | `identifier:${IdentifierField}`
  | 'customField'
  | `warranty:${(typeof WARRANTY_FIELDS)[number]}`;

export interface DeviceCustomFieldImportValue {
  target: MappingTarget;
  value: unknown;
}

export interface DeviceCustomFieldImportRow {
  organizationId?: string | null;
  deviceId?: string | null;
  externalSystem?: string | null;
  externalId?: string | null;
  serialNumber?: string | null;
  hostname?: string | null;
  values: DeviceCustomFieldImportValue[];
}

/**
 * Split rows into request-sized batches under BOTH `MAX_IMPORT_ROWS` and
 * `MAX_IMPORT_VALUES` — a row cap alone does not bound the work, mirroring the
 * server's own `rowsSchema` refinement.
 *
 * A single row whose OWN value count already exceeds `maxValues` cannot be
 * split further (a device row is atomic) and is sent alone as a best effort;
 * in practice a row carries at most ~30 values, far under any real cap.
 *
 * `getValueCount` defaults to reading `.values.length` off each row, but can
 * be overridden so this same splitting algorithm works over rows wrapped with
 * extra bookkeeping (see `commit()`'s index-tracking wrapper below) without
 * duplicating the chunking logic.
 */
export function chunkValueRows<T>(
  rows: readonly T[],
  maxRows: number,
  maxValues: number,
  getValueCount: (row: T) => number = (row) => (row as { values: unknown[] }).values.length,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let valueCount = 0;
  for (const row of rows) {
    const rowValues = getValueCount(row);
    if (current.length > 0 && (current.length >= maxRows || valueCount + rowValues > maxValues)) {
      chunks.push(current);
      current = [];
      valueCount = 0;
    }
    current.push(row);
    valueCount += rowValues;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export interface ValueImportSummary {
  appliedValues: number;
  skippedValues: number;
  failedValues: number;
  rows: Array<{ index: number; deviceId: string; organizationId: string; method: string; externalSystem: string | null; applied: number; skipped: number; failed: number; appliedFieldKeys: string[]; warranty: string; linkCreated: boolean }>;
  linksCreated: number;
  errors: Array<{ index: number; error: string; code: string }>;
}

/**
 * Merge one chunk's commit response into the running aggregate, remapping
 * `rows[].index` / `errors[].index` from CHUNK-LOCAL (0-based within that
 * request) back to the ORIGINAL global preview-row index via `originalIndexes`
 * (the ordered list of original indexes the chunk was built from).
 *
 * This is not a simple offset add: `chosenRows` is a SUBSET of the previewed
 * rows (only the ticked ones), so a chunk's original indexes are not
 * necessarily contiguous (e.g. rows 2 and 5 selected, row 3-4 unticked) — an
 * offset would silently mislabel every row after the first gap. Looking up
 * `originalIndexes[localIndex]` is correct regardless of gaps.
 */
export function mergeCommitChunkResult(
  aggregate: ValueImportSummary,
  chunkResult: ValueImportSummary,
  originalIndexes: readonly number[],
): void {
  aggregate.appliedValues += chunkResult.appliedValues;
  aggregate.skippedValues += chunkResult.skippedValues;
  aggregate.failedValues += chunkResult.failedValues;
  aggregate.linksCreated += chunkResult.linksCreated;
  for (const r of chunkResult.rows) {
    aggregate.rows.push({ ...r, index: originalIndexes[r.index] ?? r.index });
  }
  for (const e of chunkResult.errors) {
    aggregate.errors.push({ ...e, index: originalIndexes[e.index] ?? e.index });
  }
}

function targetTypeFor(target: MappingTarget, fieldTypeByKey: Record<string, CustomFieldType>): CustomFieldType {
  if (target.kind === 'warranty') return target.field === 'manufacturer' ? 'text' : 'date';
  return fieldTypeByKey[target.fieldKey] ?? 'text';
}

interface Props {
  /** The organization every row resolves within, unless a column maps organizationId. */
  organizationId: string | null;
  /** The incumbent RMM this file was exported from — recorded in the audit trail. */
  source: ImportSystem;
  onCommitted?: (summary: ValueImportSummary) => void;
  onUnauthorized?: () => void;
}

export default function CustomFieldValueImportStep({ organizationId, source, onCommitted, onUnauthorized }: Props) {
  const { t } = useTranslation('devices');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<string[][]>([]);
  const [roles, setRoles] = useState<Record<string, ColumnRole>>({});
  const [fieldKeys, setFieldKeys] = useState<Record<string, string>>({});
  const [dateFormat, setDateFormat] = useState<CustomFieldImportDateFormat>('ISO');
  const [mode, setMode] = useState<'skip' | 'update'>('skip');
  const [overrideProviderWarranty, setOverrideProviderWarranty] = useState(false);

  const [fieldTypeByKey, setFieldTypeByKey] = useState<Record<string, CustomFieldType>>({});
  const [conflictingFieldKeys, setConflictingFieldKeys] = useState<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    fetchWithAuth('/custom-fields')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`GET /custom-fields → ${r.status}`))))
      .then((data) => {
        if (cancelled) return;
        const list = asList<{ fieldKey: string; type: CustomFieldType }>(data);
        const byKey: Record<string, CustomFieldType> = {};
        const conflicts = new Set<string>();
        for (const f of list) {
          // A partner-wide caller's GET /custom-fields can return every org's
          // definitions. Two orgs may legitimately give the same key different
          // types (e.g. one org's leftover text field vs another's number
          // field of the same name) — coercing every row against whichever
          // definition happened to sort last would silently corrupt the other
          // org's column. Detected conflicts fall back to no type-specific
          // coercion (raw pass-through), same as an unknown key.
          if (f.fieldKey in byKey && byKey[f.fieldKey] !== f.type) {
            conflicts.add(f.fieldKey);
          } else {
            byKey[f.fieldKey] = f.type;
          }
        }
        setFieldTypeByKey(byKey);
        setConflictingFieldKeys(conflicts);
      })
      .catch((err: unknown) => {
        // Best-effort lookup: unknown field types fall back to 'text'
        // coercion, which the server's own type-error annotation catches
        // downstream — but a failure here should still leave a trace, since
        // silently downgrading every number/boolean/date column to text is
        // otherwise invisible to anyone debugging a "why is this a type-error"
        // report.
        console.error('[CustomFieldValueImportStep] field-type lookup failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const [previewRows, setPreviewRows] = useState<AnnotatedValueRow[] | null>(null);
  const [previewStale, setPreviewStale] = useState(false);
  const [builtRows, setBuiltRows] = useState<DeviceCustomFieldImportRow[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [picks, setPicks] = useState<Map<number, string>>(new Map());
  const [previewing, setPreviewing] = useState(false);
  const [previewProgress, setPreviewProgress] = useState<{ done: number; total: number } | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitProgress, setCommitProgress] = useState<{ done: number; total: number } | null>(null);
  const [summary, setSummary] = useState<ValueImportSummary | null>(null);
  const [notAttempted, setNotAttempted] = useState(0);

  function loadFile(file: File) {
    void file.text().then((text) => {
      const parsed = parseCsv(text);
      setFileName(file.name);
      setHeaders(parsed.headers);
      setCsvRows(parsed.rows);
      setRoles({});
      setFieldKeys({});
      setPreviewRows(null);
      setPreviewStale(false);
      setBuiltRows([]);
      setSelected(new Set());
      setPicks(new Map());
      setSummary(null);
      setNotAttempted(0);
    });
  }

  function setRole(header: string, role: ColumnRole) {
    setRoles((prev) => ({ ...prev, [header]: role }));
    // The mapping changed; whatever is on screen no longer reflects it until
    // a fresh preview replaces it.
    if (previewRows) setPreviewStale(true);
  }

  /** Every mapped-column row, coerced against its target's declared type. Rows
   *  that resolve zero identifiers AND zero values are dropped (nothing to
   *  send, nothing to resolve against). */
  const mapped = useMemo<{ rows: DeviceCustomFieldImportRow[]; dropped: number }>(() => {
    if (headers.length === 0) return { rows: [], dropped: 0 };
    const idxOf = (h: string) => headers.indexOf(h);
    const identifierCols: Partial<Record<IdentifierField, number>> = {};
    const valueCols: Array<{ idx: number; target: MappingTarget }> = [];
    for (const header of headers) {
      const role = roles[header];
      if (!role || role === 'ignore') continue;
      if (role.startsWith('identifier:')) {
        const field = role.slice('identifier:'.length) as IdentifierField;
        identifierCols[field] = idxOf(header);
      } else if (role === 'customField') {
        const fieldKey = fieldKeys[header]?.trim();
        if (fieldKey) valueCols.push({ idx: idxOf(header), target: { kind: 'customField', fieldKey } });
      } else if (role.startsWith('warranty:')) {
        const field = role.slice('warranty:'.length) as (typeof WARRANTY_FIELDS)[number];
        valueCols.push({ idx: idxOf(header), target: { kind: 'warranty', field } });
      }
    }

    const rows: DeviceCustomFieldImportRow[] = [];
    let dropped = 0;
    for (const raw of csvRows) {
      const cell = (i: number | undefined) => (i !== undefined && i >= 0 ? (raw[i] ?? '').trim() : '');
      const row: DeviceCustomFieldImportRow = { values: [] };
      for (const field of IDENTIFIER_FIELDS) {
        const value = cell(identifierCols[field]);
        if (value) row[field] = value;
      }
      if (!row.organizationId && organizationId) row.organizationId = organizationId;
      for (const { idx, target } of valueCols) {
        const rawCell = raw[idx] ?? '';
        const type =
          target.kind === 'customField' && conflictingFieldKeys.has(target.fieldKey)
            ? 'text'
            : targetTypeFor(target, fieldTypeByKey);
        const coerced = coerceCellForType(rawCell, type, dateFormat);
        if (coerced === null) continue;
        row.values.push({ target, value: coerced });
      }
      const hasIdentifier = IDENTIFIER_FIELDS.some((f) => row[f]);
      if (!hasIdentifier && row.values.length === 0) {
        dropped += 1;
        continue;
      }
      rows.push(row);
    }
    return { rows, dropped };
  }, [headers, csvRows, roles, fieldKeys, dateFormat, fieldTypeByKey, conflictingFieldKeys, organizationId]);

  const importRows = mapped.rows;
  const totalValues = importRows.reduce((n, r) => n + r.values.length, 0);

  async function preview() {
    setPreviewing(true);
    setSummary(null);
    setNotAttempted(0);
    const chunks = chunkValueRows(importRows, MAX_IMPORT_ROWS, MAX_IMPORT_VALUES);
    setPreviewProgress({ done: 0, total: chunks.length });
    const merged: AnnotatedValueRow[] = [];
    let offset = 0;
    try {
      for (const chunk of chunks) {
        const res = await runAction<{ rows: AnnotatedValueRow[] }>({
          request: () =>
            fetchWithAuth('/devices/custom-fields/import/preview', {
              method: 'POST',
              body: JSON.stringify({ mode, overrideProviderWarranty, externalSystem: source, rows: chunk }),
            }),
          errorFallback: t('customFieldValueImport.errors.previewFailed'),
          onUnauthorized,
        });
        // Every chunk previews the FULL row set in order (unlike commit, which
        // only sends the selected subset), so chunk-local indexes really are
        // contiguous here — a plain cumulative offset is correct.
        for (const r of res.rows) merged.push({ ...r, index: r.index + offset });
        offset += chunk.length;
        setPreviewProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
      }
      setPreviewRows(merged);
      setPreviewStale(false);
      setBuiltRows(importRows);
      setSelected(defaultValueImportSelection(merged));
      setPicks(new Map());
    } catch {
      // A failed (re-)preview must not leave a stale, fully-committable table
      // on screen from a PRIOR successful preview — that table no longer
      // reflects the current mapping/CSV, and a user could commit data built
      // from state they believe they just discarded.
      setPreviewRows(null);
      setPreviewStale(false);
      setBuiltRows([]);
      setSelected(new Set());
      setPicks(new Map());
    } finally {
      setPreviewing(false);
      setPreviewProgress(null);
    }
  }

  async function commit() {
    if (!previewRows) return;
    // Defense in depth: the checkbox `disabled` attribute is the primary
    // guard, but `commit()` re-derives selectability itself rather than
    // trusting `selected` blindly — a future bulk-select feature or a stale
    // index after re-preview must not be able to submit an unpickable row.
    const chosenIndexes = previewRows
      .filter((r) => selected.has(r.index) && isValueRowSelectable(r, picks))
      .map((r) => r.index);
    if (chosenIndexes.length === 0) return;
    const chosenRows = chosenIndexes.map((i) => {
      const row = previewRows.find((r) => r.index === i)!;
      const built = builtRows[i]!;
      const pick = picks.get(i);
      return {
        ...built,
        expectedOutcome: row.outcome,
        ...(pick ? { expectedDeviceId: pick } : {}),
      };
    });

    setCommitting(true);
    setNotAttempted(0);
    // Pair each row with its ORIGINAL (possibly non-contiguous) preview index
    // so a chunk's response — 0-indexed within that request — can be mapped
    // back to the row it actually describes (see `mergeCommitChunkResult`).
    const indexed = chosenIndexes.map((originalIndex, i) => ({ originalIndex, row: chosenRows[i]! }));
    const chunks = chunkValueRows(indexed, MAX_IMPORT_ROWS, MAX_IMPORT_VALUES, (ir) => ir.row.values.length);
    setCommitProgress({ done: 0, total: chunks.length });
    const aggregate: ValueImportSummary = {
      appliedValues: 0,
      skippedValues: 0,
      failedValues: 0,
      rows: [],
      linksCreated: 0,
      errors: [],
    };
    let chunksCompleted = 0;
    try {
      for (const chunk of chunks) {
        const originalIndexes = chunk.map((ir) => ir.originalIndex);
        const result = await runAction<ValueImportSummary>({
          request: () =>
            fetchWithAuth('/devices/custom-fields/import', {
              method: 'POST',
              body: JSON.stringify({
                mode,
                overrideProviderWarranty,
                externalSystem: source,
                rows: chunk.map((ir) => ir.row),
              }),
            }),
          errorFallback: t('customFieldValueImport.errors.importFailed'),
          onUnauthorized,
        });
        mergeCommitChunkResult(aggregate, result, originalIndexes);
        chunksCompleted += 1;
        // This chunk is done (succeeded or reported its own row-level errors,
        // either way the server has ruled on it) — never resend it if the
        // operator retries after a LATER chunk fails.
        setSelected((prev) => {
          const next = new Set(prev);
          for (const ir of chunk) next.delete(ir.originalIndex);
          return next;
        });
        setCommitProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
      }
      setSummary(aggregate);
      onCommitted?.(aggregate);
    } catch {
      // Chunks 0..chunksCompleted-1 already wrote (or definitively refused)
      // their rows and are reflected in `aggregate` — that's real, keep it.
      // Chunks from chunksCompleted onward were never attempted; report that
      // explicitly rather than letting applied+skipped+failed silently fall
      // short of the number of rows the operator selected.
      const attemptedRows = chunks.slice(0, chunksCompleted).reduce((n, c) => n + c.length, 0);
      const totalRows = chunks.reduce((n, c) => n + c.length, 0);
      setNotAttempted(totalRows - attemptedRows);
      setSummary(aggregate);
    } finally {
      setCommitting(false);
      setCommitProgress(null);
    }
  }

  const tooManyForOneRequest = totalValues > MAX_IMPORT_VALUES || importRows.length > MAX_IMPORT_ROWS;

  return (
    <div data-testid="cf-val-import-step" className="space-y-4">
      <div
        data-testid="cf-val-dropzone"
        onClick={() => fileInputRef.current?.click()}
        className="flex cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground"
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          data-testid="cf-val-file-input"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) loadFile(file);
            e.target.value = '';
          }}
        />
        {fileName ? <span className="font-medium text-foreground">{fileName}</span> : t('customFieldValueImport.dropzone')}
      </div>

      {headers.length > 0 && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-4 text-xs">
            <label className="flex items-center gap-2">
              <span className="text-muted-foreground">{t('customFieldValueImport.mode.label')}</span>
              <select
                data-testid="cf-val-mode"
                value={mode}
                onChange={(e) => setMode(e.target.value as 'skip' | 'update')}
                className="h-7 rounded-md border bg-background px-2"
              >
                <option value="skip">{t('customFieldValueImport.mode.skip')}</option>
                <option value="update">{t('customFieldValueImport.mode.update')}</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span className="text-muted-foreground">{t('customFieldValueImport.dateFormat.label')}</span>
              <select
                data-testid="cf-val-date-format"
                value={dateFormat}
                onChange={(e) => setDateFormat(e.target.value as CustomFieldImportDateFormat)}
                className="h-7 rounded-md border bg-background px-2"
              >
                <option value="ISO">{t('customFieldValueImport.dateFormat.iso')}</option>
                <option value="MM/DD/YYYY">MM/DD/YYYY</option>
                <option value="DD/MM/YYYY">DD/MM/YYYY</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid="cf-val-override-warranty"
                checked={overrideProviderWarranty}
                onChange={(e) => setOverrideProviderWarranty(e.target.checked)}
              />
              {t('customFieldValueImport.overrideProviderWarranty')}
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {headers.map((header) => {
              const role = roles[header] ?? 'ignore';
              return (
                <div key={header} className="space-y-1">
                  <span className="block text-xs text-muted-foreground">{header}</span>
                  <select
                    data-testid={`cf-val-map-${header}`}
                    value={role}
                    onChange={(e) => setRole(header, e.target.value as ColumnRole)}
                    className="h-8 w-full rounded-md border bg-background px-2 text-sm"
                  >
                    <option value="ignore">{t('customFieldValueImport.mapping.ignore')}</option>
                    <optgroup label={t('customFieldValueImport.mapping.identifierGroup')}>
                      {IDENTIFIER_FIELDS.map((f) => (
                        <option key={f} value={`identifier:${f}`}>
                          {t(/* i18n-dynamic */ `customFieldValueImport.mapping.identifiers.${f}`)}
                        </option>
                      ))}
                    </optgroup>
                    <option value="customField">{t('customFieldValueImport.mapping.customField')}</option>
                    <optgroup label={t('customFieldValueImport.mapping.warrantyGroup')}>
                      {WARRANTY_FIELDS.map((f) => (
                        <option key={f} value={`warranty:${f}`}>
                          {t(/* i18n-dynamic */ `customFieldValueImport.mapping.warranty.${f}`)}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                  {role === 'customField' && (
                    <input
                      type="text"
                      data-testid={`cf-val-fieldkey-${header}`}
                      value={fieldKeys[header] ?? ''}
                      onChange={(e) => setFieldKeys((prev) => ({ ...prev, [header]: e.target.value }))}
                      placeholder={t('customFieldValueImport.mapping.fieldKeyPlaceholder')}
                      className="h-8 w-full rounded-md border bg-background px-2 text-sm"
                    />
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              data-testid="cf-val-preview"
              onClick={preview}
              disabled={previewing || importRows.length === 0}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {previewing
                ? t('customFieldValueImport.actions.previewing')
                : t('customFieldValueImport.actions.preview', { count: importRows.length })}
            </button>
            {mapped.dropped > 0 && (
              <span data-testid="cf-val-dropped" className="text-xs text-amber-700 dark:text-amber-400">
                {t('customFieldValueImport.mapping.droppedRows', { count: mapped.dropped })}
              </span>
            )}
            {tooManyForOneRequest && (
              <span data-testid="cf-val-chunked-notice" className="text-xs text-muted-foreground">
                {t('customFieldValueImport.chunkedNotice')}
              </span>
            )}
            {previewProgress && previewProgress.total > 1 && (
              <span data-testid="cf-val-preview-progress" className="text-xs text-muted-foreground">
                {t('customFieldValueImport.progress', { done: previewProgress.done, total: previewProgress.total })}
              </span>
            )}
          </div>
        </div>
      )}

      {previewRows && (
        <div className="space-y-2">
          {previewStale && (
            <p data-testid="cf-val-preview-stale" className="text-xs text-amber-700 dark:text-amber-400">
              {t('customFieldValueImport.previewStale')}
            </p>
          )}
          <CustomFieldImportPreviewTable
            rows={previewRows}
            selected={selected}
            onSelectedChange={setSelected}
            picks={picks}
            onPick={(index, deviceId) => setPicks((prev) => new Map(prev).set(index, deviceId))}
          />
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              data-testid="cf-val-commit"
              onClick={commit}
              disabled={committing || selected.size === 0}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {committing
                ? t('customFieldValueImport.actions.importing')
                : t('customFieldValueImport.actions.import', { count: selected.size })}
            </button>
            {commitProgress && commitProgress.total > 1 && (
              <span data-testid="cf-val-commit-progress" className="text-xs text-muted-foreground">
                {t('customFieldValueImport.progress', { done: commitProgress.done, total: commitProgress.total })}
              </span>
            )}
          </div>
        </div>
      )}

      {summary && (
        <div className="space-y-2">
          <p
            data-testid="cf-val-summary"
            className={`text-sm ${summary.failedValues > 0 || summary.errors.length > 0 ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            {t('customFieldValueImport.summary', {
              applied: summary.appliedValues,
              skipped: summary.skippedValues,
              failed: summary.failedValues,
            })}
          </p>
          {notAttempted > 0 && (
            <p data-testid="cf-val-not-attempted" className="text-sm text-destructive">
              {t('customFieldValueImport.notAttempted', { count: notAttempted })}
            </p>
          )}
          {summary.errors.length > 0 && (
            <ul data-testid="cf-val-errors" className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              {summary.errors.map((e) => (
                <li key={e.index} data-testid={`cf-val-error-${e.index}`}>
                  {t('customFieldValueImport.errorRow', { index: e.index + 1 })}: {e.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
