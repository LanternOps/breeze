import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Download, Loader2, Upload, X } from 'lucide-react';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { getJwtClaims } from '@/lib/authScope';
import { runAction, ActionError } from '@/lib/runAction';
import { showToast } from '../shared/Toast';
import { asList } from '@/lib/asList';
import {
  filesToBundle,
  downloadBundle,
  type ScriptBundle
} from '@/lib/scriptBundle';
import { cn } from '@/lib/utils';
// Initializes the shared i18next singleton (see ScriptsPage.tsx).
import '../../lib/i18n';

/** Server-side cap on scripts per bundle (mirrors MAX_BUNDLE_SCRIPTS). */
const MAX_BUNDLE_SCRIPTS = 200;

type ImportMode = 'skip' | 'rename' | 'new-version';

type PreviewEntry = {
  index: number;
  name: string;
  status: 'new' | 'name-conflict' | 'invalid';
  error?: string;
  existingVersion?: number;
};

type ImportResult = {
  imported: number;
  skipped: number;
  renamed: number;
  versioned: number;
  errors: Array<{ index: number; name: string; error: string }>;
};

// ---------------------------------------------------------------------------
// Export modal: multi-select → download .json
// ---------------------------------------------------------------------------

export type ExportableScript = { id: string; name: string; language?: string; category?: string };

