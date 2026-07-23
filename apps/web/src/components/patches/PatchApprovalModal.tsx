import { useEffect, useMemo, useState } from 'react';
import { CheckCircle, XCircle, Clock, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { Patch } from './PatchList';
import { Dialog } from '../shared/Dialog';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, ActionError } from '@/lib/runAction';
import { getJwtClaims } from '../../lib/authScope';

export type PatchApprovalAction = 'approve' | 'decline' | 'defer';

type PatchApprovalModalProps = {
  open: boolean;
  patch?: Patch | null;
  ringId?: string | null;
  /** Name of the organization this patch approval applies to, for the confirm message. */
  orgName?: string | null;
  /** Number of devices in the target ring/scope, for the confirm message. */
  ringDeviceCount?: number | null;
  onClose: () => void;
  onSubmit?: (patchId: string, action: PatchApprovalAction, notes: string) => void | Promise<void>;
  loading?: boolean;
};

const actionConfig: Record<PatchApprovalAction, { labelKey: string; descriptionKey: string; color: string; icon: typeof CheckCircle }> = {
  approve: {
    labelKey: 'patchApprovalModal.actions.approve.label',
    descriptionKey: 'patchApprovalModal.actions.approve.description',
    color: 'border-success/30 bg-success/10 text-success',
    icon: CheckCircle
  },
  decline: {
    labelKey: 'patchApprovalModal.actions.decline.label',
    descriptionKey: 'patchApprovalModal.actions.decline.description',
    color: 'border-destructive/30 bg-destructive/10 text-destructive',
    icon: XCircle
  },
  defer: {
    labelKey: 'patchApprovalModal.actions.defer.label',
    descriptionKey: 'patchApprovalModal.actions.defer.description',
    color: 'border-warning/30 bg-warning/10 text-warning',
    icon: Clock
  }
};

function getDefaultDeferUntil(): string {
  const date = new Date();
  date.setDate(date.getDate() + 7);
  date.setHours(9, 0, 0, 0);
  return date.toISOString().slice(0, 16);
}

