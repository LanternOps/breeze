import { Trash2, AlertTriangle, File, Folder, X } from 'lucide-react';

type DeleteConfirmDialogProps = {
  open: boolean;
  items: { name: string; path: string; size?: number; type: string }[];
  onConfirm: (permanent: boolean) => void;
  onClose: () => void;
};

function formatSize(bytes?: number): string {
  if (bytes === undefined || bytes === null) return '-';
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes < 1024 * 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  return `${(bytes / (1024 * 1024 * 1024 * 1024)).toFixed(2)} TB`;
}

export default function DeleteConfirmDialog({
  open,
  items,
  onConfirm,
  onClose,
}: DeleteConfirmDialogProps) {
  if (!open || items.length === 0) return null;

  const totalSize = items.reduce((sum, item) => sum + (item.size ?? 0), 0);
  const hasSizeInfo = items.some((item) => item.size !== undefined && item.size !== null);

  const heading =
    items.length === 1
      ? `Delete ${items[0].name}?`
      : `Delete ${items.length} items?`;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-400" />
            <h2 className="text-lg font-semibold text-gray-100">{heading}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-colors"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Item list */}
        <div className="mt-4 max-h-48 overflow-auto rounded-md border border-gray-700 bg-gray-900/50">
          {items.map((item) => {
            const Icon = item.type === 'directory' ? Folder : File;
            return (
              <div
                key={item.path}
                className="flex items-center gap-3 px-3 py-2 text-sm border-b border-gray-700/50 last:border-b-0"
              >
                <Icon
                  className={
                    item.type === 'directory'
                      ? 'h-4 w-4 shrink-0 text-blue-400'
                      : 'h-4 w-4 shrink-0 text-gray-400'
                  }
                />
                <span className="truncate text-gray-200">{item.name}</span>
                {item.size !== undefined && item.size !== null && (
                  <span className="ml-auto shrink-0 text-xs text-gray-500 tabular-nums">
                    {formatSize(item.size)}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* Summary */}
        <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
          <span>{items.length} item{items.length !== 1 ? 's' : ''}</span>
          {hasSizeInfo && <span>Total: {formatSize(totalSize)}</span>}
        </div>

        {/* Warning */}
        <div className="mt-4 flex items-start gap-2 rounded-md bg-gray-700/40 px-3 py-2">
          <Trash2 className="h-4 w-4 shrink-0 text-gray-400 mt-0.5" />
          <p className="text-xs text-gray-300">
            Files will be moved to the recycle bin and can be restored later.
          </p>
        </div>

        {/* Actions */}
        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            onClick={() => onConfirm(false)}
            className="flex-1 flex items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
          >
            <Trash2 className="h-4 w-4" />
            Move to Trash
          </button>

          <button
            type="button"
            onClick={() => onConfirm(true)}
            className="flex items-center justify-center gap-1.5 rounded-md bg-red-600/20 border border-red-600/40 px-3 py-2 text-xs font-medium text-red-400 transition-colors hover:bg-red-600/30 hover:text-red-300"
          >
            Delete Permanently
          </button>

          <button
            type="button"
            onClick={onClose}
            className="flex items-center justify-center rounded-md bg-gray-700 px-3 py-2 text-sm font-medium text-gray-300 transition-colors hover:bg-gray-600"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