export function ScriptBundleExportModal({
  isOpen,
  onClose
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('scripts');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [scripts, setScripts] = useState<ExportableScript[]>([]);
  const [loadingList, setLoadingList] = useState(false);

  // The Scripts page keeps only the first page of GET /scripts (default limit
  // 50) — fetch the full library here so every script is offered for export.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      setLoadingList(true);
      try {
        const all: ExportableScript[] = [];
        // API caps limit at 100/page; walk pages (bounded) until exhausted.
        for (let page = 1; page <= 10; page++) {
          const response = await fetchWithAuth(`/scripts?limit=100&page=${page}`);
          if (!response.ok) break;
          const data = await response.json();
          const rows = asList(data, 'scripts') as ExportableScript[];
          all.push(...rows.map(s => ({ id: s.id, name: s.name, language: s.language })));
          const total = (data as { pagination?: { total?: number } })?.pagination?.total;
          if (rows.length === 0 || (typeof total === 'number' && all.length >= total)) break;
        }
        if (!cancelled) setScripts(all);
      } catch {
        // List failure leaves an empty modal; the empty-state copy covers it.
      } finally {
        if (!cancelled) setLoadingList(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const overLimit = selected.size > MAX_BUNDLE_SCRIPTS;

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleExport = async () => {
    if (selected.size === 0) return;
    setExporting(true);
    try {
      const ids = [...selected].join(',');
      const response = await fetchWithAuth(`/scripts/bundle/export?ids=${encodeURIComponent(ids)}`);
      if (!response.ok) {
        throw new Error(t('bundle.exportFailed'));
      }
      const bundle = (await response.json()) as ScriptBundle;
      downloadBundle(bundle);
      onClose();
    } catch (err) {
      showToast({
        type: 'error',
        message: err instanceof Error ? err.message : t('bundle.exportFailed')
      });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="flex w-full max-w-lg max-h-[80vh] flex-col overflow-hidden rounded-lg border bg-card shadow-lg">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold">{t('bundle.exportTitle')}</h2>
            <p className="text-sm text-muted-foreground">{t('bundle.exportDescription')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
            data-testid="bundle-export-close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="border-b px-6 py-2">
          <button
            type="button"
            className="text-sm text-primary hover:underline"
            onClick={() =>
              setSelected(prev =>
                prev.size === scripts.length ? new Set() : new Set(scripts.map(s => s.id))
              )
            }
            data-testid="bundle-export-select-all"
          >
            {selected.size === scripts.length ? t('bundle.clearSelection') : t('bundle.selectAll')}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {loadingList ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : scripts.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t('bundle.exportEmpty')}
            </p>
          ) : (
            <ul className="space-y-1">
              {scripts.map(script => (
                <li key={script.id}>
                  <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                    <input
                      type="checkbox"
                      checked={selected.has(script.id)}
                      onChange={() => toggle(script.id)}
                      data-testid={`bundle-export-check-${script.id}`}
                    />
                    <span className="flex-1 truncate">{script.name}</span>
                    {script.language && (
                      <span className="text-xs text-muted-foreground">{script.language}</span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t px-6 py-4">
          {overLimit && (
            <p className="mr-auto text-sm text-destructive">
              {t('bundle.exportLimit', { max: MAX_BUNDLE_SCRIPTS })}
            </p>
          )}
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
          >
            {t('common:actions.cancel')}
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={selected.size === 0 || overLimit || exporting}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            data-testid="bundle-export-submit"
          >
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {t('bundle.exportSelected', { count: selected.size })}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Import modal: pick files → preview → commit
// ---------------------------------------------------------------------------

export function ScriptBundleImportModal({
  isOpen,
  onClose,
  onImported
}: {
  isOpen: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const { t } = useTranslation('scripts');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [bundle, setBundle] = useState<ScriptBundle | null>(null);
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [preview, setPreview] = useState<PreviewEntry[] | null>(null);
  const [mode, setMode] = useState<ImportMode>('skip');
  const [partnerWide, setPartnerWide] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  // Same UX gate as ScriptForm (#3262): the option is only meaningful for
  // partner-scope callers (the route rejects every other scope), and within
  // partner scope only for users with the partner-wide capability (absent =
  // capable; the server enforces regardless).
  const canManagePartnerWide = useAuthStore(s => s.user?.canManagePartnerWide ?? true);
  const { scope: jwtScope, partnerId: jwtPartnerId } = getJwtClaims();
  const showPartnerWide = jwtScope === 'partner' && !!jwtPartnerId && canManagePartnerWide;
  const currentOrgId = useOrgStore(s => s.currentOrgId);

  if (!isOpen) return null;

  const reset = () => {
    setBundle(null);
    setFileErrors([]);
    setPreview(null);
    setResult(null);
    setPartnerWide(false);
    setMode('skip');
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const targetBody = (nextPartnerWide = partnerWide) => ({
    availability: nextPartnerWide ? ('partner' as const) : ('org' as const),
    ...(nextPartnerWide || !currentOrgId ? {} : { orgId: currentOrgId })
  });

  const runPreview = async (nextBundle: ScriptBundle, nextPartnerWide = partnerWide) => {
    setBusy(true);
    // Clear any previous preview FIRST: if this request fails, a stale
    // conflict table must not leave the Import button armed for a bundle or
    // target scope the table was never computed against.
    setPreview(null);
    try {
      const data = await runAction<{ entries: PreviewEntry[] }>({
        request: () =>
          fetchWithAuth('/scripts/bundle/preview', {
            method: 'POST',
            body: JSON.stringify({ bundle: nextBundle, ...targetBody(nextPartnerWide) })
          }),
        errorFallback: t('bundle.previewFailed')
      });
      setPreview(data.entries);
    } catch (err) {
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('bundle.previewFailed') });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    // Invalidate the previous selection before parsing the new one.
    setBundle(null);
    setPreview(null);
    const { bundle: parsed, errors } = await filesToBundle(Array.from(fileList));
    setFileErrors(errors);
    if (!parsed) {
      if (errors.length > 0) {
        showToast({ type: 'error', message: t('bundle.parseErrors') });
      }
      return;
    }
    setBundle(parsed);
    await runPreview(parsed);
  };

  const handleTogglePartnerWide = async (checked: boolean) => {
    setPartnerWide(checked);
    // Conflict detection depends on the target scope — re-run the preview.
    if (bundle) await runPreview(bundle, checked);
  };

  const handleImport = async () => {
    if (!bundle) return;
    setBusy(true);
    try {
      const data = await runAction<ImportResult>({
        request: () =>
          fetchWithAuth('/scripts/bundle/import', {
            method: 'POST',
            body: JSON.stringify({ bundle, mode, ...targetBody() })
          }),
        errorFallback: t('bundle.importFailed'),
        successMessage: res =>
          t('bundle.resultSummary', {
            imported: res.imported,
            renamed: res.renamed,
            versioned: res.versioned,
            skipped: res.skipped,
            failed: res.errors.length
          })
      });
      setResult(data);
      onImported();
    } catch (err) {
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('bundle.importFailed') });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="flex w-full max-w-2xl max-h-[85vh] flex-col overflow-hidden rounded-lg border bg-card shadow-lg">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold">{t('bundle.importTitle')}</h2>
            <p className="text-sm text-muted-foreground">{t('bundle.importDescription')}</p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
            data-testid="bundle-import-close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-6">
          {/* Scripts run as SYSTEM — say so plainly. */}
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span data-testid="bundle-import-system-warning">{t('bundle.systemWarning')}</span>
          </div>

          {!result && (
            <div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".json,.ps1,.sh,.py,.bat,.cmd"
                className="hidden"
                onChange={e => {
                  void handleFiles(e.target.files);
                  e.target.value = '';
                }}
                data-testid="bundle-import-file-input"
              />
              {/* Folder picker: webkitdirectory hands over every file in a
                  folder; filesToBundle keeps only supported script files. */}
              <input
                ref={folderInputRef}
                type="file"
                multiple
                className="hidden"
                // @ts-expect-error non-standard but universally supported attribute
                webkitdirectory=""
                onChange={e => {
                  void handleFiles(e.target.files);
                  e.target.value = '';
                }}
                data-testid="bundle-import-folder-input"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busy}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium transition hover:bg-muted disabled:opacity-60"
                  data-testid="bundle-import-choose-files"
                >
                  <Upload className="h-4 w-4" />
                  {t('bundle.chooseFiles')}
                </button>
                <button
                  type="button"
                  onClick={() => folderInputRef.current?.click()}
                  disabled={busy}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium transition hover:bg-muted disabled:opacity-60"
                  data-testid="bundle-import-choose-folder"
                >
                  <Upload className="h-4 w-4" />
                  {t('bundle.chooseFolder')}
                </button>
              </div>
              {fileErrors.length > 0 && (
                <p className="mt-2 text-sm text-destructive">
                  {t('bundle.parseErrors')}: {fileErrors.join(', ')}
                </p>
              )}
            </div>
          )}

          {bundle && !result && (
            <p className="text-sm text-muted-foreground">
              {t('bundle.scriptCount', { count: bundle.scripts.length })}
            </p>
          )}

          {preview && !result && (
            <div className="space-y-4">
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50 text-left">
                      <th className="px-3 py-2 font-medium">{t('bundle.nameColumn')}</th>
                      <th className="px-3 py-2 font-medium">{t('bundle.previewTitle')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map(entry => (
                      <tr key={entry.index} className="border-b last:border-0">
                        <td className="max-w-[280px] truncate px-3 py-2">{entry.name}</td>
                        <td className="px-3 py-2">
                          <span
                            className={cn(
                              'inline-flex items-center rounded-full px-2 py-0.5 text-xs',
                              entry.status === 'new'
                                ? 'bg-green-500/15 text-green-700 dark:text-green-400'
                                : entry.status === 'name-conflict'
                                  ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
                                  : 'bg-destructive/15 text-destructive'
                            )}
                          >
                            {entry.status === 'new'
                              ? t('bundle.statusNew')
                              : entry.status === 'name-conflict'
                                ? t('bundle.statusConflict')
                                : t('bundle.statusInvalid')}
                          </span>
                          {entry.status === 'invalid' && entry.error && (
                            <p className="mt-1 text-xs text-destructive">{entry.error}</p>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="bundle-import-mode">
                  {t('bundle.modeLabel')}
                </label>
                <select
                  id="bundle-import-mode"
                  value={mode}
                  onChange={e => setMode(e.target.value as ImportMode)}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  data-testid="bundle-import-mode"
                >
                  <option value="skip">{t('bundle.modeSkip')}</option>
                  <option value="rename">{t('bundle.modeRename')}</option>
                  <option value="new-version">{t('bundle.modeNewVersion')}</option>
                </select>
              </div>

              {showPartnerWide && (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={partnerWide}
                    onChange={e => void handleTogglePartnerWide(e.target.checked)}
                    data-testid="bundle-import-partner-wide"
                  />
                  {t('bundle.partnerWide')}
                </label>
              )}
            </div>
          )}

          {result && (
            <div className="space-y-3" data-testid="bundle-import-result">
              <p className="text-sm">
                {t('bundle.resultSummary', {
                  imported: result.imported,
                  renamed: result.renamed,
                  versioned: result.versioned,
                  skipped: result.skipped,
                  failed: result.errors.length
                })}
              </p>
              {result.errors.length > 0 && (
                <ul className="space-y-1 text-sm text-destructive">
                  {result.errors.map(err => (
                    <li key={`${err.index}-${err.name}`}>
                      {err.name}: {err.error}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t px-6 py-4">
          <button
            type="button"
            onClick={handleClose}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
          >
            {result ? t('common:actions.done') : t('common:actions.cancel')}
          </button>
          {!result && (
            <button
              type="button"
              onClick={handleImport}
              disabled={!bundle || !preview || busy}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              data-testid="bundle-import-submit"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {t('bundle.importCommit', { count: bundle?.scripts.length ?? 0 })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
