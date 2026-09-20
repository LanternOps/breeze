/**
 * Select → confirm → execute → report, inside the tab (spec §8, §2 defect 4).
 *
 * The behaviour this replaces put Execute in File Manager, where it re-derived
 * candidates from whatever snapshot was newest and posted no `cleanupRunId` —
 * the exact race the API's pinning exists to prevent. Here the pinned run id
 * comes from the preview this panel was handed, and the selection is cleared
 * whenever that run changes, so a click can only ever delete paths from the
 * candidate set the operator actually looked at.
 *
 * The result panel reports all five outcome buckets even at zero and renders
 * failures amber. A partial failure in a green box (the old File Manager
 * behaviour) reads as success at a glance.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { showToast } from '@/components/shared/Toast';
import { ActionError, runAction } from '@/lib/runAction';
import { formatNumber } from '@/lib/i18n/format';
import { fetchWithAuth } from '@/stores/auth';
import '@/lib/i18n';
import {
  CLEANUP_ACTION_STATUSES,
  formatBytes,
  selectedBytes,
  summariseActionStatuses,
  type CleanupCandidate,
  type CleanupExecuteResult,
  type FilesystemCleanupPreview,
} from './filesystemTabUtils';

const CONFIRM_PATH_PREVIEW_LIMIT = 10;

const RESULT_LABEL_KEYS: Record<(typeof CLEANUP_ACTION_STATUSES)[number], string> = {
  completed: 'deviceFilesystemTab.resultCompleted',
  failed: 'deviceFilesystemTab.resultFailures',
  skipped_locked: 'deviceFilesystemTab.resultSkippedLocked',
  rejected: 'deviceFilesystemTab.resultRejected',
  skipped_budget: 'deviceFilesystemTab.resultSkippedBudget',
};

type Props = {
  deviceId: string;
  /** What the confirm dialog names as the target, e.g. `C:\` or `/`. */
  volumeLabel: string;
  preview: FilesystemCleanupPreview | null;
  onExecuted: () => void;
};

