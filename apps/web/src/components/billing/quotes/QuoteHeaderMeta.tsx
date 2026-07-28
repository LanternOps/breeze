// The workspace header's identity chrome for a DRAFT quote, in two pieces:
//
//   QuoteHeaderMeta       — the page title IS the editable quote title
//                           (seamless h1-styled input, blur-save, same
//                           amber/green save language as every other field).
//                           Rendered into DocumentWorkspace's titleSlot.
//   QuoteCustomerSwitcher — the customer (organization) selector, rendered
//                           into DocumentWorkspace's metaSlot on its OWN line
//                           under the title. It used to sit inline between the
//                           title and the status pill, which squeezed the
//                           title and left the select floating mis-aligned in
//                           the header row.
//
// Non-draft quotes keep the plain read-only h1 and no switcher. Each piece
// reports its own pending state; QuoteWorkspace ORs them into the Send gate.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../../lib/i18n';
import { fetchWithAuth } from '../../../stores/auth';
import { runAction } from '../../../lib/runAction';
import { useOrgStore } from '../../../stores/orgStore';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { OrgCombobox, orgComboboxOptions } from '../shared/OrgCombobox';
import { type QuoteDetail as QuoteDetailData } from './quoteTypes';
import { UNAUTHORIZED, SrSaved, fieldRing, seamless, useSavedFlash } from './quoteEditorShared';

interface Props {
  detail: QuoteDetailData;
  onChanged: () => void;
  /** Reports IN-FLIGHT state so the workspace can hold Send (merged with the
   *  editor's own savePending). Deliberately not true for a merely-dirty
   *  field — see the note on the effects below. */
  onPendingChange?: (pending: boolean) => void;
  /** Reports a translated field label when this surface's save FAILED and the
   *  field is still dirty, so Send can name it instead of waiting forever. */
  onUnsavedChange?: (label: string | null) => void;
  /** Reports every save FAILURE (the workspace bumps its failure nonce). A
   *  failed title PATCH still reads as "quiet" once titleBusy clears, so a
   *  queued Send must be canceled by this signal rather than open a composer
   *  carrying a stale title (same contract as QuoteEditor's onSaveFailure). */
  onSaveFailure?: () => void;
}

export function QuoteHeaderMeta({ detail, onChanged, onPendingChange, onUnsavedChange, onSaveFailure }: Props) {
  const { t } = useTranslation('billing');
  const { quote } = detail;

  const [title, setTitle] = useState(quote.title ?? '');
  const [titleDirty, setTitleDirty] = useState(false);
  const [titleBusy, setTitleBusy] = useState(false);
  const [titleFailed, setTitleFailed] = useState(false);
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
      setTitleFailed(false);
      flashTitleSaved();
      onChanged();
    } catch {
      // runAction toasted. The field STAYS dirty (nothing reverted it), so
      // record the failure — reporting dirty as "pending" is what used to pin
      // "Saving changes…" over the Send button for the rest of the session.
      setTitleFailed(true);
      // …and bump the workspace failure nonce: a Send queued behind this save
      // sees only "quiet" when titleBusy clears, and must cancel instead.
      onSaveFailure?.();
    } finally {
      setTitleBusy(false);
    }
  }, [titleDirty, title, quote.id, flashTitleSaved, onChanged, onSaveFailure, t]);

  // Pending means IN FLIGHT only. A dirty title is not a promise of a save: the
  // Send gate still holds from the first keystroke because clicking Send blurs
  // this field first, and that blur-save lands in `titleBusy` before the click
  // handler runs.
  useEffect(() => { onPendingChange?.(titleBusy); }, [titleBusy, onPendingChange]);
  useEffect(() => () => onPendingChange?.(false), [onPendingChange]);
  // Failed AND still dirty — see the same pairing in InvoiceEditor.
  const unsavedLabel = !titleBusy && titleFailed && titleDirty ? t('quotes.editor.title.label') : null;
  useEffect(() => { onUnsavedChange?.(unsavedLabel); }, [unsavedLabel, onUnsavedChange]);
  useEffect(() => () => onUnsavedChange?.(null), [onUnsavedChange]);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2" data-testid="quote-header-meta">
      {/* NOT an <h1> wrapper: "heading level 1, edit text" is a confusing AT
          announcement. DocumentWorkspace renders an sr-only h1 with the
          document identity whenever a titleSlot replaces the visual heading. */}
      <div className="min-w-0 flex-1">
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
      </div>
      <SrSaved show={titleSaved} testId="quote-title-saved" />
    </div>
  );
}

export function QuoteCustomerSwitcher({ detail, onChanged, onPendingChange }: Props) {
  const { t } = useTranslation('billing');
  const { quote } = detail;

  const organizations = useOrgStore((s) => s.organizations);
  const orgOptions = useMemo(
    () => orgComboboxOptions(
      organizations,
      quote.orgId,
      detail.billTo?.name?.trim() || quote.orgId.slice(0, 8),
    ),
    [organizations, quote.orgId, detail.billTo?.name],
  );

  const [customerOrgId, setCustomerOrgId] = useState(quote.orgId);
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

  useEffect(() => { onPendingChange?.(customerBusy); }, [customerBusy, onPendingChange]);
  useEffect(() => () => onPendingChange?.(false), [onPendingChange]);

  return (
    <div className="mt-0.5 flex min-w-0 items-center gap-1" data-testid="quote-header-customer">
      <span className="shrink-0 text-xs text-muted-foreground" aria-hidden="true">
        {t('quotes.editor.customer.label')}:
      </span>
      {/* Typeahead, not a native select: an MSP with 150 orgs needs to search
          for the customer, not scroll an unsearchable browser list. A pick
          only STAGES the change — the warning confirm below commits it. */}
      <OrgCombobox
        options={orgOptions}
        value={customerOrgId}
        onSelect={(id) => {
          if (id === customerOrgId) return;
          setPendingCustomer({ id, name: orgOptions.find((o) => o.id === id)?.name ?? '' });
        }}
        disabled={customerBusy}
        label={t('quotes.editor.customer.label')}
        variant="seamless"
        testId="quote-customer"
      />

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
