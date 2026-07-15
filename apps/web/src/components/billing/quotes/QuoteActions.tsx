import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../../lib/i18n';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError } from '../../../lib/runAction';
import { usePermissions } from '../../../lib/permissions';
import { useOrgStore } from '../../../stores/orgStore';
import { cloneQuote, deleteQuote, sendQuote } from '../../../lib/api/quotes';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { useQuotePdfDownload } from './useQuoteImage';
import { type QuoteDetail as QuoteDetailData, formatMoney } from './quoteTypes';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

interface Props {
  detail: QuoteDetailData;
  onChanged?: () => void;
  /**
   * 'rail' — the stacked, full-width treatment inside the Detail summary column.
   * 'header' — the compact, inline treatment in the workspace header so the
   * primary money-action (Send) is reachable from any tab, not buried in Detail.
   * The two never render at once: the workspace passes `actionsInHeader` to
   * QuoteDetail, which suppresses its rail copy when the header owns the actions.
   */
  variant: 'rail' | 'header';
  /** True while the editor still has an in-flight save or a dirty field. Send is
   *  held (with a "Saving changes…" hint) until the quote is quiescent, so the
   *  confirm dialog can't quote a stale total or race a blur-save server-side. */
  savePending?: boolean;
}

/**
 * The quote's primary actions — Send proposal (the irreversible money-moment),
 * Download PDF, Delete draft — with their confirm dialogs. Single source so the
 * Detail rail and the workspace header can't drift in behavior or copy; the
 * data-testids are stable across both variants.
 */
