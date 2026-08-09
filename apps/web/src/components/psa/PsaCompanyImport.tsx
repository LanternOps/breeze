import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PSA_COMPANY_LIST_CAP, isOrgImportCapableProvider, type PsaProviderId } from '@breeze/shared';
import OrgImportPreviewTable, {
  defaultPreviewSelection,
  toCommitRow,
  type AnnotatedRow,
  type OrgImportSummary
} from '../organizations/OrgImportPreviewTable';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
// Initializes the shared i18next singleton — see PsaConnectionsPage.
import '../../lib/i18n';

/**
 * Import a PSA's companies as organizations (#3246).
 *
 * The PSA is just another source into the org-import seam: the preview and
 * commit routes speak the SAME row contract as `POST /orgs/import`, so this
 * modal reuses `OrgImportPreviewTable` verbatim and differs only in where the
 * rows come from and in the truncation warning a paginated remote source can
 * raise (CSV never can).
 */


export interface PsaImportConnection {
  id: string;
  name: string;
  provider: PsaProviderId;
}

/**
 * WHY the listing stopped short. The cap is only one of three reasons, and the
 * other two can clip FAR below it — telling a user "only the first 1000 were
 * fetched" when a slow PSA actually returned 40 is both wrong and alarming.
 */
type TruncationReason = 'cap' | 'time-budget' | 'page-guard';

/** The non-row half of `POST /psa/connections/:id/import/preview`. */
interface PreviewMeta {
  truncated: boolean;
  truncationReason: TruncationReason | null;
  /** Companies the PSA actually returned, before any filtering. */
  fetched: number;
  /** Skipped because they are already imported from this provider. */
  alreadyLinked: number;
  /** Skipped because the PSA record had no usable id or name. */
  malformed: number;
  cap: number;
}

interface PreviewResponse extends Partial<PreviewMeta> {
  rows: AnnotatedRow[];
}

const TRUNCATION_REASONS: readonly TruncationReason[] = ['cap', 'time-budget', 'page-guard'];

/**
 * Normalise the preview envelope. Every counter is optional here on purpose:
 * an older API (or a self-hosted deploy mid-upgrade) answers with `rows` +
 * `truncated` only, and the warning must still be truthful rather than blank.
 */
function toPreviewMeta(res: PreviewResponse): PreviewMeta {
  const reason = res.truncationReason;
  return {
    truncated: res.truncated === true,
    truncationReason: reason && TRUNCATION_REASONS.includes(reason) ? reason : null,
    fetched: typeof res.fetched === 'number' ? res.fetched : res.rows.length,
    alreadyLinked: typeof res.alreadyLinked === 'number' ? res.alreadyLinked : 0,
    malformed: typeof res.malformed === 'number' ? res.malformed : 0,
    cap: typeof res.cap === 'number' ? res.cap : PSA_COMPANY_LIST_CAP,
  };
}

interface Props {
  connection: PsaImportConnection;
  onClose: () => void;
  /** Called after a commit that created or updated at least one organization. */
  onImported?: () => void;
  onUnauthorized?: () => void;
}

