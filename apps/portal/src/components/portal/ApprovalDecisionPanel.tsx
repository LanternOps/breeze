import { useState } from 'react';
import { portalApi, type ApiResponse, type PortalApproval, type PortalApprovalDecisionResult } from '@/lib/api';
import { approvalAskSentence, approvalSnapshotLine } from '@/lib/approvalText';
import { runAction } from '@/lib/runAction';
import { formatDateTime } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT, Notice } from './ui';

export const REQUEST_CHANGED_TEXT = 'This request was updated, please review again';

const ERROR_TEXT_BY_CODE: Record<string, string> = {
  REQUEST_CHANGED: REQUEST_CHANGED_TEXT,
  REQUEST_NOT_PENDING: 'This request has already been decided.',
  REQUEST_EXPIRED: 'This request has expired. Contact your service provider.',
};

/** Codes after which what the customer is looking at is stale: refetch. */
const RELOAD_CODES = new Set(['REQUEST_CHANGED', 'REQUEST_NOT_PENDING', 'REQUEST_EXPIRED']);

/** Status copy for a viewer who cannot decide (notify-only, or already settled). */
function readOnlyText(approval: PortalApproval): string {
  const when = approval.decidedAt ? ` on ${formatDateTime(approval.decidedAt)}` : '';
  switch (approval.status) {
    case 'pending':
      return approval.role === 'notify'
        ? 'Waiting for your billing contact to decide'
        : 'No action is needed from you right now.';
    case 'approved':
      return `This request was approved${when}.`;
    case 'denied':
      return `This request was declined${when}.`;
    case 'expired':
      return 'This request has expired. Contact your service provider.';
    case 'cancelled':
      return 'This request was cancelled.';
  }
}

interface ApprovalDecisionPanelProps {
  approval: PortalApproval;
  /** Refetch the requests. Called after a decision and whenever the request on
   *  screen turned out to be stale. */
  onChanged: () => void | Promise<void>;
}

/**
 * The customer's decision on a work-approval request. It posts the revision it
 * rendered, so if staff edited the request in the meantime the API refuses with
 * REQUEST_CHANGED and the customer re-reads before signing off on something
 * they never saw.
 */
export function ApprovalDecisionPanel({ approval, onChanged }: ApprovalDecisionPanelProps) {
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [decided, setDecided] = useState(false);

  const snapshot = approvalSnapshotLine(approval.snapshot, approval.ask.currencyCode);
  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && !busy;
  const showForm = approval.canDecide && !decided;

  const decide = async (kind: 'approve' | 'deny') => {
    if (!canSubmit) return;
    setBusy(true);
    setMessage(null);
    const trimmedNote = note.trim();
    const body = {
      revision: approval.revision,
      signerName: trimmedName,
      ...(trimmedNote ? { note: trimmedNote } : {}),
    };
    let failure: ApiResponse<unknown> | null = null;
    const result = await runAction<{ data: PortalApprovalDecisionResult }>({
      request: async () => {
        const response =
          kind === 'approve'
            ? await portalApi.approveApproval(approval.id, body)
            : await portalApi.denyApproval(approval.id, body);
        if (response.error || (response.statusCode ?? 200) >= 400) failure = response;
        return response;
      },
      // Failure copy is chosen below from the error code.
      onOutcome: () => {},
      successMessage: '',
      errorFallback: 'We could not record your decision. Please try again.',
    });
    setBusy(false);

    if (result) {
      setDecided(true);
      setMessage({
        text: kind === 'approve' ? 'Thank you. The work is approved.' : 'You declined this request.',
        error: false,
      });
      await onChanged();
      return;
    }

    const failed = failure as ApiResponse<unknown> | null;
    const code = failed?.code;
    setMessage({
      text:
        (code && ERROR_TEXT_BY_CODE[code]) ||
        failed?.error ||
        'We could not record your decision. Please try again.',
      error: true,
    });
    if (code && RELOAD_CODES.has(code)) await onChanged();
  };

  return (
    <section
      className="rounded-xl border bg-card p-5 sm:p-6"
      data-testid="approval-panel"
      aria-label={`Approval request for ticket ${approval.ticketNumber}`}
    >
      <h3 className="text-sm font-semibold text-foreground">{approvalAskSentence(approval)}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{approval.ticketSubject}</p>
      {snapshot && (
        <p className="mt-3 text-sm text-muted-foreground" data-testid="approval-snapshot">
          {snapshot}
        </p>
      )}
      {approval.message && (
        <blockquote
          className="mt-4 whitespace-pre-wrap border-l-2 border-border pl-4 text-sm leading-relaxed text-foreground"
          data-testid="approval-message"
        >
          {approval.message}
        </blockquote>
      )}

      {message && (
        <Notice
          tone={message.error ? 'destructive' : 'success'}
          className="mt-4"
          data-testid="approval-outcome"
        >
          {message.text}
        </Notice>
      )}

      {showForm ? (
        <form
          className="mt-5 space-y-4"
          onSubmit={(e) => e.preventDefault()}
          data-testid="approval-form"
        >
          <div>
            <label htmlFor="approval-signer" className="text-xs font-medium text-foreground">
              Type your full name
            </label>
            <input
              id="approval-signer"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              autoComplete="name"
              placeholder="Your full name"
              className={cn(INPUT)}
            />
          </div>
          <div>
            <label htmlFor="approval-note" className="text-xs font-medium text-foreground">
              Note (optional)
            </label>
            <textarea
              id="approval-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={busy}
              rows={3}
              maxLength={2000}
              className={cn(INPUT)}
            />
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void decide('approve')}
              disabled={!canSubmit}
              className={BTN_PRIMARY}
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => void decide('deny')}
              disabled={!canSubmit}
              className={BTN_SECONDARY}
            >
              Deny
            </button>
          </div>
        </form>
      ) : (
        !decided && (
          <p className="mt-4 text-sm font-medium text-foreground" data-testid="approval-status-text">
            {readOnlyText(approval)}
          </p>
        )
      )}
    </section>
  );
}

export default ApprovalDecisionPanel;
