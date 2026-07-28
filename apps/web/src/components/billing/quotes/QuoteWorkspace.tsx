import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../../lib/i18n';
import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { DocumentWorkspace, type DocumentTab } from '../shared/DocumentWorkspace';
import { StatusPill } from '../shared/StatusPill';
import QuoteEditor from './QuoteEditor';
import QuoteDetail from './QuoteDetail';
import QuoteDocumentPreview from './QuoteDocument';
import QuoteActions, { QuoteSendOutcomeBanners } from './QuoteActions';
import { QuoteCustomerSwitcher, QuoteHeaderMeta } from './QuoteHeaderMeta';
import { MarginToggle } from '../billingUi';
import { useShowInternalMargin } from './quoteEditorShared';
import { useOrgStore } from '../../../stores/orgStore';
import { STATUS_ROLES, type QuoteDetail as QuoteDetailData, resolveQuoteOrgName } from './quoteTypes';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

type Tab = 'editor' | 'preview' | 'detail';

const TAB_LABELS: { value: Tab; labelKey: string }[] = [
  { value: 'editor', labelKey: 'quotes.workspace.tabs.editor' },
  { value: 'preview', labelKey: 'quotes.workspace.tabs.preview' },
  { value: 'detail', labelKey: 'quotes.workspace.tabs.detail' },
];

interface Props {
  id?: string;
}