export default function CleanupPanel({ deviceId, volumeLabel, preview, onExecuted }: Props) {
  const { t } = useTranslation('devices');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<CleanupExecuteResult | null>(null);

  const pinnedRunId = preview?.cleanupRunId ?? null;

  // A new preview pins a NEW run and a new candidate set. Carrying a stale
  // selection across that would submit paths from a different pinned plan,
  // which the API would reject — but the user would have been shown a
  // confirm dialog listing them as if they were about to be deleted.
  useEffect(() => {
    setSelected(new Set());
    setResult(null);
  }, [pinnedRunId]);

  const sortedCandidates = useMemo<CleanupCandidate[]>(
    () => [...(preview?.candidates ?? [])].sort((a, b) => b.sizeBytes - a.sizeBytes),
    [preview],
  );

  const byCategory = useMemo(() => {
    const map = new Map<string, CleanupCandidate[]>();
    for (const candidate of sortedCandidates) {
      const list = map.get(candidate.category) ?? [];
      list.push(candidate);
      map.set(candidate.category, list);
    }
    return map;
  }, [sortedCandidates]);

  const selectedPaths = useMemo(
    () => sortedCandidates.filter((c) => selected.has(c.path)).map((c) => c.path),
    [sortedCandidates, selected],
  );
  const selectedByteTotal = selectedBytes(sortedCandidates, selected);

  const toggle = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const selectCategory = useCallback((category: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const candidate of byCategory.get(category) ?? []) {
        if (on) next.add(candidate.path);
        else next.delete(candidate.path);
      }
      return next;
    });
  }, [byCategory]);

  const execute = useCallback(async () => {
    if (!pinnedRunId || selectedPaths.length === 0) return;
    setExecuting(true);
    try {
      const data = await runAction<CleanupExecuteResult>({
        request: () => fetchWithAuth(`/devices/${deviceId}/filesystem/cleanup-execute`, {
          method: 'POST',
          body: JSON.stringify({ cleanupRunId: pinnedRunId, paths: selectedPaths }),
        }),
        errorFallback: t('deviceFilesystemTab.cleanupFailed'),
        // The API answers 409 with a machine token in `error` and no `code`,
        // so without this the operator is shown "preview_expired" verbatim.
        friendly: (code) => {
          if (code === 'preview_expired') return t('deviceFilesystemTab.errorPreviewExpired');
          if (code === 'run_not_previewed') return t('deviceFilesystemTab.errorRunNotPreviewed');
          return undefined;
        },
        parseSuccess: (body) => (body as { data: CleanupExecuteResult }).data,
        successMessage: (value) =>
          t('deviceFilesystemTab.cleanupFinished', { size: formatBytes(value.bytesReclaimed) }),
      });
      setConfirmOpen(false);
      setResult(data);
      setSelected(new Set());
      onExecuted();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('deviceFilesystemTab.cleanupFailed') });
      }
      // Close the dialog on failure; keep the selection so the action is retryable.
      setConfirmOpen(false);
    } finally {
      setExecuting(false);
    }
  }, [deviceId, onExecuted, pinnedRunId, selectedPaths, t]);

  if (!preview) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-xs" data-testid="cleanup-panel">
        <h4 className="font-semibold">{t('deviceFilesystemTab.cleanupTitle')}</h4>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('deviceFilesystemTab.cleanupPreviewRequired')}
        </p>
      </div>
    );
  }

  const counts = result ? summariseActionStatuses(result.actions) : null;
  const failures = result?.actions.filter((a) => a.status === 'failed') ?? [];

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs" data-testid="cleanup-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="font-semibold">{t('deviceFilesystemTab.cleanupTitle')}</h4>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground" data-testid="cleanup-selection-summary">
            {t('deviceFilesystemTab.selectionSummary', {
              count: selectedPaths.length,
              size: formatBytes(selectedByteTotal),
            })}
          </span>
          <button
            type="button"
            data-testid="cleanup-execute"
            onClick={() => setConfirmOpen(true)}
            disabled={selectedPaths.length === 0 || executing || !pinnedRunId}
            className="inline-flex items-center gap-1.5 rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50"
          >
            {executing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            {t('deviceFilesystemTab.executeSelected', { count: selectedPaths.length })}
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {preview.categories.map((category) => {
          const rows = byCategory.get(category.category) ?? [];
          const allOn = rows.length > 0 && rows.every((row) => selected.has(row.path));
          return (
            <div
              key={category.category}
              data-testid={`cleanup-category-${category.category}`}
              className="rounded-md border bg-muted/20 p-3"
            >
              <p className="text-sm font-medium">
                {/* i18n-dynamic: the category comes from the agent payload. */}
                {t(/* i18n-dynamic */ `deviceFilesystemTab.categories.${category.category}`, {
                  defaultValue: category.category,
                })}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatNumber(category.count)} · {formatBytes(category.estimatedBytes)}
              </p>
              <button
                type="button"
                data-testid={`cleanup-category-select-all-${category.category}`}
                onClick={() => selectCategory(category.category, !allOn)}
                className="mt-2 text-xs font-medium text-primary hover:underline"
              >
                {allOn
                  ? t('deviceFilesystemTab.clearCategory')
                  : t('deviceFilesystemTab.selectAllInCategory')}
              </button>
            </div>
          );
        })}
      </div>

      <div className="mt-4 overflow-hidden rounded-md border">
        <div className="grid grid-cols-[auto_1fr_auto] gap-2 border-b bg-muted/30 px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <span aria-hidden="true" />
          <span>{t('deviceFilesystemTab.columnPath')}</span>
          <span className="text-right">{t('deviceFilesystemTab.columnSize')}</span>
        </div>
        <div className="max-h-96 overflow-auto">
          {sortedCandidates.map((candidate) => (
            <label
              key={candidate.path}
              data-testid={`cleanup-candidate-${candidate.path}`}
              data-path={candidate.path}
              className="grid cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/40"
            >
              <input
                type="checkbox"
                data-testid={`cleanup-candidate-checkbox-${candidate.path}`}
                checked={selected.has(candidate.path)}
                onChange={() => toggle(candidate.path)}
              />
              <span className="truncate">{candidate.path}</span>
              <span className="shrink-0 whitespace-nowrap text-right font-medium tabular-nums">
                {formatBytes(candidate.sizeBytes)}
              </span>
            </label>
          ))}
        </div>
      </div>

      {result && counts && (
        <div className="mt-4 rounded-md border p-3" data-testid="cleanup-result">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('deviceFilesystemTab.resultTitle')}
          </p>
          <p className="mt-1 text-sm font-medium">
            {t('deviceFilesystemTab.resultReclaimed')}: {formatBytes(result.bytesReclaimed)}
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-4">
            {CLEANUP_ACTION_STATUSES.filter((status) => status !== 'failed').map((status) => (
              <div key={status} className="rounded bg-muted/20 px-2 py-1.5 text-xs">
                <span className="text-muted-foreground">{t(/* i18n-dynamic */ RESULT_LABEL_KEYS[status])}</span>
                <span className="ml-1 font-medium" data-testid={`cleanup-count-${status}`}>
                  {formatNumber(counts[status])}
                </span>
              </div>
            ))}
          </div>
          {failures.length > 0 && (
            <div
              data-testid="cleanup-failures"
              className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800"
            >
              <p className="flex items-center gap-1.5 font-medium">
                <AlertTriangle className="h-3.5 w-3.5" />
                {t('deviceFilesystemTab.resultFailures')} ({formatNumber(failures.length)})
              </p>
              <ul className="mt-1 space-y-0.5">
                {failures.map((action) => (
                  <li key={action.path} className="truncate">
                    {action.path}
                    {action.error ? ` — ${action.error}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => { void execute(); }}
        variant="destructive"
        isLoading={executing}
        dialogTestId="cleanup-confirm-dialog"
        confirmTestId="cleanup-confirm-button"
        title={t('deviceFilesystemTab.confirmTitle')}
        message={t('deviceFilesystemTab.confirmMessage', {
          count: selectedPaths.length,
          size: formatBytes(selectedByteTotal),
          volume: volumeLabel,
        })}
        confirmLabel={t('deviceFilesystemTab.confirmLabel')}
      >
        <div className="mt-3 rounded-md border bg-muted/20 p-2 text-xs">
          <p className="font-medium">
            {t('deviceFilesystemTab.confirmPathsHeading', {
              shown: Math.min(CONFIRM_PATH_PREVIEW_LIMIT, selectedPaths.length),
              total: selectedPaths.length,
            })}
          </p>
          <ul className="mt-1 space-y-0.5">
            {selectedPaths.slice(0, CONFIRM_PATH_PREVIEW_LIMIT).map((path) => (
              <li key={path} data-testid={`cleanup-confirm-path-${path}`} className="truncate">
                {path}
              </li>
            ))}
          </ul>
          {/* Spec §13 #2: pinning a path does not pin its contents. A
              contentsOnly trash target deletes whatever is in the bin when the
              command runs, which can be more than the preview listed — say so
              here rather than letting the operator infer a frozen list. */}
          <p className="mt-2 text-muted-foreground" data-testid="cleanup-confirm-contents-note">
            {t('deviceFilesystemTab.confirmContentsNote')}
          </p>
        </div>
      </ConfirmDialog>
    </div>
  );
}
