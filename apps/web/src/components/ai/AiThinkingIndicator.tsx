import { useEffect, useState } from 'react';
import { Hourglass, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AiApprovalWaitingOn } from '@breeze/shared';
import type { PendingApproval } from '../../stores/processStreamEvent';

/** #10416: a tool call is blocked on a human approval — say so instead of a generic spinner. */
export type AiApprovalWait = { pushedToPhone: boolean; waitingOn: AiApprovalWaitingOn; intentBacked: boolean };

/**
 * The wait an unresolved card describes, or null once it resolves. Every
 * card publisher on the current server sets `waitingOn`; a card without it
 * (an older server) falls back to `'you'`.
 */
export function approvalWaitFromPending(p: PendingApproval | null | undefined): AiApprovalWait | null {
  if (!p || p.resolution) return null;
  return { pushedToPhone: p.pushedToPhone === true, waitingOn: p.waitingOn ?? 'you', intentBacked: p.intentBacked === true };
}

/**
 * W05 (spec §11): never a silent pause while the model reasons. Progress
 * NOTES (thinkingDisplay 'updates') are not carried by the Agent SDK yet
 * (W01 D1), so this shows a state and the elapsed seconds.
 *
 * #10416: while `approvalWait` is set it takes precedence over `thinking` and
 * shows who the turn is waiting on (no spinner, no seconds) instead.
 */
export default function AiThinkingIndicator({ thinking, approvalWait }: { thinking: boolean; approvalWait?: AiApprovalWait | null }) {
  const { t } = useTranslation('ai');
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!thinking) { setSeconds(0); return; }
    const started = Date.now();
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [thinking]);
  if (approvalWait) {
    const copy = approvalWait.waitingOn === 'other_approvers'
      ? t('aiThinking.waitingOthers')
      : approvalWait.pushedToPhone
        ? t('aiThinking.waitingApprovalPhone')
        : t('aiThinking.waitingApproval');
    return (
      <div className="flex items-center gap-2 px-3 py-1 text-xs text-muted-foreground" data-testid="ai-thinking-approval-wait" role="status" aria-live="polite">
        <Hourglass className="h-3 w-3" />
        <span>{copy}</span>
        {approvalWait.intentBacked && (
          <a href="/approvals" className="underline underline-offset-2 hover:text-foreground" data-testid="ai-thinking-open-approvals">
            {t('aiThinking.openApprovals')}
          </a>
        )}
      </div>
    );
  }
  if (!thinking) return null;
  return (
    <div className="flex items-center gap-2 px-3 py-1 text-xs text-muted-foreground" data-testid="ai-thinking-indicator" role="status" aria-live="polite">
      <Loader2 className="h-3 w-3 animate-spin" />
      {t('aiThinking.label', { seconds })}
    </div>
  );
}