function readTab(isDraft: boolean): Tab {
  if (typeof window === 'undefined') return isDraft ? 'editor' : 'detail';
  const raw = window.location.hash.replace(/^#/, '');
  if (TAB_LABELS.some((t) => t.value === raw)) return raw as Tab;
  return isDraft ? 'editor' : 'detail';
}

export default function QuoteWorkspace({ id }: Props) {
  const { t } = useTranslation('billing');
  const organizations = useOrgStore((s) => s.organizations);
  const [detail, setDetail] = useState<QuoteDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<Tab>('editor');
  // True while the editor has an in-flight save or a dirty rail field — the
  // header Send button waits for quiescence so it can't race a blur-save.
  const [editorSavePending, setEditorSavePending] = useState(false);
  // The header's editable title and the customer switcher (drafts) each report
  // their own pending state; Send waits for ALL surfaces to be quiescent.
  const [titleSavePending, setTitleSavePending] = useState(false);
  const [customerSavePending, setCustomerSavePending] = useState(false);
  // Monotonic count of editor save FAILURES, and the label of a field left
  // dirty by one. A failed save still produces "quiescence", so Send needs both
  // to tell "on its way" from "gave up" (mirrors InvoiceWorkspace).
  const [saveFailureNonce, setSaveFailureNonce] = useState(0);
  const reportSaveFailure = useCallback(() => setSaveFailureNonce((n) => n + 1), []);
  const [editorUnsavedField, setEditorUnsavedField] = useState<string | null>(null);
  const [titleUnsavedField, setTitleUnsavedField] = useState<string | null>(null);
  // Cost/margin visibility is workspace state so the toggle can live in the
  // pinned header (next to Send) while the editor's internal surfaces consume it.
  const [showInternal, toggleShowInternal] = useShowInternalMargin();
  // Bridge between the editor's deferred deletions (undo grace window) and the
  // header's Send: the editor registers a "flush now" hook, and QuoteActions
  // calls it when Send is clicked while edits are pending — so a held Send
  // fires as soon as the deferred DELETE lands instead of waiting out the
  // remainder of the undo window.
  const pendingDeleteFlushRef = useRef<(() => void) | null>(null);
  const registerPendingDeleteFlush = useCallback((flush: (() => void) | null) => {
    pendingDeleteFlushRef.current = flush;
  }, []);
  const flushEditorPendingDeletes = useCallback(() => {
    pendingDeleteFlushRef.current?.();
  }, []);

  // A `quiet` reload (after an inline edit) refetches without flipping `loading`,
  // so the editor stays mounted — a full-page loading state would remount the
  // form and discard the user's in-progress local state and cursor position.
  // Only the initial load shows the skeleton / replaces the view on error.
  const fetchDetail = useCallback(async (quiet = false) => {
    if (!id) { setError(t('quotes.workspace.errors.missingId')); setLoading(false); return; }
    try {
      if (!quiet) setLoading(true);
      setError(undefined);
      const res = await fetchWithAuth(`/quotes/${id}`);
      if (res.status === 401) return UNAUTHORIZED();
      if (res.status === 404) { if (!quiet) setError(t('quotes.workspace.errors.notFound')); return; }
      if (!res.ok) throw new Error(t('quotes.workspace.errors.loadFailed'));
      const body = (await res.json()) as { data: QuoteDetailData };
      setDetail(body.data);
    } catch (err) {
      // A failed quiet reload leaves the editor intact; the inline action's own
      // runAction toast already surfaced the failure.
      if (!quiet) setError(err instanceof Error ? err.message : t('quotes.workspace.errors.loadFailed'));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [id, t]);

  const load = useCallback(() => fetchDetail(false), [fetchDetail]);
  const reload = useCallback(() => fetchDetail(true), [fetchDetail]);

  useEffect(() => { void load(); }, [load]);

  // Initialise the active tab from the hash once we know whether it's a draft.
  const isDraft = detail?.quote.status === 'draft';
  useEffect(() => {
    if (!detail) return;
    setTab(readTab(detail.quote.status === 'draft'));
  }, [detail]);

  // React to back/forward hash changes.
  useEffect(() => {
    const onHash = () => setTab(readTab(detail?.quote.status === 'draft'));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [detail]);

  const selectTab = useCallback((next: string) => {
    setTab(next as Tab);
    if (typeof window !== 'undefined') window.location.hash = `#${next}`;
  }, []);

  if (loading) {
    // Skeleton, not a spinner: sketches the workspace shape (back link, title
    // row + actions, tabs, canvas + rail) so the load reads as the page
    // assembling rather than a blank wait. aria-busy + the sr-only status give
    // AT users the same signal.
    return (
      <div aria-busy="true" data-testid="quote-workspace-loading">
        <span role="status" className="sr-only">{t('quotes.workspace.loading')}</span>
        <div className="animate-pulse" aria-hidden="true">
          <div className="h-3 w-16 rounded bg-muted" />
          <div className="mt-2 flex items-center justify-between gap-3">
            <div className="h-7 w-72 max-w-[50%] rounded bg-muted" />
            <div className="flex gap-2">
              <div className="h-9 w-28 rounded-md bg-muted" />
              <div className="h-9 w-28 rounded-md bg-muted" />
            </div>
          </div>
          <div className="mt-5 flex gap-4 border-b pb-2">
            <div className="h-4 w-14 rounded bg-muted" />
            <div className="h-4 w-14 rounded bg-muted" />
            <div className="h-4 w-14 rounded bg-muted" />
          </div>
          <div className="mt-6 flex gap-6">
            <div className="min-w-0 flex-1 space-y-4">
              <div className="h-40 rounded-lg border bg-muted/40" />
              <div className="h-40 rounded-lg border bg-muted/40" />
            </div>
            <div className="hidden w-72 shrink-0 space-y-4 lg:block">
              <div className="h-56 rounded-lg border bg-muted/40" />
              <div className="h-24 rounded-lg border bg-muted/40" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center text-sm text-destructive" data-testid="quote-workspace-error">
        {error ?? t('quotes.workspace.errors.unavailable')}
        <div>
          <a href="/billing/quotes" className="mt-3 inline-block rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted">
            {t('quotes.workspace.backToQuotes')}
          </a>
        </div>
      </div>
    );
  }

  // The Editor only applies to drafts, so it's hidden once a quote is issued —
  // no dead-end tab that just shows a "can't edit" message. A stale #editor hash
  // on a non-draft falls back to Detail.
  const tabs: DocumentTab[] = TAB_LABELS.map((tabDef) => ({
    id: tabDef.value,
    label: t(/* i18n-dynamic */ tabDef.labelKey),
    hidden: tabDef.value === 'editor' && !isDraft,
  }));
  const activeTab: Tab = tabs.some((t) => t.id === tab && !t.hidden) ? tab : 'detail';

  // Status was previously visible only on the Preview/Details tabs — a tech
  // sitting in the Editor (the default landing tab for a draft) had no cue at
  // all. Reuses the same StatusPill + STATUS_ROLES vocabulary as
  // QuotesPage/QuoteDetail/QuoteDocument; display only, no new writes.
  const statusRoles = STATUS_ROLES[detail.quote.status];
  const statusPill = (
    <StatusPill
      role={statusRoles.role}
      label={t(/* i18n-dynamic */ `quotes.status.${detail.quote.status}`)}
      className={statusRoles.className ? `${statusRoles.className} shrink-0` : 'shrink-0'}
      testId="quote-workspace-status"
    />
  );

  return (
    <DocumentWorkspace
      idPrefix="quote"
      backHref="/billing/quotes"
      backLabel={t('quotes.workspace.backLabel')}
      title={detail.quote.title?.trim() || detail.quote.quoteNumber || t('quotes.workspace.draftTitle')}
      // Drafts get the editable title in place of the static h1, with the
      // customer switcher on its own meta line below — inline next to the title
      // it squeezed the h1 and floated mis-aligned against the status pill.
      titleSlot={isDraft ? <QuoteHeaderMeta detail={detail} onChanged={() => void reload()} onPendingChange={setTitleSavePending} onUnsavedChange={setTitleUnsavedField} onSaveFailure={reportSaveFailure} /> : undefined}
      metaSlot={isDraft ? <QuoteCustomerSwitcher detail={detail} onChanged={() => void reload()} onPendingChange={setCustomerSavePending} /> : undefined}
      statusPill={statusPill}
      // Primary actions live in the header so Send (the money-moment) and Download
      // are reachable from any tab, not buried inside the Detail tab. The
      // cost/margin toggle joins them while the Editor tab is up, so the
      // "no margin on screen" control is available without scrolling.
      actions={
        <>
          {isDraft && activeTab === 'editor' && (
            <MarginToggle show={showInternal} onToggle={toggleShowInternal} testId="quote-editor-toggle-internal" size="md" />
          )}
          <QuoteActions detail={detail} onChanged={reload} variant="header" savePending={editorSavePending || titleSavePending || customerSavePending} unsavedFieldLabel={editorUnsavedField ?? titleUnsavedField} saveFailureNonce={saveFailureNonce} onSendWhilePending={flushEditorPendingDeletes} />
        </>
      }
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={selectTab}
    >
      {/* Send-outcome banner on the non-detail tabs: drafts open on the
          Editor tab, so a failed scheduled send surfaced only inside
          QuoteDetail would be invisible on the default path. The detail tab
          renders its own copy (QuoteDetail is also used standalone). */}
      {activeTab !== 'detail' && (
        <div className="mb-4">
          <QuoteSendOutcomeBanners
            quote={detail.quote}
            orgName={resolveQuoteOrgName(detail.quote, organizations)}
          />
        </div>
      )}
      {/* The editor stays MOUNTED across tab switches (hidden, not unmounted):
          unmounting discarded any half-typed add-line/add-section input the
          moment a tech flipped to Preview "just to check" — brutal mid-flow
          data loss. Hidden-but-mounted also keeps the savePending gate live
          while previewing. */}
      {isDraft && (
        <div className={activeTab === 'editor' ? '' : 'hidden'}>
          <QuoteEditor detail={detail} onChanged={() => void reload()} onPendingEditsChange={setEditorSavePending} onSaveFailure={reportSaveFailure} onUnsavedEditsChange={setEditorUnsavedField} onRegisterPendingDeleteFlush={registerPendingDeleteFlush} showInternal={showInternal} onToggleInternal={toggleShowInternal} />
        </div>
      )}
      {activeTab === 'preview' && (
        <QuoteDocumentPreview detail={detail} />
      )}
      {activeTab === 'detail' && (
        <QuoteDetail detail={detail} onChanged={() => void reload()} actionsInHeader />
      )}
    </DocumentWorkspace>
  );
}