export default function PatchApprovalModal({
  open,
  patch,
  ringId,
  orgName,
  ringDeviceCount,
  onClose,
  onSubmit,
  loading
}: PatchApprovalModalProps) {
  const { t } = useTranslation('patches');
  const [action, setAction] = useState<PatchApprovalAction>('approve');
  const [notes, setNotes] = useState('');
  const [deferUntil, setDeferUntil] = useState(getDefaultDeferUntil());
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const [approveConfirmOpen, setApproveConfirmOpen] = useState(false);

  useEffect(() => {
    if (open) {
      setAction('approve');
      setNotes('');
      setDeferUntil(getDefaultDeferUntil());
      setSubmitting(false);
      setSubmitError(undefined);
    }
  }, [open, patch?.id]);

  const isSubmitting = useMemo(() => loading ?? submitting, [loading, submitting]);
  // Approval is partner-scoped. Partner/system users can approve partner-wide
  // (no ring) or ring-scoped (ring selected). Org-scoped users cannot approve.
  const isOrgScope = useMemo(() => getJwtClaims().scope === 'organization', []);
  const canSubmit = useMemo(() => {
    if (isSubmitting) return false;
    if (isOrgScope) return false;
    if (action !== 'defer') return true;
    return deferUntil.trim().length > 0;
  }, [action, deferUntil, isSubmitting, isOrgScope]);

  if (!patch) return null;

  const handleSubmit = async () => {
    if (isSubmitting) return;
    // Approval is partner-scoped. Org-scoped users cannot approve — block early
    // before opening the approve confirm dialog.
    const { scope } = getJwtClaims();
    if (scope === 'organization') {
      setSubmitError(t('patchApprovalModal.errors.partnerLevel'));
      return;
    }
    // Gate approve behind a scope-naming confirm dialog.
    if (action === 'approve') {
      setApproveConfirmOpen(true);
      return;
    }
    await doSubmit();
  };

  const doSubmit = async () => {
    if (isSubmitting) return;
    setSubmitting(true);
    setSubmitError(undefined);

    try {
      // Map actions to API endpoints: approve, decline, or defer
      const endpoint = action === 'approve' ? 'approve' : action === 'decline' ? 'decline' : 'defer';
      const body: Record<string, unknown> = { note: notes };
      if (ringId) body.ringId = ringId;
      // Partner-wide (no ring): the API resolves the partner from auth.partnerId.
      // Ring-scoped: the API resolves the org from the ring.
      if (action === 'defer') {
        if (!deferUntil.trim()) {
          throw new Error(t('patchApprovalModal.errors.chooseDeferUntil'));
        }
        body.deferUntil = new Date(deferUntil).toISOString();
      }

      const successMessage =
        action === 'approve'
          ? t('patchApprovalModal.toast.approved')
          : action === 'decline'
            ? t('patchApprovalModal.toast.declined')
            : t('patchApprovalModal.toast.deferred');

      // Surface success/failure via runAction (toast + HTTP-200 {success:false}
      // handling). Keep the inline submitError too so the message stays visible
      // inside the open modal, not just as a transient toast.
      await runAction({
        request: () =>
          fetchWithAuth(`/patches/${patch.id}/${endpoint}`, {
            method: 'POST',
            body: JSON.stringify(body),
          }),
        errorFallback: t('patchApprovalModal.errors.updateFailed'),
        successMessage,
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });

      await onSubmit?.(patch.id, action, notes);
    } catch (err) {
      // 401 already redirected; ActionError was already toasted by runAction —
      // mirror it inline so it's visible in the modal. A pre-request throw (e.g.
      // the defer-date guard) lands here as a plain Error.
      if (err instanceof ActionError && err.status === 401) return;
      setSubmitError(err instanceof Error ? err.message : t('patchApprovalModal.errors.updateFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
    <Dialog open={open} onClose={onClose} title={t('patchApprovalModal.title')} className="p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">{t('patchApprovalModal.title')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{patch.title}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            disabled={isSubmitting}
          >
            {t('patchApprovalModal.close')}
          </button>
        </div>

        <div className="mt-5 space-y-3">
          {(['approve', 'decline', 'defer'] as PatchApprovalAction[]).map(option => {
            const config = actionConfig[option];
            const Icon = config.icon;
            return (
              <button
                key={option}
                type="button"
                onClick={() => setAction(option)}
                disabled={isSubmitting}
                data-testid={`patch-approval-action-${option}`}
                aria-pressed={action === option}
                className={cn(
                  'flex w-full items-start gap-3 rounded-md border px-4 py-3 text-left transition',
                  action === option ? config.color : 'border-muted text-muted-foreground hover:text-foreground',
                  isSubmitting && 'cursor-not-allowed opacity-70'
                )}
              >
                <Icon className="mt-0.5 h-4 w-4" />
                <div>
                  <div className="text-sm font-medium">{t(/* i18n-dynamic */ config.labelKey)}</div>
                  <div className="text-xs text-muted-foreground">{t(/* i18n-dynamic */ config.descriptionKey)}</div>
                </div>
              </button>
            );
          })}
        </div>

        <div className="mt-6">
          <label htmlFor="patch-approval-notes" className="text-sm font-medium">{t('patchApprovalModal.notes.label')}</label>
          <textarea
            id="patch-approval-notes"
            value={notes}
            onChange={event => setNotes(event.target.value)}
            placeholder={t('patchApprovalModal.notes.placeholder')}
            className="mt-2 h-24 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            disabled={isSubmitting}
          />
        </div>

        {action === 'defer' && (
          <div className="mt-6">
            <label htmlFor="patch-defer-until" className="text-sm font-medium">
              {t('patchApprovalModal.deferUntil')}
            </label>
            <input
              id="patch-defer-until"
              type="datetime-local"
              value={deferUntil}
              onChange={(event) => setDeferUntil(event.target.value)}
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              disabled={isSubmitting}
            />
          </div>
        )}

        {isOrgScope && !submitError && (
          <div className="mt-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
            {t('patchApprovalModal.errors.partnerLevel')}
          </div>
        )}

        {submitError && (
          <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {submitError}
          </div>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
            disabled={isSubmitting}
          >
            {t('patchApprovalModal.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            data-testid="patch-approval-submit"
            title={isOrgScope ? t('patchApprovalModal.errors.partnerLevel') : undefined}
            className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="inline-flex items-center gap-2">
              {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {t(/* i18n-dynamic */ actionConfig[action].labelKey)}
            </span>
          </button>
        </div>
    </Dialog>

    <ConfirmDialog
      open={approveConfirmOpen}
      onClose={() => setApproveConfirmOpen(false)}
      onConfirm={() => {
        setApproveConfirmOpen(false);
        void doSubmit();
      }}
      title={t('patchApprovalModal.confirm.title')}
      variant="warning"
      confirmLabel={t('patchApprovalModal.actions.approve.label')}
      confirmTestId="confirm-fleet-action"
      message={t(
        /* i18n-dynamic */ (ringDeviceCount ?? 1) === 1
          ? 'patchApprovalModal.confirm.messageOne'
          : 'patchApprovalModal.confirm.messageMany',
        {
          count: ringDeviceCount ?? 1,
          org: orgName ?? t('patchApprovalModal.confirm.selectedOrganization'),
        }
      )}
    />
    </>
  );
}
