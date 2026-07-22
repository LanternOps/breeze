// The workspace header's identity row for a DRAFT quote: the page title IS the
// editable quote title (seamless h1-styled input, blur-save, same amber/green
// save language as every other field), with the customer selector beside it —
// replacing the editor's former title/customer strip so the once-per-quote
// setup no longer occupies a band above the canvas. Rendered into
// DocumentWorkspace's titleSlot by QuoteWorkspace; non-draft quotes keep the
// plain read-only h1.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../../lib/i18n';
import { fetchWithAuth } from '../../../stores/auth';
import { runAction } from '../../../lib/runAction';
import { useOrgStore } from '../../../stores/orgStore';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { type QuoteDetail as QuoteDetailData } from './quoteTypes';
import { UNAUTHORIZED, SrSaved, fieldRing, seamless, useSavedFlash } from './quoteEditorShared';

interface Props {
  detail: QuoteDetailData;
  onChanged: () => void;
  /** Reports in-flight/dirty state so the workspace can hold Send (merged with
   *  the editor's own savePending). */
  onPendingChange?: (pending: boolean) => void;
}

export function QuoteHeaderMeta({ detail, onChanged, onPendingChange }: Props) {
  const { t } = useTranslation('billing');
  const { quote } = detail;

  // ---- editable title (h1) -------------------------------------------------
  const [title, setTitle] = useState(quote.title ?? '');
  const [titleDirty, setTitleDirty] = useState(false);
  const [titleBusy, setTitleBusy] = useState(false);
  const [titleSaved, flashTitleSaved] = useSavedFlash();
  useEffect(() => { setTitle(quote.title ?? ''); setTitleDirty(false); }, [quote.title]);

  const saveTitle = useCallback(async () => {
    if (!titleDirty) return;
    setTitleBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/quotes/${quote.id}`, {
          method: 'PATCH', body: JSON.stringify({ title: title.trim() || null }),
        }),
        errorFallback: t('quotes.editor.errors.saveTitle'),
        onUnauthorized: UNAUTHORIZED,
      });
      setTitleDirty(false);
      flashTitleSaved();
      onChanged();
    } catch { /* runAction toasted */ } finally {
      setTitleBusy(false);
    }
  }, [titleDirty, title, quote.id, flashTitleSaved, onChanged, t]);

  // ---- customer (organization) reassignment --------------------------------
  const organizations = useOrgStore((s) => s.organizations);
  const orgOptions = useMemo(() => {
    const sorted = [...organizations].sort((a, b) => a.name.localeCompare(b.name));
    if (!sorted.some((o) => o.id === quote.orgId)) {
      sorted.unshift({
        id: quote.orgId,
        name: detail.billTo?.name?.trim() || quote.orgId.slice(0, 8),
      } as (typeof sorted)[number]);
    }
    return sorted;
  }, [organizations, quote.orgId, detail.billTo?.name]);

  const [customerOrgId, setCustomerOrgId] = useState(quote.orgId);
  // The select's `title` is a mouse-hover tooltip — the ONLY way to read a long
  // org name once the select's own max-w-56 clips it. Falls back to the
  // generic help copy only when nothing resolves (shouldn't happen in
  // practice: customerOrgId always defaults to the quote's own org).
  const selectedOrgName = orgOptions.find((o) => o.id === customerOrgId)?.name?.trim();
  const [customerBusy, setCustomerBusy] = useState(false);
  useEffect(() => { setCustomerOrgId(quote.orgId); }, [quote.orgId]);
  // Reassignment clears site + bill-to and re-resolves tax, so a select change
  // stages here and a confirm step commits — a dropdown mis-click must never
  // silently rewrite the quote's tax basis.
  const [pendingCustomer, setPendingCustomer] = useState<{ id: string; name: string } | null>(null);

  const saveCustomer = useCallback((orgId: string) => {
    if (orgId === quote.orgId) return;
    const name = orgOptions.find((o) => o.id === orgId)?.name ?? '';
    setCustomerOrgId(orgId);
    setCustomerBusy(true);
    void (async () => {
      try {
        await runAction({
          request: () => fetchWithAuth(`/quotes/${quote.id}`, {
            method: 'PATCH', body: JSON.stringify({ orgId }),
          }),
          errorFallback: t('quotes.editor.errors.saveCustomer'),
          successMessage: t('quotes.editor.customer.success', { name }),
          onUnauthorized: UNAUTHORIZED,
        });
      } catch {
        // Re-converge on server truth: the client can't know whether the move
        // landed, so snap back and re-pull rather than asserting a rollback.
        setCustomerOrgId(quote.orgId);
      } finally {
        setCustomerBusy(false);
        onChanged();
      }
    })();
  }, [quote.id, quote.orgId, orgOptions, onChanged, t]);

  const pending = titleBusy || titleDirty || customerBusy;
  useEffect(() => { onPendingChange?.(pending); }, [pending, onPendingChange]);
  useEffect(() => () => onPendingChange?.(false), [onPendingChange]);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2" data-testid="quote-header-meta">
      <h1 className="min-w-0 flex-1">
        <input
          type="text"
          value={title}
          maxLength={200}
          placeholder={quote.quoteNumber ?? t('quotes.editor.title.placeholder')}
          aria-label={t('quotes.editor.title.label')}
          onChange={(e) => { setTitle(e.target.value); setTitleDirty(true); }}
          onBlur={() => void saveTitle()}
          disabled={titleBusy}
          data-testid="quote-title"
          className={`w-full rounded-md border bg-transparent px-2 py-0.5 text-xl font-semibold transition-colors focus:outline-hidden disabled:opacity-60 ${seamless(fieldRing(titleDirty, titleSaved))}`}
        />
      </h1>
      <SrSaved show={titleSaved} testId="quote-title-saved" />
      <select
        value={customerOrgId}
        aria-label={t('quotes.editor.customer.label')}
        title={selectedOrgName || t('quotes.editor.customer.help')}
        onChange={(e) => {
          const id = e.target.value;
          if (id === customerOrgId) return;
          setPendingCustomer({ id, name: orgOptions.find((o) => o.id === id)?.name ?? '' });
        }}
        disabled={customerBusy}
        data-testid="quote-customer"
        className="h-8 max-w-56 shrink-0 rounded-md border border-transparent bg-transparent px-2 text-sm text-muted-foreground transition-colors hover:border-border focus:border-border focus:outline-hidden disabled:opacity-60"
      >
        {orgOptions.map((o) => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </select>

      <ConfirmDialog
        open={pendingCustomer !== null}
        onClose={() => setPendingCustomer(null)}
        onConfirm={() => {
          const next = pendingCustomer;
          setPendingCustomer(null);
          if (next) saveCustomer(next.id);
        }}
        variant="warning"
        title={t('quotes.editor.customer.confirmTitle')}
        message={t('quotes.editor.customer.confirmMessage', { name: pendingCustomer?.name ?? '' })}
        confirmLabel={t('quotes.editor.customer.confirmLabel')}
        confirmTestId="quote-customer-confirm"
      />
    </div>
  );
}
