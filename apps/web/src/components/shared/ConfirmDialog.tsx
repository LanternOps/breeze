import type { ReactNode } from 'react';
import { AlertOctagon, AlertTriangle } from 'lucide-react';
import { Dialog } from './Dialog';
import { useTranslation } from 'react-i18next';

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  variant?: 'destructive' | 'warning';
  isLoading?: boolean;
  /** data-testid for the confirm button (e2e suites are testid-only). */
  confirmTestId?: string;
  /** Optional extra content (e.g. a note field) rendered under the message. */
  children?: ReactNode;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel,
  variant = 'destructive',
  isLoading = false,
  confirmTestId,
  children,
}: ConfirmDialogProps) {
  const { t } = useTranslation('common');
  // Encode severity by SHAPE, not color alone: a stop-octagon for destructive
  // (irreversible removal) vs a caution-triangle for warning (a guarded but
  // non-destructive action like activate/generate). Colorblind users and a
  // glance-read both get the distinction without relying on red-vs-amber.
  const Icon = variant === 'destructive' ? AlertOctagon : AlertTriangle;
  return (
    <Dialog open={open} onClose={onClose} title={title} maxWidth="md" className="p-6">
      <div className="flex gap-4">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
            variant === 'destructive' ? 'bg-destructive/10' : 'bg-warning/10'
          }`}
        >
          <Icon
            className={`h-5 w-5 ${
              variant === 'destructive' ? 'text-destructive' : 'text-warning'
            }`}
            aria-hidden="true"
          />
        </div>
        <div className="flex-1">
          <h3 className="text-base font-semibold text-foreground">{title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{message}</p>
          {children != null && <div className="mt-4">{children}</div>}
        </div>
      </div>
      <div className="mt-6 flex justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          disabled={isLoading}
          className="rounded-md border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-50"
        >
          {t('actions.cancel')}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={isLoading}
          data-testid={confirmTestId}
          className={`rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
            variant === 'destructive'
              ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
              : 'bg-warning text-warning-foreground hover:bg-warning/90'
          }`}
        >
          {isLoading ? t('states.processing') : (confirmLabel ?? t('actions.confirm'))}
        </button>
      </div>
    </Dialog>
  );
}
