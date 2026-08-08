import { useMemo, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { runAction } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { parseCsv, type ParsedCsv } from '../../lib/csvParse';

// Mirrors apps/api/src/services/orgImport/types.ts — the JSON contract of
// POST /orgs/import/preview and POST /orgs/import.
type RowAnnotation = 'create' | 'link-match' | 'name-match' | 'matched-soft-deleted' | 'conflict';

interface ImportRow {
  organization: string;
  site?: string;
  externalId?: string;
  externalSystem?: string;
  timezone?: string;
}

interface AnnotatedRow extends ImportRow {
  index: number;
  annotation: RowAnnotation;
  slug: string | null;
  organizationId: string | null;
  matchedOrganizationName?: string;
  conflictReason?: string;
}

interface OrgImportSummary {
  imported: Array<{ index: number; organization: string; organizationId: string }>;
  updated: Array<{ index: number; organization: string; organizationId: string }>;
  skipped: Array<{ index: number; organization: string; reason: string }>;
  errors: Array<{ index: number; organization?: string; error: string }>;
}

type MappableField = 'organization' | 'site' | 'externalId' | 'externalSystem' | 'timezone';

const MAPPABLE_FIELDS: MappableField[] = ['organization', 'site', 'externalId', 'externalSystem', 'timezone'];

// Header auto-guess, first match wins. Compared against the lowercased,
// space/underscore-stripped header.
const FIELD_GUESSES: Record<MappableField, string[]> = {
  organization: ['organization', 'org', 'company', 'companyname', 'customer', 'client', 'account'],
  site: ['site', 'sitename', 'location', 'branch'],
  externalId: ['externalid', 'externalguid', 'uid', 'guid', 'id'],
  externalSystem: ['externalsystem', 'system', 'source', 'vendor'],
  timezone: ['timezone', 'tz'],
};

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

function guessMapping(headers: string[]): Partial<Record<MappableField, string>> {
  const normalized = headers.map((h) => h.toLowerCase().replace(/[\s_-]+/g, ''));
  const mapping: Partial<Record<MappableField, string>> = {};
  const claimed = new Set<string>();
  for (const field of MAPPABLE_FIELDS) {
    for (const guess of FIELD_GUESSES[field]) {
      const idx = normalized.findIndex((h, i) => h === guess && !claimed.has(headers[i]!));
      if (idx >= 0) {
        mapping[field] = headers[idx]!;
        claimed.add(headers[idx]!);
        break;
      }
    }
  }
  return mapping;
}

interface Props {
  /** Called after a commit that imported or updated at least one row. */
  onImported?: () => void;
  onUnauthorized?: () => void;
  onClose?: () => void;
}

export default function BulkOrgImport({ onImported, onUnauthorized, onClose }: Props) {
  const { t } = useTranslation('settings');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [csv, setCsv] = useState<ParsedCsv | null>(null);
  const [mapping, setMapping] = useState<Partial<Record<MappableField, string>>>({});
  const [dragActive, setDragActive] = useState(false);
  const [previewRows, setPreviewRows] = useState<AnnotatedRow[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [mode, setMode] = useState<'skip' | 'update'>('skip');
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [failures, setFailures] = useState<OrgImportSummary['errors']>([]);
  const [lastSummary, setLastSummary] = useState<string | null>(null);

  const importRows = useMemo<ImportRow[]>(() => {
    if (!csv || !mapping.organization) return [];
    const col = (field: MappableField) => {
      const header = mapping[field];
      return header ? csv.headers.indexOf(header) : -1;
    };
    const idx: Record<MappableField, number> = {
      organization: col('organization'),
      site: col('site'),
      externalId: col('externalId'),
      externalSystem: col('externalSystem'),
      timezone: col('timezone'),
    };
    const rows: ImportRow[] = [];
    for (const raw of csv.rows) {
      const cell = (i: number) => (i >= 0 ? (raw[i] ?? '').trim() : '');
      const organization = cell(idx.organization);
      if (!organization) continue; // fully unmapped/blank row
      const row: ImportRow = { organization };
      const site = cell(idx.site);
      const externalId = cell(idx.externalId);
      const externalSystem = cell(idx.externalSystem);
      const timezone = cell(idx.timezone);
      if (site) row.site = site;
      if (externalId) row.externalId = externalId;
      if (externalSystem) row.externalSystem = externalSystem;
      if (timezone) row.timezone = timezone;
      rows.push(row);
    }
    return rows;
  }, [csv, mapping]);

  function loadFile(file: File) {
    void file.text().then((text) => {
      const parsed = parseCsv(text);
      setFileName(file.name);
      setCsv(parsed);
      setMapping(guessMapping(parsed.headers));
      setPreviewRows(null);
      setSelected(new Set());
      setFailures([]);
      setLastSummary(null);
    });
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) loadFile(file);
  }

  async function preview() {
    setPreviewing(true);
    setFailures([]);
    setLastSummary(null);
    try {
      const res = await runAction<{ rows: AnnotatedRow[] }>({
        request: () =>
          fetchWithAuth('/orgs/import/preview', {
            method: 'POST',
            body: JSON.stringify({ rows: importRows }),
          }),
        errorFallback: t('bulkOrgImport.errors.previewFailed'),
        onUnauthorized,
      });
      setPreviewRows(res.rows);
      // create + link-match preselected; name-match must be ticked
      // deliberately; matched-soft-deleted selection IS the reactivate opt-in;
      // conflict rows are never selectable.
      setSelected(new Set(
        res.rows
          .filter((r) => r.annotation === 'create' || r.annotation === 'link-match')
          .map((r) => r.index),
      ));
    } catch {
      // runAction already toasted.
    } finally {
      setPreviewing(false);
    }
  }

  async function commit() {
    if (!previewRows) return;
    const rows = previewRows
      .filter((r) => selected.has(r.index))
      .map((r) => ({
        organization: r.organization,
        ...(r.site ? { site: r.site } : {}),
        ...(r.externalId ? { externalId: r.externalId } : {}),
        ...(r.externalSystem ? { externalSystem: r.externalSystem } : {}),
        ...(r.timezone ? { timezone: r.timezone } : {}),
        expectedAnnotation: r.annotation,
        // Pin the identity the user acknowledged: commit re-derives the match
        // and rejects the row if it now resolves to a DIFFERENT organization.
        ...(r.organizationId ? { expectedOrganizationId: r.organizationId } : {}),
        ...(r.annotation === 'matched-soft-deleted' ? { reactivate: true } : {}),
      }));
    if (rows.length === 0) return;
    setImporting(true);
    try {
      // The endpoint always returns HTTP 200 with a summary (partial success
      // is a feature), so runAction can't tell a total failure from a win —
      // we own the outcome toast here. No `successMessage`: it only emits green.
      const s = await runAction<OrgImportSummary>({
        request: () =>
          fetchWithAuth('/orgs/import', {
            method: 'POST',
            body: JSON.stringify({ rows, mode }),
          }),
        errorFallback: t('bulkOrgImport.errors.importFailed'),
        onUnauthorized,
      });
      const parts = [t('bulkOrgImport.summary.imported', { count: s.imported.length })];
      if (s.updated.length) parts.push(t('bulkOrgImport.summary.updated', { count: s.updated.length }));
      if (s.skipped.length) parts.push(t('bulkOrgImport.summary.skipped', { count: s.skipped.length }));
      if (s.errors.length) parts.push(t('bulkOrgImport.summary.failed', { count: s.errors.length }));
      const message = parts.join(', ');
      if (s.imported.length === 0 && s.updated.length === 0 && s.errors.length > 0) {
        showToast({ type: 'error', message: t('bulkOrgImport.summary.allFailed', { summary: message }) });
      } else if (s.errors.length > 0) {
        showToast({ type: 'warning', message: `${message}.` });
      } else {
        showToast({ type: 'success', message: `${message}.` });
      }
      setFailures(s.errors);
      setLastSummary(message);
      setPreviewRows(null);
      setSelected(new Set());
      if (s.imported.length > 0 || s.updated.length > 0) onImported?.();
    } catch {
      // runAction already toasted the request-level failure (non-200 / thrown).
    } finally {
      setImporting(false);
    }
  }

  function toggleRow(index: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  // Select-all only touches the safe annotations. name-match acknowledgement
  // and soft-deleted reactivation are per-row decisions — a bulk toggle must
  // never opt 500 rows into reactivating dead tenants in one click.
  const bulkSelectableRows = (previewRows ?? []).filter(
    (r) => r.annotation === 'create' || r.annotation === 'link-match',
  );

  return (
    <div data-testid="bulk-org-import-panel" className="rounded-lg border bg-card p-4 shadow-xs">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">{t('bulkOrgImport.title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('bulkOrgImport.description')}</p>
        </div>
        {onClose && (
          <button
            type="button"
            data-testid="bulk-org-import-close"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted"
          >
            {t('bulkOrgImport.actions.close')}
          </button>
        )}
      </div>

      {/* Step 1: file */}
      <div
        data-testid="bulk-org-import-dropzone"
        onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        className={`mt-4 flex cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-4 py-6 text-center text-sm ${
          dragActive ? 'border-primary bg-primary/5' : 'border-border text-muted-foreground'
        }`}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          data-testid="bulk-org-import-file-input"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) loadFile(file);
            e.target.value = '';
          }}
        />
        {fileName
          ? <span className="font-medium text-foreground">{fileName}</span>
          : <span>{t('bulkOrgImport.dropzone')}</span>}
        <span className="mt-1 text-xs">{t('bulkOrgImport.dropzoneHint')}</span>
      </div>

      {/* Step 2: column mapping */}
      {csv && csv.headers.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('bulkOrgImport.mapping.title')}
          </h3>
          <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {MAPPABLE_FIELDS.map((field) => (
              <label key={field} className="block text-xs">
                <span className="text-muted-foreground">
                  {t(/* i18n-dynamic */ `bulkOrgImport.mapping.${field}`)}
                  {field === 'organization' && ' *'}
                </span>
                <select
                  data-testid={`bulk-org-import-map-${field}`}
                  value={mapping[field] ?? ''}
                  onChange={(e) => {
                    const value = e.target.value || undefined;
                    setMapping((prev) => ({ ...prev, [field]: value }));
                    setPreviewRows(null);
                    setSelected(new Set());
                  }}
                  className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                >
                  <option value="">{t('bulkOrgImport.mapping.unmapped')}</option>
                  {csv.headers.map((h) => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              data-testid="bulk-org-import-preview"
              onClick={preview}
              disabled={previewing || !mapping.organization || importRows.length === 0}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {previewing
                ? t('bulkOrgImport.actions.previewing')
                : t('bulkOrgImport.actions.preview', { count: importRows.length })}
            </button>
            {!mapping.organization && (
              <span className="text-xs text-muted-foreground">{t('bulkOrgImport.mapping.organizationRequired')}</span>
            )}
          </div>
        </div>
      )}

      {/* Step 3: preview table */}
      {previewRows && (
        <div className="mt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('bulkOrgImport.preview.title')}
            </h3>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{t('bulkOrgImport.mode.label')}</span>
              <select
                data-testid="bulk-org-import-mode"
                value={mode}
                onChange={(e) => setMode(e.target.value as 'skip' | 'update')}
                className="h-7 rounded-md border bg-background px-2 text-xs"
              >
                <option value="skip">{t('bulkOrgImport.mode.skip')}</option>
                <option value="update">{t('bulkOrgImport.mode.update')}</option>
              </select>
            </label>
          </div>

          <div className="mt-2 max-h-96 overflow-y-auto rounded-md border">
            <table className="w-full text-sm" data-testid="bulk-org-import-table">
              <thead>
                <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                  <th className="w-8 px-2 py-1.5">
                    <input
                      type="checkbox"
                      data-testid="bulk-org-import-select-all"
                      aria-label={t('bulkOrgImport.preview.selectAll')}
                      checked={bulkSelectableRows.length > 0 && bulkSelectableRows.every((r) => selected.has(r.index))}
                      onChange={() => {
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (bulkSelectableRows.every((r) => next.has(r.index))) {
                            // Deselect the bulk set; explicit per-row opt-ins
                            // (name-match / reactivate) stay as ticked.
                            for (const r of bulkSelectableRows) next.delete(r.index);
                          } else {
                            for (const r of bulkSelectableRows) next.add(r.index);
                          }
                          return next;
                        });
                      }}
                    />
                  </th>
                  <th className="px-2 py-1.5">{t('bulkOrgImport.preview.organization')}</th>
                  <th className="px-2 py-1.5">{t('bulkOrgImport.preview.site')}</th>
                  <th className="px-2 py-1.5">{t('bulkOrgImport.preview.externalId')}</th>
                  <th className="px-2 py-1.5">{t('bulkOrgImport.preview.status')}</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.map((r) => (
                  <tr
                    key={r.index}
                    data-testid={`bulk-org-import-row-${r.index}`}
                    className="border-b border-border/50 last:border-0"
                  >
                    <td className="px-2 py-1.5">
                      <input
                        type="checkbox"
                        data-testid={`bulk-org-import-select-${r.index}`}
                        checked={selected.has(r.index)}
                        disabled={r.annotation === 'conflict'}
                        onChange={() => toggleRow(r.index)}
                      />
                    </td>
                    <td className="px-2 py-1.5">{r.organization}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">{r.site ?? '—'}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">{r.externalId ?? '—'}</td>
                    <td className="px-2 py-1.5">
                      <span
                        data-testid={`bulk-org-import-badge-${r.index}`}
                        className={`inline-flex rounded-full border px-2 py-0.5 text-xs ${BADGE_STYLES[r.annotation]}`}
                      >
                        {t(/* i18n-dynamic */ BADGE_LABEL_KEYS[r.annotation])}
                      </span>
                      {r.annotation === 'name-match' && r.matchedOrganizationName && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {t('bulkOrgImport.preview.matches', { name: r.matchedOrganizationName })}
                        </span>
                      )}
                      {r.annotation === 'matched-soft-deleted' && (
                        <span className="ml-2 text-xs text-orange-700 dark:text-orange-400">
                          {t('bulkOrgImport.preview.reactivateHint')}
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

          <div className="mt-3">
            <button
              type="button"
              data-testid="bulk-org-import-submit"
              onClick={commit}
              disabled={importing || selected.size === 0}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {importing
                ? t('bulkOrgImport.actions.importing')
                : t('bulkOrgImport.actions.import', { count: selected.size })}
            </button>
          </div>
        </div>
      )}

      {lastSummary && !previewRows && (
        <p className="mt-4 text-sm text-muted-foreground" data-testid="bulk-org-import-summary">
          {lastSummary}.
        </p>
      )}

      {failures.length > 0 && (
        <div
          className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3"
          data-testid="bulk-org-import-failures"
        >
          <p className="text-sm font-medium text-destructive">
            {t('bulkOrgImport.failures.title', { count: failures.length })}
          </p>
          <ul className="mt-2 space-y-1 text-xs text-destructive">
            {failures.map((f) => (
              <li key={f.index} data-testid={`bulk-org-import-failure-${f.index}`}>
                <span className="font-medium">{f.organization ?? `#${f.index + 1}`}</span>: {f.error}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