export default function QuoteActions({ detail, onChanged, variant, savePending = false }: Props) {
  const { t } = useTranslation('billing');
  const { can } = usePermissions();
  const organizations = useOrgStore((s) => s.organizations);
  const { quote, blocks, lines } = detail;
  const currency = quote.currencyCode;

  const { busy, downloadPdf } = useQuotePdfDownload(quote);
  const [sending, setSending] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [delOpen, setDelOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [cloning, setCloning] = useState(false);
  const refresh = useCallback(() => onChanged?.(), [onChanged]);

  // An empty quote (no blocks, no lines) can't be sent.
  const isEmpty = blocks.length === 0 && lines.length === 0;
  const isDraft = quote.status === 'draft';

  const orgName = useMemo(() => {
    const billTo = quote.billToName?.trim();
    if (billTo) return billTo;
    const resolved = organizations.find((o) => o.id === quote.orgId)?.name?.trim();
    return resolved || quote.orgId.slice(0, 8);
  }, [quote.billToName, quote.orgId, organizations]);

  const send = useCallback(async () => {
    if (sending) return;
    setSending(true);
    try {
      await runAction({
        request: () => sendQuote(quote.id),
        errorFallback: t('quotes.actions.sendError'),
        // Tell the seller what happens next: the quote advances to Viewed and
        // Accepted on its own as the customer engages — no further action here.
        successMessage: t('quotes.actions.sendSuccess', { orgName }),
        onUnauthorized: UNAUTHORIZED,
      });
      setSendOpen(false);
      refresh();
    } catch (err) {
      handleActionError(err, t('quotes.actions.sendError'));
    } finally {
      setSending(false);
    }
  }, [sending, quote.id, orgName, refresh, t]);

  const remove = useCallback(async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await runAction({
        request: () => deleteQuote(quote.id),
        errorFallback: t('quotes.actions.deleteError'),
        successMessage: t('quotes.actions.deleteSuccess'),
        onUnauthorized: UNAUTHORIZED,
      });
      setDelOpen(false);
      void navigateTo('/billing/quotes');
    } catch (err) {
      handleActionError(err, t('quotes.actions.deleteError'));
    } finally {
      setDeleting(false);
    }
  }, [deleting, quote.id, t]);

  const clone = useCallback(async () => {
    if (cloning || savePending) return;
    setCloning(true);
    try {
      const result = await runAction<{ data: { id: string } }>({
        request: () => cloneQuote(quote.id),
        errorFallback: t('quotes.actions.cloneError'),
        successMessage: t('quotes.actions.cloneSuccess'),
        onUnauthorized: UNAUTHORIZED,
      });
      if (result?.data?.id) void navigateTo(`/billing/quotes/${result.data.id}`);
    } catch (err) {
      handleActionError(err, t('quotes.actions.cloneError'));
    } finally {
      setCloning(false);
    }
  }, [cloning, quote.id, savePending, t]);

  const header = variant === 'header';
  // Rail buttons stretch full-width and stack; header buttons size to content and
  // sit in a row. The class fragments below are the only thing the variant changes.
  const layout = header ? 'flex flex-wrap items-center gap-2' : 'space-y-2';
  const btnBase = header
    ? 'inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium'
    : 'inline-flex w-full items-center justify-center rounded-md px-4 py-2 text-sm font-medium';

  const canSend = can('quotes', 'send') && isDraft;
  const canClone = can('quotes', 'write');
  const canDelete = can('quotes', 'write') && isDraft;

  // Nothing to show (e.g. a viewer on an issued quote) — render no empty container.
  if (!canSend && !can('quotes', 'read') && !canClone && !canDelete) return null;

  return (
    <>
      <div className={layout} data-testid={`quote-actions-${variant}`}>
        {/* Send a draft proposal: issues a number, emails the customer's billing
            contact with the PDF + a public accept link, and flips draft→sent.
            Gated on quotes:send; only a draft can be sent. An empty quote can't. */}
        {canSend && (
          <button
            type="button"
            onClick={() => setSendOpen(true)}
            disabled={sending || isEmpty || savePending}
            // Tie the disabled button to the visible hint below (rendered in both
            // variants) so AT announces the reason when the button takes focus.
            aria-describedby={
              isEmpty ? `quote-send-empty-hint-${variant}`
                : savePending ? `quote-send-saving-hint-${variant}`
                : undefined
            }
            title={
              isEmpty ? t('quotes.actions.emptyHint')
                : savePending ? t('quotes.actions.savingTitle')
                : undefined
            }
            data-testid="quote-send"
            className={`${btnBase} bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50`}
          >
            {sending ? t('quotes.actions.sending') : savePending ? t('common:states.saving') : t('quotes.actions.sendProposal')}
          </button>
        )}
        {canClone && (
          <button
            type="button"
            onClick={() => void clone()}
            disabled={cloning || savePending}
            title={savePending ? t('quotes.actions.cloneSavingTitle') : undefined}
            data-testid="quote-clone"
            className={`${btnBase} border hover:bg-muted disabled:opacity-50`}
          >
            {cloning ? t('quotes.actions.cloning') : t('quotes.actions.cloneQuote')}
          </button>
        )}
        {/* PDF download is a read affordance (quotes has no dedicated export
            permission), so it's gated on quotes:read. */}
        {can('quotes', 'read') && (
          <button
            type="button"
            onClick={() => void downloadPdf()}
            disabled={busy}
            data-testid="quote-download-pdf"
            className={`${btnBase} border hover:bg-muted disabled:opacity-50`}
          >
            {t('quotes.actions.downloadPdf')}
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            onClick={() => setDelOpen(true)}
            data-testid="quote-delete-open"
            className={`${btnBase} border border-destructive/40 text-destructive hover:bg-destructive/10`}
          >
            {t('quotes.actions.deleteDraft')}
          </button>
        )}
        {canSend && isEmpty && (
          // Visible in BOTH variants — a sighted keyboard user (or anyone not
          // hovering for the title tooltip) needs to see WHY the highest-stakes
          // button is disabled. Rendered LAST so in the header row it takes a
          // full-width basis and wraps onto its own line BELOW the whole action
          // cluster (never inline between buttons, which would drag the cluster
          // into the page centre), right-aligned under the right-aligned buttons.
          <p
            id={`quote-send-empty-hint-${variant}`}
            data-testid="quote-send-empty-hint"
            className={header ? 'basis-full text-xs text-muted-foreground text-right' : 'text-center text-xs text-muted-foreground'}
          >
            {t('quotes.actions.emptyHint')}
          </p>
        )}
        {canSend && !isEmpty && savePending && (
          // Same placement rules as the empty-quote hint above: the user must be
          // able to SEE why the money-button is held, not just hover for it.
          <p
            id={`quote-send-saving-hint-${variant}`}
            data-testid="quote-send-saving-hint"
            className={header ? 'basis-full text-xs text-muted-foreground text-right' : 'text-center text-xs text-muted-foreground'}
          >
            {t('quotes.actions.savingHint')}
          </p>
        )}
      </div>

      <ConfirmDialog
        open={sendOpen}
        onClose={() => setSendOpen(false)}
        onConfirm={() => void send()}
        isLoading={sending}
        variant="warning"
        title={t('quotes.actions.sendConfirm.title')}
        message={t('quotes.actions.sendConfirm.message', {
          orgName,
          amount: formatMoney(quote.dueOnAcceptanceTotal ?? quote.oneTimeTotal, currency),
        })}
        confirmLabel={t('quotes.actions.sendProposal')}
        confirmTestId="quote-send-confirm"
      />
      <ConfirmDialog
        open={delOpen}
        onClose={() => setDelOpen(false)}
        onConfirm={() => void remove()}
        isLoading={deleting}
        title={t('quotes.actions.deleteConfirm.title')}
        message={t('quotes.actions.deleteConfirm.message')}
        confirmLabel={t('quotes.actions.deleteDraft')}
        confirmTestId="quote-delete-confirm"
      />
    </>
  );
}
