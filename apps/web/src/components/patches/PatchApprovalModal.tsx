import { useEffect, useMemo, useState } from 'react';
import { CheckCircle, XCircle, Clock, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Patch } from './PatchList';

export type PatchApprovalAction = 'approve' | 'decline' | 'defer';

type PatchApprovalModalProps = {
  open: boolean;
  patch?: Patch | null;
  onClose: () => void;
  onSubmit?: (patchId: string, action: PatchApprovalAction, notes: string) => void | Promise<void>;
  loading?: boolean;
};

const actionConfig: Record<PatchApprovalAction, { label: string; description: string; color: string; icon: typeof CheckCircle }> = {
  approve: {
    label: 'Approve',
    description: 'Allow this patch to be deployed automatically or in the next maintenance window.',
    color: 'border-green-500/40 bg-green-500/10 text-green-700',
    icon: CheckCircle
  },
  decline: {
    label: 'Decline',
    description: 'Block this patch from deploying until it is reviewed again.',
    color: 'border-red-500/40 bg-red-500/10 text-red-700',
    icon: XCircle
  },
  defer: {
    label: 'Defer',
    description: 'Postpone the decision and revisit later.',
    color: 'border-yellow-500/40 bg-yellow-500/10 text-yellow-700',
    icon: Clock
  }
};

export default function PatchApprovalModal({
  open,
  patch,
  onClose,
  onSubmit,
  loading
}: PatchApprovalModalProps) {
  const [action, setAction] = useState<PatchApprovalAction>('approve');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();

  useEffect(() => {
    if (open) {
      setAction('approve');
      setNotes('');
      setSubmitting(false);
      setSubmitError(undefined);
    }
  }, [open, patch?.id]);

  const isSubmitting = useMemo(() => loading ?? submitting, [loading, submitting]);

  if (!open || !patch) return null;

  const handleSubmit = async () => {
    if (isSubmitting) return;
    setSubmitting(true);
    setSubmitError(undefined);

    try {
      const endpoint = action === 'approve' ? 'approve' : 'reject';
      const response = await fetch(`/api/patches/${patch.id}/${endpoint}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          note: notes,
          action: action === 'defer' ? 'defer' : undefined
        })
      });

      if (!response.ok) {
        throw new Error('Failed to update patch approval');
      }

      await onSubmit?.(patch.id, action, notes);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to update patch approval');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-sm">
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
            disabled={isSubmitting}
            className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            <span className="inline-flex items-center gap-2">
              {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {actionConfig[action].label}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
