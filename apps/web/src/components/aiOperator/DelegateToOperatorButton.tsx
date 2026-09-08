/**
 * "Delegate to Operator" action (W08 of #5205, #5246). Renders nothing unless
 * the `aiOperatorTasks` runtime flag is on (`useAiOperatorTasksGate`) — this
 * gates a write action that starts autonomous remediation on a customer
 * machine, and the gate defaults closed (see featuresStore.ts).
 *
 * Opens a ConfirmDialog collecting a required service name, then POSTs a
 * fixed `service_recovery` recipe task and navigates to the new task's
 * detail page. The recipe is not selectable in this slice.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot } from 'lucide-react';
import '@/lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { useAiOperatorTasksGate } from '../../stores/featuresStore';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { showToast } from '../shared/Toast';
import { ActionError, runAction } from '@/lib/runAction';

const SERVICE_NAME_MAX_LENGTH = 255;

export interface DelegateToOperatorButtonProps {
  orgId: string;
  deviceId: string;
  /** Hostname / display name, shown read-only in the confirm dialog. */
  deviceLabel: string;
  /** Org name, shown read-only when provided. */
  orgLabel?: string;
  source: { kind: 'alert'; id: string } | { kind: 'device'; id: string };
  /** Prefill for the service name field (e.g. from the triggering alert). */
  defaultServiceName?: string;
  className?: string;
}

export function DelegateToOperatorButton({
  orgId,
  deviceId,
  deviceLabel,
  orgLabel,
  source,
  defaultServiceName,
  className,
}: DelegateToOperatorButtonProps) {
  const { t } = useTranslation('aiOperator');
  const { enabled, loaded } = useAiOperatorTasksGate();

  const [open, setOpen] = useState(false);
  const [serviceName, setServiceName] = useState(defaultServiceName ?? '');
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Minted once per OPENED dialog and kept stable across retries of that same
  // dialog, so a double-click on Confirm — or a retry after a network blip —
  // reuses the same key and the server can dedupe it into a single task
  // instead of creating two. Only re-minted when the dialog is (re-)opened.
  const idempotencyKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (open) {
      idempotencyKeyRef.current = `delegate-${crypto.randomUUID()}`;
      setServiceName(defaultServiceName ?? '');
      setTouched(false);
    }
    // defaultServiceName intentionally excluded: only re-read when the dialog
    // opens, not on every prop change while it's open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!loaded || !enabled) return null;

  const trimmedServiceName = serviceName.trim();
  const showError = touched && trimmedServiceName.length === 0;

  const handleOpen = useCallback(() => setOpen(true), []);

  const handleClose = useCallback(() => {
    if (submitting) return;
    setOpen(false);
  }, [submitting]);

  const handleConfirm = useCallback(() => {
    if (trimmedServiceName.length === 0) {
      setTouched(true);
      return;
    }
    const clientIdempotencyKey = idempotencyKeyRef.current;
    if (!clientIdempotencyKey) return;

    setSubmitting(true);
    void (async () => {
      try {
        const result = await runAction<{ taskId: string }>({
          request: () => fetchWithAuth('/ai/operator/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mode: 'live',
              recipeKey: 'service_recovery',
              recipeVersion: 1,
              orgId,
              deviceId,
              inputs: { serviceName: trimmedServiceName },
              sourceKind: source.kind,
              sourceId: source.id,
              clientIdempotencyKey,
            }),
          }),
          errorFallback: t('delegate.failed'),
          successMessage: t('delegate.queued'),
        });
        setOpen(false);
        await navigateTo(`/operator/tasks/${result.taskId}`);
      } catch (err) {
        if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
        if (!(err instanceof ActionError)) {
          showToast({ type: 'error', message: t('delegate.failed') });
        }
        // non-401 ActionError was already toasted by runAction — don't double-toast
      } finally {
        setSubmitting(false);
      }
    })();
  }, [trimmedServiceName, orgId, deviceId, source, t]);

  return (
    <>
      <button
        type="button"
        data-testid="delegate-to-operator"
        onClick={handleOpen}
        className={className ?? 'inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors'}
      >
        <Bot className="h-4 w-4" aria-hidden="true" />
        {t('delegate.button')}
      </button>

      <ConfirmDialog
        open={open}
        onClose={handleClose}
        onConfirm={handleConfirm}
        title={t('delegate.dialogTitle')}
        message={t('delegate.dialogMessage')}
        confirmLabel={t('delegate.confirmLabel')}
        variant="warning"
        isLoading={submitting}
        confirmDisabled={trimmedServiceName.length === 0}
        confirmTestId="delegate-to-operator-confirm"
      >
        <div className="space-y-3">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            {orgLabel !== undefined && (
              <div>
                <dt className="text-xs uppercase text-muted-foreground">{t('delegate.orgLabel')}</dt>
                <dd>{orgLabel}</dd>
              </div>
            )}
            <div>
              <dt className="text-xs uppercase text-muted-foreground">{t('delegate.deviceLabel')}</dt>
              <dd>{deviceLabel}</dd>
            </div>
          </dl>

          <div className="space-y-1">
            <label htmlFor="delegate-to-operator-service-input" className="text-sm font-medium text-foreground">
              {t('delegate.serviceNameLabel')}
            </label>
            <input
              id="delegate-to-operator-service-input"
              data-testid="delegate-to-operator-service"
              type="text"
              required
              maxLength={SERVICE_NAME_MAX_LENGTH}
              value={serviceName}
              onChange={(e) => setServiceName(e.target.value)}
              onBlur={() => setTouched(true)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              placeholder={t('delegate.serviceNamePlaceholder')}
            />
            {showError && (
              <p data-testid="delegate-to-operator-error" className="text-sm text-destructive">
                {t('delegate.serviceNameError')}
              </p>
            )}
          </div>

          <p className="text-sm text-muted-foreground">
            {t('delegate.workflowLabel')}: {t('delegate.workflowName')}
          </p>
        </div>
      </ConfirmDialog>
    </>
  );
}

export default DelegateToOperatorButton;
