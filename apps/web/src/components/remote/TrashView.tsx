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
  type TrashItem,
} from './fileOperations';

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
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes < 1024 * 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  return `${(bytes / (1024 * 1024 * 1024 * 1024)).toFixed(2)} TB`;
}

export default function TrashView({ deviceId, onRestore }: TrashViewProps) {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionLoading, setActionLoading] = useState<
    'restore' | 'purge' | 'empty' | null
  >(null);

  const fetchTrash = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listTrash(deviceId);
      setItems(data);
      setSelected(new Set());
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to load trash';
      setError(message);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

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
    try {
      await restoreFromTrash(deviceId, ids);
      await fetchTrash();
      onRestore();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Restore failed';
      setError(message);
    } finally {
      setActionLoading(null);
    }
  }, [deviceId, selected, fetchTrash, onRestore]);

  const handlePurgeSelected = useCallback(async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;

    const confirmed = window.confirm(
      `Permanently delete ${ids.length} item(s)? This cannot be undone.`
    );
    if (!confirmed) return;

    setActionLoading('purge');
    try {
      await purgeTrash(deviceId, ids);
      await fetchTrash();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Purge failed';
      setError(message);
    } finally {
      setActionLoading(null);
    }
  }, [deviceId, selected, fetchTrash]);

  const handleEmptyTrash = useCallback(async () => {
    const confirmed = window.confirm(
      'Empty the entire trash? All items will be permanently deleted. This cannot be undone.'
    );
    if (!confirmed) return;

    setActionLoading('empty');
    try {
      await purgeTrash(deviceId);
      await fetchTrash();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to empty trash';
      setError(message);
    } finally {
      setActionLoading(null);
    }
  }, [deviceId, fetchTrash]);

  const allSelected = items.length > 0 && selected.size === items.length;
  const someSelected = selected.size > 0 && selected.size < items.length;

  // Loading state
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-gray-400">
        <Loader2 className="h-8 w-8 animate-spin" />
        <p className="mt-3 text-sm">Loading trash...</p>
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
          Retry
        </button>
      </div>
    );
  }

  // Empty state
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-gray-400">
        <Trash2 className="h-10 w-10 text-gray-600" />
        <p className="mt-3 text-sm">Trash is empty</p>
        <button
          type="button"
          onClick={fetchTrash}
          className="mt-3 flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
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
            {items.length} item{items.length !== 1 ? 's' : ''} in trash
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
                Restore Selected ({selected.size})
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
                Delete Permanently ({selected.size})
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
            Empty Trash
          </button>

          <button
            type="button"
            onClick={fetchTrash}
            disabled={actionLoading !== null}
            className="flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-gray-700 disabled:opacity-50"
            title="Refresh"
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

      {/* Trash table */}
      <div className="flex-1 overflow-auto">
        <table className="min-w-full divide-y divide-gray-700">
          <thead className="sticky top-0 bg-gray-900">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-gray-400">
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
              <th className="px-4 py-3">Original Path</th>
              <th className="w-12 px-4 py-3">Type</th>
              <th className="px-4 py-3 text-right">Size</th>
              <th className="px-4 py-3">Deleted At</th>
              <th className="px-4 py-3">Deleted By</th>
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
    </div>
  );
}
