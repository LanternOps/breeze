import { useCallback, useEffect, useRef, type ReactNode } from 'react';
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

  // #3705: single-fire latch. `disabled={isLoading}` cannot hold on the second
  // half of a double-click — it reads a value captured at render, still `false`
  // when the second click lands — and neither can a call site's own
  // `actionInProgress` flag, for the same reason. A ref reads CURRENT, so it
  // holds synchronously inside the one handler invocation.
  //
  // Call sites that keep the dialog mounted across an async action get the
  // latch released when `isLoading` settles back to false, so a failed action
  // is still retryable. Sites that unmount on confirm get a fresh ref anyway.
  const confirmLatchRef = useRef(false);
  useEffect(() => {
    if (!open || !isLoading) confirmLatchRef.current = false;
  }, [open, isLoading]);

  // While `isLoading` the buttons stay focusable (`aria-disabled`, not
  // `disabled`): a disabled element loses focus to <body>, which lets Tab
  // escape the dialog's own trap mid-request and leaves the Drawer beneath
  // with nothing to restore focus to when the action settles.
  const handleConfirm = useCallback(() => {
    if (confirmLatchRef.current) {
      // The latch releasing depends on the call site either closing the dialog
      // or driving `isLoading`. Every current call site does one or the other,
      // but nothing enforces it, and a site that does neither would leave
      // Confirm permanently dead with no toast, log or console output — the
      // exact silent failure this component is meant to prevent. A blocked
      // click while `isLoading` is false is precisely that violation, so say so
      // in dev rather than letting site #49 discover it in production.
      if (import.meta.env.DEV && !isLoading) {
        console.warn(
          `[ConfirmDialog] "${title}": Confirm was pressed again while the ` +
            'previous press is still latched, but isLoading is false and the ' +
            'dialog is still open. onConfirm must either close the dialog or ' +
            'drive isLoading, otherwise this button is now permanently inert.',
        );
      }
      return;
    }
    confirmLatchRef.current = true;
    try {
      onConfirm();
    } catch (err) {
      // Releases the latch so the BUTTON survives a handler that throws
      // synchronously — it protects the control, not the user. Two limits worth
      // knowing: every current call site wraps async work as
      // `() => void someAsyncFn()`, whose rejection lands after this function
      // has already returned, so this branch is inert for the failure mode that
      // actually happens; and React 19 does not propagate a handler throw back
      // through dispatchEvent, it re-reports it as a window error event. So
      // rethrowing surfaces nothing to the user. Reporting the outcome of the
      // action remains the call site's job, via runAction.
      confirmLatchRef.current = false;
      throw err;
    }
  }, [onConfirm, isLoading, title]);

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
          onClick={isLoading ? undefined : onClose}
          aria-disabled={isLoading}
          className="rounded-md border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
        >
          {t('actions.cancel')}
        </button>
        <button
          type="button"
          onClick={isLoading ? undefined : handleConfirm}
          aria-disabled={isLoading}
          aria-busy={isLoading}
          data-testid={confirmTestId}
          className={`rounded-md px-4 py-2 text-sm font-medium transition-colors aria-disabled:opacity-50 aria-disabled:cursor-not-allowed ${
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
