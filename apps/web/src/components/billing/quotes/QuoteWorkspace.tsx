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
import { QuoteHeaderMeta } from './QuoteHeaderMeta';
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
  // The header's editable title/customer (drafts) report their own pending
  // state; Send waits for BOTH surfaces to be quiescent.
  const [headerSavePending, setHeaderSavePending] = useState(false);
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
  // so the editor stays mounted — a full-page spinner would remount the form and
  // discard the user's in-progress local state and cursor position. Only the
  // initial load shows the spinner / replaces the view on error.
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
    return (
      <div className="flex items-center justify-center py-16" data-testid="quote-workspace-loading">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
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
      // Drafts get the editable identity row (title input + customer select) in
      // place of the static h1 — the editor no longer carries a title strip.
      titleSlot={isDraft ? <QuoteHeaderMeta detail={detail} onChanged={() => void reload()} onPendingChange={setHeaderSavePending} /> : undefined}
      statusPill={statusPill}
      // Primary actions live in the header so Send (the money-moment) and Download
      // are reachable from any tab, not buried inside the Detail tab.
      actions={<QuoteActions detail={detail} onChanged={reload} variant="header" savePending={editorSavePending || headerSavePending} onSendWhilePending={flushEditorPendingDeletes} />}
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
          <QuoteEditor detail={detail} onChanged={() => void reload()} onPendingEditsChange={setEditorSavePending} onRegisterPendingDeleteFlush={registerPendingDeleteFlush} />
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