export default function PsaCompanyImport({ connection, onClose, onImported, onUnauthorized }: Props) {
  const { t } = useTranslation('common');
  const [previewRows, setPreviewRows] = useState<AnnotatedRow[] | null>(null);
  const [meta, setMeta] = useState<PreviewMeta | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [mode, setMode] = useState<'skip' | 'update'>('skip');
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [failures, setFailures] = useState<OrgImportSummary['errors']>([]);
  const [lastSummary, setLastSummary] = useState<string | null>(null);

  // Jira has no company/account object, so its adapter cannot enumerate one and
  // the route answers 400. Refusing to render is the UX half of that gate; the
  // server remains authoritative. Callers should not offer the action at all —
  // this is the belt to their braces.
  if (!isOrgImportCapableProvider(connection.provider)) return null;

  async function preview() {
    setPreviewing(true);
    setFailures([]);
    setLastSummary(null);
    try {
      // Empty body: the connection id in the path is the entire input. Which
      // companies get pulled — and the cap — is the server's decision.
      const res = await runAction<PreviewResponse>({
        request: () =>
          fetchWithAuth(`/psa/connections/${connection.id}/import/preview`, {
            method: 'POST',
            body: JSON.stringify({})
          }),
        errorFallback: t('longTail.psa.PsaCompanyImport.errors.previewFailed'),
        onUnauthorized
      });
      setPreviewRows(res.rows);
      setMeta(toPreviewMeta(res));
      setSelected(defaultPreviewSelection(res.rows));
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('longTail.psa.PsaCompanyImport.errors.previewFailed') });
      }
    } finally {
      setPreviewing(false);
    }
  }

  async function commit() {
    if (!previewRows) return;
    const rows = previewRows
      .filter((r) => selected.has(r.index))
      // `externalSystem` is deliberately NOT sent: the server forces it to this
      // connection's provider slug, which is the dedupe key the link table is
      // unique on. Sending our own would at best be ignored.
      .map((r) => toCommitRow(r, { includeExternalSystem: false }));
    if (rows.length === 0) return;

    setImporting(true);
    try {
      // The endpoint always answers HTTP 200 with a summary (partial success is
      // a feature), so runAction cannot tell a total failure from a win — this
      // handler owns the outcome toast. No `successMessage`: it only emits green.
      const s = await runAction<OrgImportSummary>({
        request: () =>
          fetchWithAuth(`/psa/connections/${connection.id}/import`, {
            method: 'POST',
            body: JSON.stringify({ rows, mode })
          }),
        errorFallback: t('longTail.psa.PsaCompanyImport.errors.importFailed'),
        onUnauthorized
      });
      // Outcome copy is shared with the CSV importer — same summary shape.
      const parts = [t('settings:bulkOrgImport.summary.imported', { count: s.imported.length })];
      if (s.updated.length) parts.push(t('settings:bulkOrgImport.summary.updated', { count: s.updated.length }));
      if (s.skipped.length) parts.push(t('settings:bulkOrgImport.summary.skipped', { count: s.skipped.length }));
      if (s.errors.length) parts.push(t('settings:bulkOrgImport.summary.failed', { count: s.errors.length }));
      const message = parts.join(', ');
      if (s.imported.length === 0 && s.updated.length === 0 && s.errors.length > 0) {
        showToast({ type: 'error', message: t('settings:bulkOrgImport.summary.allFailed', { summary: message }) });
      } else if (s.errors.length > 0) {
        showToast({ type: 'warning', message: `${message}.` });
      } else {
        showToast({ type: 'success', message: `${message}.` });
      }
      setFailures(s.errors);
      setLastSummary(message);
      setPreviewRows(null);
      // The counters describe the listing that produced this preview — they
      // must not outlive it.
      setMeta(null);
      setSelected(new Set());
      if (s.imported.length > 0 || s.updated.length > 0) onImported?.();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('longTail.psa.PsaCompanyImport.errors.importFailed') });
      }
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div
        data-testid="psa-company-import-modal"
        className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-lg border bg-card p-6 shadow-xs"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">{t('longTail.psa.PsaCompanyImport.title')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('longTail.psa.PsaCompanyImport.subtitle', { name: connection.name })}
            </p>
          </div>
          <button
            type="button"
            data-testid="psa-company-import-close"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted"
          >
            {t('common:actions.close')}
          </button>
        </div>

        {/* Step 1: pull the company list. Deliberately an explicit action —
            each preview is a burst of outbound PSA requests on a small
            per-user hourly budget, so opening the modal must not spend one. */}
        {!previewRows && (
          <div className="mt-4 rounded-md border border-dashed p-4">
            <p className="text-sm text-muted-foreground">{t('longTail.psa.PsaCompanyImport.intro')}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('longTail.psa.PsaCompanyImport.capHint', { cap: PSA_COMPANY_LIST_CAP })}
            </p>
            <button
              type="button"
              data-testid="psa-company-import-preview"
              onClick={preview}
              disabled={previewing}
              className="mt-3 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {previewing
                ? t('longTail.psa.PsaCompanyImport.actions.fetching')
                : t('longTail.psa.PsaCompanyImport.actions.fetch')}
            </button>
          </div>
        )}

        {/* A clipped company list leaves the un-fetched companies unlinked, and
            a later import cannot tell they were ever missed. This is a
            correctness warning about the resulting tenant state, not a hint.

            The wording follows the REASON: the cap is only one of three, and a
            slow PSA or a runaway pager can stop the walk far below it — quoting
            the cap in those cases is both wrong and needlessly alarming. */}
        {meta?.truncated && (
          <div
            data-testid="psa-company-import-truncated"
            role="alert"
            className="mt-4 flex items-start gap-3 rounded-md border-2 border-amber-500 bg-amber-50 p-4 dark:border-amber-600 dark:bg-amber-950"
          >
            <svg
              className="h-6 w-6 shrink-0 text-amber-600 dark:text-amber-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
              />
            </svg>
            <div>
              <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                {t('longTail.psa.PsaCompanyImport.truncated.title')}
              </h3>
              <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
                {meta.truncationReason === 'cap'
                  ? t('longTail.psa.PsaCompanyImport.truncated.cap', {
                      cap: meta.cap,
                      fetched: meta.fetched,
                    })
                  : meta.truncationReason === 'time-budget'
                    ? t('longTail.psa.PsaCompanyImport.truncated.timeBudget', {
                        fetched: meta.fetched,
                      })
                    : meta.truncationReason === 'page-guard'
                      ? t('longTail.psa.PsaCompanyImport.truncated.pageGuard', {
                          fetched: meta.fetched,
                        })
                      : t('longTail.psa.PsaCompanyImport.truncated.body', {
                          cap: meta.cap,
                          fetched: meta.fetched,
                        })}
              </p>
            </div>
          </div>
        )}

        {/* Not a warning: these companies ARE imported already, and previewing
            again after an import is exactly how an MSP walks a company list
            larger than the cap. */}
        {meta && meta.alreadyLinked > 0 && (
          <p
            data-testid="psa-company-import-already-linked"
            className="mt-4 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground"
          >
            {t('longTail.psa.PsaCompanyImport.alreadyLinked', { count: meta.alreadyLinked })}
          </p>
        )}

        {/* Mild: a handful of unreadable PSA records is a data-quality problem
            on their side, not a failed import. */}
        {meta && meta.malformed > 0 && (
          <p
            data-testid="psa-company-import-malformed"
            className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300"
          >
            {t('longTail.psa.PsaCompanyImport.malformed', { count: meta.malformed })}
          </p>
        )}

        {/* Step 2: acknowledge rows and commit. */}
        {previewRows && (
          <div className="mt-4">
            {previewRows.length === 0 ? (
              <p data-testid="psa-company-import-empty" className="text-sm text-muted-foreground">
                {t('longTail.psa.PsaCompanyImport.empty')}
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t('settings:bulkOrgImport.preview.title')}
                  </h3>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{t('settings:bulkOrgImport.mode.label')}</span>
                    <select
                      data-testid="psa-company-import-mode"
                      value={mode}
                      onChange={(e) => setMode(e.target.value as 'skip' | 'update')}
                      className="h-7 rounded-md border bg-background px-2 text-xs"
                    >
                      <option value="skip">{t('settings:bulkOrgImport.mode.skip')}</option>
                      <option value="update">{t('settings:bulkOrgImport.mode.update')}</option>
                    </select>
                  </label>
                </div>

                <OrgImportPreviewTable
                  rows={previewRows}
                  selected={selected}
                  onSelectedChange={setSelected}
                  testIdPrefix="psa-company-import"
                />

                <div className="mt-3">
                  <button
                    type="button"
                    data-testid="psa-company-import-submit"
                    onClick={commit}
                    disabled={importing || selected.size === 0}
                    className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    {importing
                      ? t('longTail.psa.PsaCompanyImport.actions.importing')
                      : t('longTail.psa.PsaCompanyImport.actions.import', { count: selected.size })}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {lastSummary && !previewRows && (
          <p className="mt-4 text-sm text-muted-foreground" data-testid="psa-company-import-summary">
            {lastSummary}.
          </p>
        )}

        {failures.length > 0 && (
          <div
            className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3"
            data-testid="psa-company-import-failures"
          >
            <p className="text-sm font-medium text-destructive">
              {t('settings:bulkOrgImport.failures.title', { count: failures.length })}
            </p>
            <ul className="mt-2 space-y-1 text-xs text-destructive">
              {failures.map((f) => (
                <li key={f.index} data-testid={`psa-company-import-failure-${f.index}`}>
                  <span className="font-medium">{f.organization ?? `#${f.index + 1}`}</span>: {f.error}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
