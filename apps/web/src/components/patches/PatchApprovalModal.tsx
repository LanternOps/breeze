import { useEffect, useMemo, useState } from 'react';
import { CheckCircle, XCircle, Clock, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Patch } from './PatchList';
import { Dialog } from '../shared/Dialog';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { scopeConfirmMessage } from '@/lib/scopeConfirmMessage';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, ActionError } from '@/lib/runAction';

export type PatchApprovalAction = 'approve' | 'decline' | 'defer';

type PatchApprovalModalProps = {
  open: boolean;
  patch?: Patch | null;
  ringId?: string | null;
  /** Current org context (from the org switcher). When absent and no ring is
   * selected, approval has no org to resolve, so the action is blocked. */
  currentOrgId?: string | null;
  /** Name of the organization this patch approval applies to, for the confirm message. */
  orgName?: string | null;
  /** Number of devices in the target ring/scope, for the confirm message. */
  ringDeviceCount?: number | null;
  onClose: () => void;
  onSubmit?: (patchId: string, action: PatchApprovalAction, notes: string) => void | Promise<void>;
  loading?: boolean;
};

const actionConfig: Record<PatchApprovalAction, { label: string; description: string; color: string; icon: typeof CheckCircle }> = {
  approve: {
    label: 'Approve',
    description: 'Allow this patch to be deployed automatically or in the next maintenance window.',
    color: 'border-success/30 bg-success/10 text-success',
    icon: CheckCircle
  },
  decline: {
    label: 'Decline',
    description: 'Block this patch from deploying until it is reviewed again.',
    color: 'border-destructive/30 bg-destructive/10 text-destructive',
    icon: XCircle
  },
  defer: {
    label: 'Defer',
    description: 'Postpone the decision and revisit later.',
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
  currentOrgId,
  orgName,
  ringDeviceCount,
  onClose,
  onSubmit,
  loading
}: PatchApprovalModalProps) {
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
  // Approval needs a target org: either a selected ring (resolves its org
  // server-side) or a specific org selected in the switcher (sent as ?orgId=).
  // In All-orgs mode with no ring there is nothing to attach the decision to, so
  // disable the action up-front with a clear hint rather than letting the click
  // 400 ('orgId is required for partner/system scope').
  const canResolveOrg = useMemo(() => !!ringId || !!currentOrgId, [ringId, currentOrgId]);
  const canSubmit = useMemo(() => {
    if (isSubmitting) return false;
    if (!canResolveOrg) return false;
    if (action !== 'defer') return true;
    return deferUntil.trim().length > 0;
  }, [action, deferUntil, isSubmitting, canResolveOrg]);

  if (!patch) return null;

  const handleSubmit = async () => {
    if (isSubmitting) return;
    // Approval is ring-scoped. With no ring and no current org (a partner on the
    // global /patches view), the API has no org to attach the approval to and
    // returns 400. Block early with a clear prompt — before opening the approve
    // confirm dialog — instead of firing a doomed request.
    if (!ringId && !currentOrgId) {
      setSubmitError(`Select an update ring to ${action} patches`);
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
      // orgId is auto-injected by fetchWithAuth from the selected org (?orgId=)
      // when no ring is selected; the API also resolves it from the ring.
      if (action === 'defer') {
        if (!deferUntil.trim()) {
          throw new Error('Choose when the patch should be deferred until');
        }
        body.deferUntil = new Date(deferUntil).toISOString();
      }

      const successMessage =
        action === 'approve' ? 'Patch approved' : action === 'decline' ? 'Patch declined' : 'Patch deferred';

      // Surface success/failure via runAction (toast + HTTP-200 {success:false}
      // handling). Keep the inline submitError too so the message stays visible
      // inside the open modal, not just as a transient toast.
      await runAction({
        request: () =>
          fetchWithAuth(`/patches/${patch.id}/${endpoint}`, {
            method: 'POST',
            body: JSON.stringify(body),
          }),
        errorFallback: 'Failed to update patch approval',
        successMessage,
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });

      await onSubmit?.(patch.id, action, notes);
    } catch (err) {
      // 401 already redirected; ActionError was already toasted by runAction —
      // mirror it inline so it's visible in the modal. A pre-request throw (e.g.
      // the defer-date guard) lands here as a plain Error.
      if (err instanceof ActionError && err.status === 401) return;
      setSubmitError(err instanceof Error ? err.message : 'Failed to update patch approval');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
    <Dialog open={open} onClose={onClose} title="Review Patch" className="p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Review Patch</h2>
            <p className="mt-1 text-sm text-muted-foreground">{patch.title}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            disabled={isSubmitting}
          >
            Close
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
                className={cn(
                  'flex w-full items-start gap-3 rounded-md border px-4 py-3 text-left transition',
                  action === option ? config.color : 'border-muted text-muted-foreground hover:text-foreground',
                  isSubmitting && 'cursor-not-allowed opacity-70'
                )}
              >
                <Icon className="mt-0.5 h-4 w-4" />
                <div>
                  <div className="text-sm font-medium">{config.label}</div>
                  <div className="text-xs text-muted-foreground">{config.description}</div>
                </div>
              </button>
            );
          })}
        </div>

        <div className="mt-6">
          <label className="text-sm font-medium">Notes</label>
          <textarea
            value={notes}
            onChange={event => setNotes(event.target.value)}
            placeholder="Add context or a reason for the decision..."
            className="mt-2 h-24 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            disabled={isSubmitting}
          />
        </div>

        {action === 'defer' && (
          <div className="mt-6">
            <label htmlFor="patch-defer-until" className="text-sm font-medium">
              Defer Until
            </label>
            <input
              id="patch-defer-until"
              type="datetime-local"
              value={deferUntil}
              onChange={(event) => setDeferUntil(event.target.value)}
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              disabled={isSubmitting}
            />
          </div>
        )}

        {!canResolveOrg && !submitError && (
          <div className="mt-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
            Select an organization (or an update ring) to {action} patches.
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
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            title={!canResolveOrg ? `Select an organization to ${action} patches` : undefined}
            className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="inline-flex items-center gap-2">
              {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {actionConfig[action].label}
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
      title="Confirm patch approval"
      variant="warning"
      confirmLabel="Approve"
      confirmTestId="confirm-fleet-action"
      message={scopeConfirmMessage({
        action: 'Approve patch',
        deviceCount: ringDeviceCount ?? 1,
        orgNames: orgName ? [orgName] : ['the selected organization'],
      })}
    />
    </>
  );
}
