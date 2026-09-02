import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError, ActionError } from '../../../lib/runAction';
import { showToast } from '../../shared/Toast';
import { reviseQuote } from '../../../lib/api/quotes';

/**
 * Create a linked revision draft and open it.
 *
 * Shared by every Revise affordance (the actions menu, the declined banner) so
 * the word means ONE thing everywhere: a draft bound to its parent, whose send
 * retires the original and revokes the customer's link. Before this hook the
 * declined banner's "Revise" button cloned instead, which produced an unlinked
 * quote that left the declined original live — same label, different outcome.
 *
 * The server permits only one open revision per quote and refuses a second with
 * 409 REVISION_IN_PROGRESS + meta.revisionQuoteId. A bare 409 would strand the
 * tech with no route to the draft blocking them, so that case opens the
 * existing revision. An id-less 409 is not actionable and falls through to
 * normal error handling rather than navigating to /billing/quotes/undefined.
 */
export function useReviseQuote(quoteId: string, opts: { onStart?: () => void } = {}) {
  const { t } = useTranslation('billing');
  const [revising, setRevising] = useState(false);
  const { onStart } = opts;

  const revise = useCallback(async () => {
    if (revising) return;
    setRevising(true);
    onStart?.();
    try {
      const result = await runAction<{ data: { id: string } }>({
        request: () => reviseQuote(quoteId),
        errorFallback: t('quotes.actions.reviseError'),
        successMessage: t('quotes.actions.reviseSuccess'),
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      if (result?.data?.id) void navigateTo(`/billing/quotes/${result.data.id}`);
    } catch (err) {
      const existingId = err instanceof ActionError && err.status === 409 && err.code === 'REVISION_IN_PROGRESS'
        ? (err.body as { meta?: { revisionQuoteId?: string } } | undefined)?.meta?.revisionQuoteId
        : undefined;
      if (existingId) {
        showToast({ message: t('quotes.actions.reviseInProgress'), type: 'warning' });
        void navigateTo(`/billing/quotes/${existingId}`);
      } else {
        handleActionError(err, t('quotes.actions.reviseError'));
      }
    } finally {
      setRevising(false);
    }
  }, [revising, quoteId, onStart, t]);

  return { revise, revising };
}

/** Statuses the server will supersede (SUPERSEDABLE in services/quoteLifecycle.ts).
 *  A draft has nothing to replace; accepted/converted are settled outcomes with
 *  an invoice or contract behind them; superseded is already retired. */
export const REVISABLE_STATUSES = ['sent', 'viewed', 'declined', 'expired'] as const;

export function isRevisable(status: string): boolean {
  return (REVISABLE_STATUSES as readonly string[]).includes(status);
}
