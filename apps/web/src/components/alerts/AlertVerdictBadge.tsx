import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AlertAiVerdictSummaryDto } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { handleActionError, runAction } from '../../lib/runAction';
import { i18n } from '../../lib/i18n';
import { navigateTo } from '@/lib/navigation';

/**
 * Phase 2 wave P2-1 (alert verdicts), Task 15. The literal `error` string
 * `POST /ai/agents/verdicts/:id/feedback` answers with on 409 — Task 8's
 * `recordVerdictFeedback` 'conflict' branch, wired in
 * `apps/api/src/routes/aiAgents.ts`. No machine `code` accompanies it, so the
 * token itself is what `runAction`'s `friendly` callback matches on to swap
 * the generic feedbackFailed toast for a clearer "already recorded" message.
 */
const FEEDBACK_CONFLICT_ERROR = 'Feedback already recorded by another user';

/**
 * POSTs thumbs up/down for one alert verdict. Exported (rather than folded
 * into a component) so the alert list row (AlertList.tsx), the routed detail
 * page (AlertDetailPage.tsx), and the inline detail modal (AlertDetails.tsx)
 * share one runAction-wrapped implementation instead of each duplicating the
 * fetch — mirrors `decideIntentApproval` in `lib/intentApprovals.ts`.
 *
 * Unlike `decideIntentApproval` (which deliberately OMITS `onUnauthorized`
 * because ITS route's 401 means a rejected WebAuthn assertion, not session
 * expiry — see that function's own docstring), this route
 * (`POST /ai/agents/verdicts/:id/feedback`) is gated only by the standard
 * `requireAiRead` auth middleware, so a 401 here really does mean the
 * session expired. `onUnauthorized` therefore mirrors
 * `AlertDetailPage.tsx`'s `handleAcknowledge`/`handleResolve` exactly: same
 * redirect, no toast on top of the navigation (review fix, P2-1 Task 15).
 */
export async function submitVerdictFeedback(
  verdictId: string,
  feedback: 'up' | 'down',
): Promise<void> {
  await runAction({
    request: () =>
      fetchWithAuth(`/ai/agents/verdicts/${verdictId}/feedback`, {
        method: 'POST',
        body: JSON.stringify({ feedback }),
      }),
    errorFallback: i18n.t('alerts:alertVerdict.feedbackFailed'),
    friendly: (token) =>
      token === FEEDBACK_CONFLICT_ERROR ? i18n.t('alerts:alertVerdict.feedbackTaken') : undefined,
    successMessage: i18n.t('alerts:alertVerdict.feedbackThanks'),
    onUnauthorized: () => void navigateTo('/login', { replace: true }),
  });
}

// Matches the file's severityConfig convention (alertConfig.ts):
// text-{color}-700 / dark:text-{color}-400, bg-{color}-500/10, border-{color}-500/30.
const CLASSIFICATION_STYLES: Record<AlertAiVerdictSummaryDto['classification'], string> = {
  actionable: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  transient_self_healed: 'border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-400',
  recurring_pattern: 'border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-400',
  duplicate_of_group: 'border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-400',
  needs_human: 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400',
};

type AlertVerdictBadgeProps = {
  verdict: AlertAiVerdictSummaryDto;
  onFeedback: (feedback: 'up' | 'down') => Promise<void>;
  compact?: boolean;
};

export default function AlertVerdictBadge({ verdict, onFeedback, compact = false }: AlertVerdictBadgeProps) {
  const { t } = useTranslation('alerts');
  const [submitting, setSubmitting] = useState(false);
  // Seeded from the verdict's own persisted feedback — a page landing on an
  // already-decided verdict must render the SELECTED state immediately, not
  // just after a fresh click in this session.
  //
  // Minor 9 (P2-1 wave B task 16d): a recorded vote no longer locks the
  // buttons. The API's compare-and-swap (`recordVerdictFeedback`'s `WHERE
  // feedback_by IS NULL OR feedback_by = <this user>`) lets the SAME user
  // change their own vote, so both buttons stay enabled after a decision —
  // only an in-flight submission disables them. `decided` still drives the
  // selected (`aria-pressed`) visual.
  const [decided, setDecided] = useState<'up' | 'down' | null>(verdict.feedback);
  const locked = submitting;

  const handleFeedback = async (value: 'up' | 'down') => {
    if (locked) return;
    setSubmitting(true);
    try {
      await onFeedback(value);
      setDecided(value);
    } catch (err) {
      // CLAUDE.md "Web Mutation Handlers" catch pattern: a 401 was already
      // redirected (submitVerdictFeedback's onUnauthorized) with no toast on
      // top of the navigation; any other ActionError was already toasted by
      // runAction inside submitVerdictFeedback; anything else (a non-runAction
      // onFeedback implementation) gets a fallback toast so a failure is
      // never silent. Buttons just re-enable either way so the user can retry.
      handleActionError(err, t('alertVerdict.feedbackFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const buttonStyle = (value: 'up' | 'down') => {
    if (decided === value) return 'text-primary';
    if (locked) return 'opacity-40';
    return 'hover:bg-black/10 dark:hover:bg-white/10';
  };

  return (
    <span
      data-testid="alert-verdict-badge"
      title={verdict.rationale}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border font-medium',
        compact ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs',
        CLASSIFICATION_STYLES[verdict.classification]
      )}
    >
      <span>{t(/* i18n-dynamic */ `alertVerdict.label.${verdict.classification}`)}</span>
      <span className="opacity-75">
        {t('alertVerdict.confidence', { pct: Math.round(verdict.confidence * 100) })}
      </span>
      <span className="flex items-center gap-0.5">
        <button
          type="button"
          data-testid="alert-verdict-feedback-up"
          aria-label={t('alertVerdict.feedbackUp')}
          aria-pressed={decided === 'up'}
          disabled={locked}
          onClick={(e) => {
            e.stopPropagation();
            void handleFeedback('up');
          }}
          className={cn('rounded p-0.5 transition disabled:cursor-not-allowed', buttonStyle('up'))}
        >
          <ThumbsUp className="h-3 w-3" />
        </button>
        <button
          type="button"
          data-testid="alert-verdict-feedback-down"
          aria-label={t('alertVerdict.feedbackDown')}
          aria-pressed={decided === 'down'}
          disabled={locked}
          onClick={(e) => {
            e.stopPropagation();
            void handleFeedback('down');
          }}
          className={cn('rounded p-0.5 transition disabled:cursor-not-allowed', buttonStyle('down'))}
        >
          <ThumbsDown className="h-3 w-3" />
        </button>
      </span>
    </span>
  );
}
