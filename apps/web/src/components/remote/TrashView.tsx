import { useState, useCallback, useEffect } from 'react';
import {
  Trash2,
  RotateCcw,
  RefreshCw,
  Folder,
  File,
  Loader2,
  AlertTriangle,
} from 'lucide-react';
import {
  listTrash,
  restoreFromTrash,
  purgeTrash,
  summarizeBulkResults,
  type TrashItem,
} from './fileOperations';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { formatNumber } from '@/lib/i18n/format';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

type TrashViewProps = {
  deviceId: string;
  onRestore: () => void; // callback to refresh file list after restore
};

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatSize(bytes?: number): string {
  if (bytes === undefined || bytes === null) return '-';
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${formatNumber(bytes / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${formatNumber(bytes / (1024 * 1024), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
  if (bytes < 1024 * 1024 * 1024 * 1024)
    return `${formatNumber(bytes / (1024 * 1024 * 1024), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} GB`;
  return `${formatNumber(bytes / (1024 * 1024 * 1024 * 1024), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TB`;
}

export default function TrashView({ deviceId, onRestore }: TrashViewProps) {
  const { t } = useTranslation('remote');
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionLoading, setActionLoading] = useState<
    'restore' | 'purge' | 'empty' | null
  >(null);
  const [confirmAction, setConfirmAction] = useState<'purge' | 'empty' | null>(null);

  const fetchTrash = useCallback(async () => {
    setLoading(true);
    setError(null);
    setWarning(null);
    try {
      const data = await listTrash(deviceId);
      setItems(data);
      setSelected(new Set());
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t('trashView.errors.load');
      setError(message);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [deviceId, t]);

  useEffect(() => {
    fetchTrash();
  }, [fetchTrash]);

  const toggleItem = useCallback((trashId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(trashId)) {
        next.delete(trashId);
      } else {
        next.add(trashId);
      }
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      if (prev.size === items.length) {
        return new Set();
      }
      return new Set(items.map((item) => item.trashId));
    });
  }, [items]);

  const handleRestore = useCallback(async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;

    setActionLoading('restore');
    setError(null);
    setWarning(null);
    try {
      const response = await restoreFromTrash(deviceId, ids);
      const { result, summary } = summarizeBulkResults(response.results);
      await fetchTrash();
      onRestore();
      if (result === 'failure') {
        setError(summary ?? t('trashView.errors.restore'));
      } else if (result === 'unverified') {
        setWarning(summary ?? t('trashView.errors.unverified'));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : t('trashView.errors.restore');
      setError(message);
    } finally {
      setActionLoading(null);
    }
  }, [deviceId, selected, fetchTrash, onRestore, t]);

  const handlePurgeSelected = useCallback(() => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setConfirmAction('purge');
  }, [selected]);

  const handleEmptyTrash = useCallback(() => {
    setConfirmAction('empty');
  }, []);

  const handleConfirmTrashAction = useCallback(async () => {
    if (!confirmAction) return;

    const action = confirmAction;
    setConfirmAction(null);
    setActionLoading(action);
    try {
      if (action === 'purge') {
        const ids = Array.from(selected);
        await purgeTrash(deviceId, ids);
      } else {
        await purgeTrash(deviceId);
      }
      await fetchTrash();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : action === 'purge' ? t('trashView.errors.purge') : t('trashView.errors.empty');
      setError(message);
    } finally {
      setActionLoading(null);
    }
  }, [confirmAction, deviceId, selected, fetchTrash, t]);

  const allSelected = items.length > 0 && selected.size === items.length;
  const someSelected = selected.size > 0 && selected.size < items.length;

  // Loading state
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-gray-400">
        <Loader2 className="h-8 w-8 animate-spin" />
        <p className="mt-3 text-sm">{t('trashView.loading')}</p>
      </div>
    );
  }

  // Error state
  if (error && items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-gray-400">
        <AlertTriangle className="h-8 w-8 text-red-400" />
        <p className="mt-3 text-sm text-red-400">{error}</p>
        <button
          type="button"
          onClick={fetchTrash}
          className="mt-3 text-xs text-blue-400 hover:underline"
        >
          {t('common:actions.retry')}
        </button>
      </div>
    );
  }

  // Empty state
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-gray-400">
        <Trash2 className="h-10 w-10 text-gray-600" />
        <p className="mt-3 text-sm">{t('trashView.empty')}</p>
        <button
          type="button"
          onClick={fetchTrash}
          className="mt-3 flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t('common:actions.refresh')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {/* Action bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-700 bg-gray-900/50 px-4 py-2">
        <div className="flex items-center gap-2">
          <Trash2 className="h-4 w-4 text-gray-400" />
          <span className="text-sm text-gray-300">
            {t('trashView.itemCount', { count: items.length })}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {selected.size > 0 && (
            <>
              <button
                type="button"
                onClick={handleRestore}
                disabled={actionLoading !== null}
                className="flex h-8 items-center gap-1.5 rounded-md bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {actionLoading === 'restore' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RotateCcw className="h-4 w-4" />
                )}
                {t('trashView.restoreSelected', { count: selected.size })}
              </button>
              <button
                type="button"
                onClick={handlePurgeSelected}
                disabled={actionLoading !== null}
                className="flex h-8 items-center gap-1.5 rounded-md bg-red-600 px-3 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
              >
                {actionLoading === 'purge' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                {t('trashView.deleteSelected', { count: selected.size })}
              </button>
            </>
          )}

          <button
            type="button"
            onClick={handleEmptyTrash}
            disabled={actionLoading !== null}
            className="flex h-8 items-center gap-1.5 rounded-md border border-red-700 px-3 text-sm font-medium text-red-400 hover:bg-red-900/30 disabled:opacity-50"
          >
            {actionLoading === 'empty' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            {t('trashView.emptyTrash')}
          </button>

          <button
            type="button"
            onClick={fetchTrash}
            disabled={actionLoading !== null}
            className="flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-gray-700 disabled:opacity-50"
            title={t('common:actions.refresh')}
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Error banner (inline, when items still visible) */}
      {error && (
        <div className="border-b border-red-800 bg-red-900/30 px-4 py-2 text-xs text-red-400">
          {error}
        </div>
      )}
      {/* Warning banner — unverified outcomes */}
      {warning && (
        <div className="border-b border-amber-800 bg-amber-900/30 px-4 py-2 text-xs text-amber-400">
          {warning}
        </div>
      )}

      {/* Trash table */}
      <div className="flex-1 overflow-auto">
        <table className="min-w-full divide-y divide-gray-700">
          <thead className="bg-muted/40 sticky top-0">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="w-10 px-4 py-3">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={toggleAll}
                  className="h-4 w-4 rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                />
              </th>
              <th className="px-4 py-3">{t('trashView.columns.originalPath')}</th>
              <th className="w-12 px-4 py-3">{t('common:labels.type')}</th>
              <th className="px-4 py-3 text-right">{t('trashView.columns.size')}</th>
              <th className="px-4 py-3">{t('trashView.columns.deletedAt')}</th>
              <th className="px-4 py-3">{t('trashView.columns.deletedBy')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-700">
            {items.map((item) => {
              const isSelected = selected.has(item.trashId);
              return (
                <tr
                  key={item.trashId}
                  className={`cursor-pointer transition ${
                    isSelected
                      ? 'bg-blue-900/30'
                      : 'bg-gray-800 hover:bg-gray-700'
                  }`}
                  onClick={() => toggleItem(item.trashId)}
                >
                  <td className="px-4 py-2">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleItem(item.trashId)}
                      onClick={(e) => e.stopPropagation()}
                      className="h-4 w-4 rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                    />
                  </td>
                  <td className="px-4 py-2 text-sm font-medium text-gray-200">
                    <span className="truncate" title={item.originalPath}>
                      {item.originalPath}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    {item.isDirectory ? (
                      <Folder className="h-4 w-4 text-blue-400" />
                    ) : (
                      <File className="h-4 w-4 text-gray-400" />
                    )}
                  </td>
                  <td className="px-4 py-2 text-right text-sm text-gray-400">
                    {item.isDirectory ? '-' : formatSize(item.sizeBytes)}
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-400">
                    {formatDate(item.deletedAt)}
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-400">
                    {item.deletedBy || '-'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ConfirmDialog
        open={confirmAction !== null}
        onClose={() => setConfirmAction(null)}
        onConfirm={handleConfirmTrashAction}
        title={confirmAction === 'empty' ? t('trashView.emptyTrash') : t('trashView.permanentlyDelete')}
        message={
          confirmAction === 'empty'
            ? t('trashView.emptyConfirm')
            : t('trashView.deleteConfirm', { count: selected.size })
        }
        confirmLabel={confirmAction === 'empty' ? t('trashView.emptyTrash') : t('trashView.deletePermanently')}
        variant="destructive"
        isLoading={actionLoading !== null}
      />
    </div>
  );
}
