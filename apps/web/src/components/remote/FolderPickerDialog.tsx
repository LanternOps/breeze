import { useState, useCallback, useEffect } from 'react';
import { Folder, ChevronRight, ArrowUp, X, Loader2, AlertCircle } from 'lucide-react';
import { fetchWithAuth } from '@/stores/auth';
import { buildBreadcrumbs, getParentPath, isPathRoot } from './filePathUtils';

type FileEntry = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: string;
  permissions?: string;
};

export type FolderPickerDialogProps = {
  open: boolean;
  title: string;
  deviceId: string;
  initialPath: string;
  onSelect: (path: string) => void;
  onClose: () => void;
};

export default function FolderPickerDialog({
  open,
  title,
  deviceId,
  initialPath,
  onSelect,
  onClose
}: FolderPickerDialogProps) {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [directories, setDirectories] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDirectory = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({ path });
      const response = await fetchWithAuth(`/system-tools/devices/${deviceId}/files?${params}`);
      if (!response.ok) {
        const json = await response.json().catch(() => ({ error: 'Failed to load directory' }));
        throw new Error(json.error || 'Failed to load directory');
      }
      const json = await response.json();
      const entries: FileEntry[] = Array.isArray(json.data) ? json.data : [];
      // Only keep directories
      setDirectories(
        entries
          .filter((e) => e.type === 'directory')
          .sort((a, b) => a.name.localeCompare(b.name))
      );
      setCurrentPath(path);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load directory';
      setError(message);
      setDirectories([]);
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  // Fetch directory when dialog opens or initialPath changes
  useEffect(() => {
    if (open) {
      setCurrentPath(initialPath);
      fetchDirectory(initialPath);
    }
  }, [open, initialPath, fetchDirectory]);

  const navigateTo = useCallback((path: string) => {
    fetchDirectory(path);
  }, [fetchDirectory]);

  const goUp = useCallback(() => {
    const parentPath = getParentPath(currentPath);
    navigateTo(parentPath);
  }, [currentPath, navigateTo]);

  const handleDoubleClick = useCallback((entry: FileEntry) => {
    if (entry.type === 'directory') {
      navigateTo(entry.path);
    }
  }, [navigateTo]);

  const handleSelect = useCallback(() => {
    onSelect(currentPath);
  }, [currentPath, onSelect]);

  // Close on Escape key
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const breadcrumbs = buildBreadcrumbs(currentPath);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="relative z-10 flex max-h-[80vh] w-full max-w-xl flex-col rounded-lg border border-gray-700 bg-gray-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-700 px-4 py-3">
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-gray-800 hover:text-white"
            title="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Breadcrumb navigation */}
        <div className="flex items-center gap-2 border-b border-gray-700 px-4 py-2">
          <button
            type="button"
            onClick={goUp}
            disabled={isPathRoot(currentPath)}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-gray-800 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-400"
            title="Go up"
          >
            <ArrowUp className="h-4 w-4" />
          </button>

          <div className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
            <button
              type="button"
              onClick={() => navigateTo(breadcrumbs.rootPath)}
              className="shrink-0 text-gray-300 hover:text-blue-400"
            >
              {breadcrumbs.rootLabel}
            </button>
            {breadcrumbs.segments.map((segment) => (
              <span key={segment.path} className="flex items-center gap-1">
                <ChevronRight className="h-4 w-4 shrink-0 text-gray-600" />
                <button
                  type="button"
                  onClick={() => navigateTo(segment.path)}
                  className="truncate text-gray-300 hover:text-blue-400"
                >
                  {segment.label}
                </button>
              </span>
            ))}
          </div>
        </div>

        {/* Current path display */}
        <div className="border-b border-gray-700 bg-gray-800/50 px-4 py-2">
          <p className="text-xs text-gray-400">Selected folder</p>
          <p className="truncate text-sm font-medium text-white">{currentPath}</p>
        </div>

        {/* Directory listing */}
        <div className="min-h-[200px] flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center gap-2 py-12">
              <AlertCircle className="h-6 w-6 text-red-500" />
              <p className="text-sm text-red-400">{error}</p>
              <button
                type="button"
                onClick={() => fetchDirectory(currentPath)}
                className="text-xs text-blue-400 hover:underline"
              >
                Retry
              </button>
            </div>
          ) : directories.length === 0 ? (
            <div className="py-12 text-center text-sm text-gray-500">
              No subdirectories
            </div>
          ) : (
            <div className="divide-y divide-gray-800">
              {directories.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className="flex w-full items-center gap-3 px-4 py-2 text-left transition hover:bg-gray-800"
                  onDoubleClick={() => handleDoubleClick(entry)}
                  onClick={() => navigateTo(entry.path)}
                >
                  <Folder className="h-5 w-5 shrink-0 text-blue-500" />
                  <span className="truncate text-sm text-gray-200">{entry.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-gray-700 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-600 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSelect}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
          >
            Select this folder
          </button>
        </div>
      </div>
    </div>
  );
}
