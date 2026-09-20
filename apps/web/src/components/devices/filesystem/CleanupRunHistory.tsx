/**
 * Cleanup-run history for one device (spec §5.2, §8).
 *
 * Both kinds in one list — the file engine's runs and W04's system runs — in
 * the order they were requested. The list endpoint deliberately does not ship
 * `plan.preview.candidates` or `executedActions`, so this renders the counts
 * it returns; a future detail drawer reads the full row from
 * `GET /filesystem/cleanup-runs/:runId`.
 *
 * `refreshToken` restarts the walk. Appending a freshly executed run to an
 * existing page would place it below rows that are newer than it after a
 * concurrent cleanup, so the honest refresh is to re-walk from the top.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, History, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '@/lib/i18n/format';
import { fetchWithAuth } from '@/stores/auth';
import '@/lib/i18n';
import { formatBytes, formatDateTime } from './filesystemTabUtils';

const PAGE_LIMIT = 20;

export type CleanupRunListItem = {
  id: string;
  kind: string;
  status: string;
  scanPath: string | null;
  requestedAt: string;
  approvedAt: string | null;
  bytesReclaimed: number;
  error: string | null;
  candidateCount: number;
  estimatedBytes: number;
  actionCount: number;
};

const statusClasses: Record<string, string> = {
  previewed: 'bg-gray-500/15 text-gray-700 border-gray-500/30',
  running: 'bg-blue-500/15 text-blue-700 border-blue-500/30',
  executed: 'bg-green-500/15 text-green-700 border-green-500/30',
  failed: 'bg-red-500/15 text-red-700 border-red-500/30',
};

function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

type Props = { deviceId: string; refreshToken: number };

export default function CleanupRunHistory({ deviceId, refreshToken }: Props) {
  const { t } = useTranslation('devices');
  const [runs, setRuns] = useState<CleanupRunListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const loadPage = useCallback(
    async (cursor: string | null, append: boolean) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      setLoading(true);
      setError(null);
      try {
        const query = cursor
          ? `?limit=${PAGE_LIMIT}&cursor=${encodeURIComponent(cursor)}`
          : `?limit=${PAGE_LIMIT}`;
        const response = await fetchWithAuth(
          `/devices/${deviceId}/filesystem/cleanup-runs${query}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (!response.ok) throw new Error(t('deviceFilesystemTab.historyFailed'));

        const body = await response.json();
        const page = (body?.data?.runs ?? []) as CleanupRunListItem[];
        if (controller.signal.aborted) return;
        setRuns((prev) => (append ? [...prev, ...page] : page));
        setNextCursor((body?.data?.nextCursor ?? null) as string | null);
      } catch (err) {
        if (isAbort(err) || controller.signal.aborted) return;
        setError(t('deviceFilesystemTab.historyFailed'));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [deviceId, t],
  );

  useEffect(() => {
    void loadPage(null, false);
    return () => {
      controllerRef.current?.abort();
    };
  }, [loadPage, refreshToken]);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs" data-testid="cleanup-run-history">
      <h4 className="flex items-center gap-2 font-semibold">
        <History className="h-4 w-4 text-muted-foreground" />
        {t('deviceFilesystemTab.historyTitle')}
      </h4>

      {error && (
        <div
          role="alert"
          data-testid="cleanup-run-history-error"
          className="mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            <span>{error}</span>
          </div>
        </div>
      )}

      {!error && runs.length === 0 && !loading && (
        <p className="mt-3 text-sm text-muted-foreground">{t('deviceFilesystemTab.historyEmpty')}</p>
      )}

      <div className="mt-3 space-y-2">
        {runs.map((run) => (
          <div
            key={run.id}
            data-testid={`cleanup-run-${run.id}`}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
          >
            <div className="min-w-0">
              <p className="truncate font-medium">
                <span>
                  {run.kind === 'system'
                    ? t('deviceFilesystemTab.historyKindSystem')
                    : t('deviceFilesystemTab.historyKindFiles')}
                </span>
                {run.scanPath ? ` · ${run.scanPath}` : ''}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatDateTime(run.requestedAt)} ·{' '}
                {t('deviceFilesystemTab.historyCandidates', { count: run.candidateCount })}
                {run.actionCount > 0 ? ` · ${formatNumber(run.actionCount)}` : ''}
              </p>
              {run.error && <p className="text-xs text-amber-700">{run.error}</p>}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {t('deviceFilesystemTab.historyReclaimed', { size: formatBytes(run.bytesReclaimed) })}
              </span>
              <span
                className={`inline-flex rounded-full border px-2 py-0.5 text-xs ${statusClasses[run.status] ?? 'bg-muted/30 text-muted-foreground border-muted'}`}
              >
                {/* i18n-dynamic: the status is a database enum label. */}
                {t(/* i18n-dynamic */ `deviceFilesystemTab.status.${run.status}`, {
                  defaultValue: run.status,
                })}
              </span>
            </div>
          </div>
        ))}
      </div>

      {nextCursor && !error && (
        <button
          type="button"
          data-testid="cleanup-run-history-more"
          onClick={() => { void loadPage(nextCursor, true); }}
          disabled={loading}
          className="mt-3 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
        >
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t('deviceFilesystemTab.historyLoadMore')}
        </button>
      )}
    </div>
  );
}
