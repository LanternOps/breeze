import { Trash2, AlertTriangle, File, Folder, X } from 'lucide-react';
import { Dialog } from '../shared/Dialog';
import { formatNumber } from '@/lib/i18n/format';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

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
  if (bytes < 1024 * 1024) return `${formatNumber(bytes / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${formatNumber(bytes / (1024 * 1024), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
  if (bytes < 1024 * 1024 * 1024 * 1024) return `${formatNumber(bytes / (1024 * 1024 * 1024), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} GB`;
  return `${formatNumber(bytes / (1024 * 1024 * 1024 * 1024), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TB`;
}

export default function DeleteConfirmDialog({
  open,
  items,
  onConfirm,
  onClose,
}: DeleteConfirmDialogProps) {
  const { t } = useTranslation('remote');
  if (items.length === 0) return null;

  const totalSize = items.reduce((sum, item) => sum + (item.size ?? 0), 0);
  const hasSizeInfo = items.some((item) => item.size !== undefined && item.size !== null);

  const heading =
    items.length === 1
      ? t('deleteConfirmDialog.headingSingle', { name: items[0].name })
      : t('deleteConfirmDialog.headingMultiple', { count: items.length });

  return (
    <Dialog open={open} onClose={onClose} title={heading} maxWidth="md" className="p-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-warning" />
            <h2 className="text-lg font-semibold">{heading}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            title={t('common:actions.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Item list */}
        <div className="mt-4 max-h-48 overflow-auto rounded-md border bg-muted/30">
          {items.map((item) => {
            const Icon = item.type === 'directory' ? Folder : File;
            return (
              <div
                key={item.path}
                className="flex items-center gap-3 px-3 py-2 text-sm border-b last:border-b-0"
              >
                <Icon
                  className={
                    item.type === 'directory'
                      ? 'h-4 w-4 shrink-0 text-primary'
                      : 'h-4 w-4 shrink-0 text-muted-foreground'
                  }
                />
                <span className="truncate">{item.name}</span>
                {item.size !== undefined && item.size !== null && (
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                    {formatSize(item.size)}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* Summary */}
        <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
          <span>{t('deleteConfirmDialog.itemCount', { count: items.length })}</span>
          {hasSizeInfo && <span>{t('deleteConfirmDialog.totalSize', { size: formatSize(totalSize) })}</span>}
        </div>

        {/* Warning */}
        <div className="mt-4 flex items-start gap-2 rounded-md bg-muted px-3 py-2">
          <Trash2 className="h-4 w-4 shrink-0 text-muted-foreground mt-0.5" />
          <p className="text-xs text-muted-foreground">
            {t('deleteConfirmDialog.recycleBinNotice')}
          </p>
        </div>

        {/* Actions */}
        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            onClick={() => onConfirm(false)}
            className="flex-1 flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90"
          >
            <Trash2 className="h-4 w-4" />
            {t('deleteConfirmDialog.moveToTrash')}
          </button>

          <button
            type="button"
            onClick={() => onConfirm(true)}
            className="flex items-center justify-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
          >
            {t('deleteConfirmDialog.deletePermanently')}
          </button>

          <button
            type="button"
            onClick={onClose}
            className="flex items-center justify-center rounded-md border px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {t('common:actions.cancel')}
          </button>
        </div>
    </Dialog>
  );
}
