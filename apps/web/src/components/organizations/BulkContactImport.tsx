import { useMemo, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { runAction } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { parseCsv, type ParsedCsv } from '../../lib/csvParse';
import ContactImportPreviewTable, {
  defaultContactPreviewSelection,
  toContactCommitRow,
  type AnnotatedContactRow,
  type CommitContactRowInput,
  type ContactImportSummary,
} from './ContactImportPreviewTable';

/**
 * CSV contact importer (#3258 W04), hosted inside one organization's Contacts
 * tab.
 *
 * Unlike BulkOrgImport there is no `organization` column: the tab already knows
 * which organization it is looking at, so every row is pinned to `orgId` here
 * rather than resolved by name server-side. That removes the whole
 * `org-not-found` class from the normal path — the annotation still exists on
 * the wire and the preview table still renders it, because a row can be
 * refused if the caller's reach changes between preview and commit.
 */

type MappableField =
  | 'name' | 'email' | 'phone' | 'mobile' | 'title'
  | 'roles' | 'site' | 'externalId' | 'externalSystem';

/**
 * Order matters: `guessMapping` claims headers first-come, so a field whose
 * guesses overlap another's must be resolved earlier. `title` precedes `roles`
 * so a bare `Title` column is a job title rather than a role list.
 */
const MAPPABLE_FIELDS: MappableField[] = [
  'name', 'email', 'phone', 'mobile', 'title', 'roles', 'site', 'externalId', 'externalSystem',
];

/**
 * The subset that satisfies `contacts_identifiable_chk`. A row carrying none of
 * these is rejected by the server — and because a malformed row fails the WHOLE
 * request, such rows are dropped client-side rather than sent.
 */
const IDENTIFIER_FIELDS = ['name', 'email', 'phone', 'mobile'] as const;

// Header auto-guess, first match wins. Compared against the lowercased,
// space/underscore/hyphen-stripped header.
const FIELD_GUESSES: Record<MappableField, string[]> = {
  name: ['name', 'fullname', 'contactname', 'displayname', 'contact'],
  email: ['email', 'emailaddress', 'mail', 'primaryemail', 'workemail'],
  phone: ['phone', 'phonenumber', 'telephone', 'tel', 'workphone', 'officephone', 'businessphone'],
  mobile: ['mobile', 'mobilephone', 'cell', 'cellphone', 'cellular', 'mobilenumber'],
  title: ['title', 'jobtitle', 'position', 'jobrole'],
  roles: ['roles', 'role', 'contactroles', 'contacttype', 'type'],
  site: ['site', 'sitename', 'location', 'branch', 'office'],
  externalId: ['externalid', 'contactid', 'uid', 'guid', 'id'],
  externalSystem: ['externalsystem', 'system', 'source', 'vendor'],
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

/**
 * Split a roles cell into the server's vocabulary.
 *
 * Accepts comma, semicolon and pipe separators, and normalises `After Hours` /
 * `after-hours` to the stored `after_hours` — an exported spreadsheet writes
 * the human label, not the token. An unrecognised value still reaches the
 * server, which refuses the row with `invalid-role` and names it; guessing a
 * "closest" role here would silently file people under the wrong one.
 */
function parseRoles(cell: string): string[] {
  return cell
    .split(/[,;|]/)
    .map((r) => r.trim().toLowerCase().replace(/[\s-]+/g, '_'))
    .filter((r) => r !== '');
}

interface Props {
  /** The organization every row is pinned to — the tab's organization. */
  orgId: string;
  /** Called after a commit that imported or updated at least one row. */
  onImported?: () => void;
  onUnauthorized?: () => void;
  onClose?: () => void;
}

export default function BulkContactImport({ orgId, onImported, onUnauthorized, onClose }: Props) {
  const { t } = useTranslation('settings');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [csv, setCsv] = useState<ParsedCsv | null>(null);
  const [mapping, setMapping] = useState<Partial<Record<MappableField, string>>>({});
  const [dragActive, setDragActive] = useState(false);
  const [previewRows, setPreviewRows] = useState<AnnotatedContactRow[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [mode, setMode] = useState<'skip' | 'update'>('skip');
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [failures, setFailures] = useState<ContactImportSummary['errors']>([]);
  /** Row index → a human label, so a failure names the person, not a number. */
  const [failureLabels, setFailureLabels] = useState<Record<number, string>>({});
  const [lastSummary, setLastSummary] = useState<string | null>(null);

  const importRows = useMemo<CommitContactRowInput[]>(() => {
    if (!csv) return [];
    const col = (field: MappableField) => {
      const header = mapping[field];
      return header ? csv.headers.indexOf(header) : -1;
    };
    const idx = Object.fromEntries(
      MAPPABLE_FIELDS.map((f) => [f, col(f)]),
    ) as Record<MappableField, number>;

    const rows: CommitContactRowInput[] = [];
    for (const raw of csv.rows) {
      const cell = (i: number) => (i >= 0 ? (raw[i] ?? '').trim() : '');
      // The organization is the TAB's, never the file's.
      const row: CommitContactRowInput = { organizationId: orgId };
      for (const field of MAPPABLE_FIELDS) {
        if (field === 'roles') continue;
        const value = cell(idx[field]);
        if (value) row[field] = value;
      }
      const roles = parseRoles(cell(idx.roles));
      if (roles.length > 0) row.roles = roles;
      // Blank spreadsheet tail rows satisfy no identifier; one of them would
      // fail Zod and reject every other row in the request with it.
      if (!IDENTIFIER_FIELDS.some((f) => row[f])) continue;
      rows.push(row);
    }
    return rows;
  }, [csv, mapping, orgId]);

  const hasIdentifierColumn = IDENTIFIER_FIELDS.some((f) => mapping[f]);

  function resetPreview() {
    setPreviewRows(null);
    setSelected(new Set());
  }

  function loadFile(file: File) {
    void file.text().then((text) => {
      const parsed = parseCsv(text);
      setFileName(file.name);
      setCsv(parsed);
      setMapping(guessMapping(parsed.headers));
      resetPreview();
      setFailures([]);
      setFailureLabels({});
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
    setFailureLabels({});
    setLastSummary(null);
    try {
      const res = await runAction<{ rows: AnnotatedContactRow[] }>({
        request: () =>
          fetchWithAuth('/orgs/contacts/import/preview', {
            method: 'POST',
            body: JSON.stringify({ rows: importRows }),
          }),
        errorFallback: t('bulkContactImport.errors.previewFailed'),
        onUnauthorized,
      });
      setPreviewRows(res.rows);
      // create + link-match pre-checked; an email/name hint is a per-person
      // judgement and must be ticked deliberately; conflict and org-not-found
      // are never selectable.
      setSelected(defaultContactPreviewSelection(res.rows));
    } catch {
      // runAction already toasted (or routed the 401).
    } finally {
      setPreviewing(false);
    }
  }

  async function commit() {
    if (!previewRows) return;
    const chosen = previewRows.filter((r) => selected.has(r.index));
    if (chosen.length === 0) return;
    const labels = Object.fromEntries(
      chosen.map((r) => [r.index, r.name ?? r.email ?? r.phone ?? r.mobile ?? `#${r.index + 1}`]),
    );
    setImporting(true);
    try {
      // The endpoint always answers HTTP 200 with a summary — partial success is
      // a feature — so runAction cannot tell a total failure from a win. The
      // outcome toast is owned here; no `successMessage`, which only emits green.
      const s = await runAction<ContactImportSummary>({
        request: () =>
          fetchWithAuth('/orgs/contacts/import', {
            method: 'POST',
            body: JSON.stringify({ rows: chosen.map(toContactCommitRow), mode }),
          }),
        errorFallback: t('bulkContactImport.errors.importFailed'),
        onUnauthorized,
      });
      const parts = [t('bulkContactImport.summary.imported', { count: s.imported.length })];
      if (s.updated.length) parts.push(t('bulkContactImport.summary.updated', { count: s.updated.length }));
      if (s.skipped.length) parts.push(t('bulkContactImport.summary.skipped', { count: s.skipped.length }));
      if (s.errors.length) parts.push(t('bulkContactImport.summary.failed', { count: s.errors.length }));
      const message = parts.join(', ');
      const wrote = s.imported.length > 0 || s.updated.length > 0;
      if (!wrote && s.errors.length > 0) {
        showToast({ type: 'error', message: t('bulkContactImport.summary.allFailed', { summary: message }) });
      } else if (s.errors.length > 0) {
        showToast({ type: 'warning', message: `${message}.` });
      } else {
        showToast({ type: 'success', message: `${message}.` });
      }
      setFailures(s.errors);
      setFailureLabels(labels);
      setLastSummary(message);
      resetPreview();
      if (wrote) onImported?.();
    } catch {
      // runAction already toasted the request-level failure (non-200 / thrown).
    } finally {
      setImporting(false);
    }
  }

  return (
    <div data-testid="bulk-contact-import-panel" className="rounded-lg border bg-card p-4 shadow-xs">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">{t('bulkContactImport.title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('bulkContactImport.description')}</p>
        </div>
        {onClose && (
          <button
            type="button"
            data-testid="bulk-contact-import-close"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted"
          >
            {t('bulkContactImport.actions.close')}
          </button>
        )}
      </div>

      {/* Step 1: file */}
      <div
        data-testid="bulk-contact-import-dropzone"
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
          data-testid="bulk-contact-import-file-input"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) loadFile(file);
            e.target.value = '';
          }}
        />
        {fileName
          ? <span className="font-medium text-foreground">{fileName}</span>
          : <span>{t('bulkContactImport.dropzone')}</span>}
        <span className="mt-1 text-xs">{t('bulkContactImport.dropzoneHint')}</span>
      </div>

      {/* Step 2: column mapping */}
      {csv && csv.headers.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('bulkContactImport.mapping.heading')}
          </h3>
          <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {MAPPABLE_FIELDS.map((field) => (
              <label key={field} className="block text-xs">
                <span className="text-muted-foreground">
                  {t(/* i18n-dynamic */ `bulkContactImport.mapping.fields.${field}`)}
                </span>
                <select
                  data-testid={`bulk-contact-import-map-${field}`}
                  value={mapping[field] ?? ''}
                  onChange={(e) => {
                    const value = e.target.value || undefined;
                    setMapping((prev) => ({ ...prev, [field]: value }));
                    resetPreview();
                  }}
                  className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                >
                  <option value="">{t('bulkContactImport.mapping.unmapped')}</option>
                  {csv.headers.map((h) => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              data-testid="bulk-contact-import-preview"
              onClick={preview}
              disabled={previewing || importRows.length === 0}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {previewing
                ? t('bulkContactImport.actions.previewing')
                : t('bulkContactImport.actions.preview', { count: importRows.length })}
            </button>
            {!hasIdentifierColumn && (
              <span
                data-testid="bulk-contact-import-identifier-hint"
                className="text-xs text-muted-foreground"
              >
                {t('bulkContactImport.mapping.identifierRequired')}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Step 3: preview table */}
      {previewRows && (
        <div className="mt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('bulkContactImport.preview.heading')}
            </h3>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{t('bulkContactImport.mode.label')}</span>
              <select
                data-testid="bulk-contact-import-mode"
                value={mode}
                onChange={(e) => setMode(e.target.value as 'skip' | 'update')}
                className="h-7 rounded-md border bg-background px-2 text-xs"
              >
                <option value="skip">{t('bulkContactImport.mode.skip')}</option>
                <option value="update">{t('bulkContactImport.mode.update')}</option>
              </select>
            </label>
          </div>

          <ContactImportPreviewTable
            rows={previewRows}
            selected={selected}
            onSelectedChange={setSelected}
            testIdPrefix="bulk-contact-import"
          />

          <div className="mt-3">
            <button
              type="button"
              data-testid="bulk-contact-import-submit"
              onClick={commit}
              disabled={importing || selected.size === 0}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {importing
                ? t('bulkContactImport.actions.importing')
                : t('bulkContactImport.actions.import', { count: selected.size })}
            </button>
          </div>
        </div>
      )}

      {lastSummary && !previewRows && (
        <p className="mt-4 text-sm text-muted-foreground" data-testid="bulk-contact-import-summary">
          {lastSummary}.
        </p>
      )}

      {failures.length > 0 && (
        <div
          className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3"
          data-testid="bulk-contact-import-failures"
        >
          <p className="text-sm font-medium text-destructive">
            {t('bulkContactImport.failures.title', { count: failures.length })}
          </p>
          <ul className="mt-2 space-y-1 text-xs text-destructive">
            {failures.map((f) => (
              <li key={f.index} data-testid={`bulk-contact-import-failure-${f.index}`}>
                <span className="font-medium">
                  {failureLabels[f.index] ?? f.organization ?? `#${f.index + 1}`}
                </span>
                {': '}
                {f.error}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
