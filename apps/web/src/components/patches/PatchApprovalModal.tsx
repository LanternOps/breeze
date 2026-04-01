import { useEffect, useMemo, useState } from 'react';
import { CheckCircle, XCircle, Clock, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Patch } from './PatchList';
import { Dialog } from '../shared/Dialog';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';

export type PatchApprovalAction = 'approve' | 'decline' | 'defer';

type PatchApprovalModalProps = {
  open: boolean;
  patch?: Patch | null;
  ringId?: string | null;
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
  onClose,
  onSubmit,
  loading
}: PatchApprovalModalProps) {
  const [action, setAction] = useState<PatchApprovalAction>('approve');
  const [notes, setNotes] = useState('');
  const [deferUntil, setDeferUntil] = useState(getDefaultDeferUntil());
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();

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
  const canSubmit = useMemo(() => {
    if (isSubmitting) return false;
    if (action !== 'defer') return true;
    return deferUntil.trim().length > 0;
  }, [action, deferUntil, isSubmitting]);

  if (!patch) return null;

  const handleSubmit = async () => {
    if (isSubmitting) return;
    setSubmitting(true);
    setSubmitError(undefined);

    try {
      // Map actions to API endpoints: approve, decline, or defer
      const endpoint = action === 'approve' ? 'approve' : action === 'decline' ? 'decline' : 'defer';
      const body: Record<string, unknown> = { note: notes };
      if (ringId) body.ringId = ringId;
      if (action === 'defer') {
        if (!deferUntil.trim()) {
          throw new Error('Choose when the patch should be deferred until');
        }
        body.deferUntil = new Date(deferUntil).toISOString();
      }

      const response = await fetchWithAuth(`/patches/${patch.id}/${endpoint}`, {
        method: 'POST',
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        const errorBody = await response.json().catch(() => ({})) as { error?: string; message?: string };
        throw new Error(errorBody.error || errorBody.message || 'Failed to update patch approval');
      }

      await onSubmit?.(patch.id, action, notes);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to update patch approval');
    } finally {
      setSubmitting(false);
    }
  };

  return (
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
            className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            <span className="inline-flex items-center gap-2">
              {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {actionConfig[action].label}
            </span>
          </button>
        </div>
    </Dialog>
  );
}
