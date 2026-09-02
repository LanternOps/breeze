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
  type ContactImportErrorCode,
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
 * Iteration order for `guessMapping`, which claims each header first-come. The
 * nine guess lists below are pairwise disjoint today, so no header is contested
 * and this order changes nothing; it is fixed only so that ADDING an overlapping
 * guess later resolves deterministically (earlier field wins) instead of by
 * whatever order the record happens to enumerate in.
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

/**
 * Mirrors MAX_IMPORT_ROWS in apps/api/src/services/contacts/types.ts, which the
 * preview and commit routes both enforce with `.max()`. Over the cap Zod refuses
 * the WHOLE request, so the file is stopped here with a count the operator can
 * act on rather than a generic 400.
 */
const MAX_IMPORT_ROWS = 1000;

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
  const [skipped, setSkipped] = useState<ContactImportSummary['skipped']>([]);
  /**
   * SUBMITTED position → a human label, so an outcome names the person rather
   * than a number. Keyed by position in the array actually sent, because that is
   * what the server's `errors[].index` and `skipped[].index` count — NOT the
   * preview row's own `index`, which still numbers the deselected rows.
   */
  const [failureLabels, setFailureLabels] = useState<Record<number, string>>({});
  const [lastSummary, setLastSummary] = useState<string | null>(null);

  const mapped = useMemo<{ rows: CommitContactRowInput[]; dropped: number }>(() => {
    if (!csv) return { rows: [], dropped: 0 };
    const col = (field: MappableField) => {
      const header = mapping[field];
      return header ? csv.headers.indexOf(header) : -1;
    };
    const idx = Object.fromEntries(
      MAPPABLE_FIELDS.map((f) => [f, col(f)]),
    ) as Record<MappableField, number>;

    const rows: CommitContactRowInput[] = [];
    let dropped = 0;
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
      // fail Zod and reject every other row in the request with it. Counted, not
      // silently swallowed: a mis-mapped identifier column drops EVERY row, and
      // an unexplained "Check 0 rows" is indistinguishable from an empty file.
      if (!IDENTIFIER_FIELDS.some((f) => row[f])) {
        dropped += 1;
        continue;
      }
      rows.push(row);
    }
    return { rows, dropped };
  }, [csv, mapping, orgId]);

  const importRows = mapped.rows;
  const droppedRows = mapped.dropped;
  const tooManyRows = importRows.length > MAX_IMPORT_ROWS;
  const hasIdentifierColumn = IDENTIFIER_FIELDS.some((f) => mapping[f]);
  /** A file that parsed but produced no header row at all — nothing to map. */
  const noColumns = csv !== null && csv.headers.length === 0;

  function resetPreview() {
    setPreviewRows(null);
    setSelected(new Set());
  }

  function clearOutcome() {
    setFailures([]);
    setSkipped([]);
    setFailureLabels({});
    setLastSummary(null);
  }

  function loadFile(file: File) {
    void file.text().then((text) => {
      const parsed = parseCsv(text);
      setFileName(file.name);
      setCsv(parsed);
      setMapping(guessMapping(parsed.headers));
      resetPreview();
      clearOutcome();
    }).catch((err: unknown) => {
      // A rejected read (the file was moved, renamed or its permission revoked
      // between picking and reading) used to leave the panel looking idle, with
      // the operator waiting on a preview that would never come.
      console.warn('[BulkContactImport] file read failed', err);
      showToast({ type: 'error', message: t('bulkContactImport.errors.fileRead') });
      setFileName(null);
      setCsv(null);
      setMapping({});
      resetPreview();
      clearOutcome();
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
    clearOutcome();
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
    // Keyed by SUBMITTED position: the server counts `errors[].index` and
    // `skipped[].index` against the array it received, so keying by the preview
    // row's own index names the wrong person the moment a row is deselected.
    const labels = Object.fromEntries(
      chosen.map((r, i) => [i, r.name ?? r.email ?? r.phone ?? r.mobile ?? `#${r.index + 1}`]),
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
      } else if (!wrote) {
        // Nothing failed, but nothing was written either — the DEFAULT re-import
        // path, since link-match rows arrive pre-ticked and skip mode leaves them
        // alone. Green here reads as "imported", which is exactly backwards.
        // Toast has no neutral/info type, so warning is the honest one.
        showToast({
          type: 'warning',
          message: s.skipped.length > 0
            ? t('bulkContactImport.summary.nothingImported', { count: s.skipped.length })
            : t('bulkContactImport.summary.nothingImportedEmpty'),
        });
      } else {
        showToast({ type: 'success', message: `${message}.` });
      }
      setFailures(s.errors);
      setSkipped(s.skipped);
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

  /** The person behind a submitted position, for an error or a skip line. */
  function outcomeLabel(index: number, organization?: string): string {
    return failureLabels[index] ?? organization ?? `#${index + 1}`;
  }

  /**
   * Translated copy for a refusal. Branches on the CODE, never on `error`: the
   * server's string is English and phrased for a developer (`match-unconfirmed`
   * names a JSON field the operator has never seen). An unknown code — a server
   * newer than this bundle — falls through to that string rather than to nothing.
   */
  function failureCopy(code: ContactImportErrorCode, serverText: string): string {
    switch (code) {
      case 'row-conflict': return t('bulkContactImport.errorCodes.rowConflict');
      case 'org-not-found': return t('bulkContactImport.errorCodes.orgNotFound');
      case 'annotation-changed': return t('bulkContactImport.errorCodes.annotationChanged');
      case 'match-changed': return t('bulkContactImport.errorCodes.matchChanged');
      case 'match-unconfirmed': return t('bulkContactImport.errorCodes.matchUnconfirmed');
      case 'write-failed': return t('bulkContactImport.errorCodes.writeFailed');
      case 'no-identifier': return t('bulkContactImport.errorCodes.noIdentifier');
      case 'invalid-role': return t('bulkContactImport.errorCodes.invalidRole');
      case 'site-not-in-org': return t('bulkContactImport.errorCodes.siteNotInOrg');
      default: return serverText;
    }
  }

  /** `skipped[].reason` is a machine token; only `already_linked` exists today. */
  function skipCopy(reason: string): string {
    return reason === 'already_linked'
      ? t('bulkContactImport.skipped.reasons.alreadyLinked')
      : reason;
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

      {noColumns && (
        <p
          data-testid="bulk-contact-import-no-columns"
          className="mt-3 text-xs text-destructive"
        >
          {t('bulkContactImport.errors.noColumns')}
        </p>
      )}

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
              disabled={previewing || importRows.length === 0 || tooManyRows}
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
            {droppedRows > 0 && (
              <span
                data-testid="bulk-contact-import-dropped"
                className="text-xs text-amber-700 dark:text-amber-400"
              >
                {t('bulkContactImport.mapping.droppedRows', { count: droppedRows })}
              </span>
            )}
            {tooManyRows && (
              <span
                data-testid="bulk-contact-import-too-many"
                className="text-xs text-destructive"
              >
                {t('bulkContactImport.mapping.tooManyRows', {
                  count: importRows.length,
                  max: MAX_IMPORT_ROWS,
                })}
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

      {skipped.length > 0 && (
        <div
          className="mt-4 rounded-md border border-border bg-muted/40 p-3"
          data-testid="bulk-contact-import-skipped"
        >
          <p className="text-sm font-medium">
            {t('bulkContactImport.skipped.title', { count: skipped.length })}
          </p>
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {skipped.map((row) => (
              <li key={row.index} data-testid={`bulk-contact-import-skipped-${row.index}`}>
                <span className="font-medium text-foreground">{outcomeLabel(row.index)}</span>
                {': '}
                {skipCopy(row.reason)}
              </li>
            ))}
          </ul>
        </div>
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
            {failures.map((f) => {
              const copy = failureCopy(f.code, f.error);
              return (
                <li key={f.index} data-testid={`bulk-contact-import-failure-${f.index}`}>
                  <span className="font-medium">{outcomeLabel(f.index, f.organization)}</span>
                  {': '}
                  {copy}
                  {/* The server's own sentence, kept as detail so a support
                      thread can still quote it verbatim. */}
                  {copy !== f.error && (
                    <span
                      data-testid={`bulk-contact-import-failure-detail-${f.index}`}
                      className="mt-0.5 block text-[11px] opacity-75"
                      title={f.error}
                    >
                      {f.error}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
