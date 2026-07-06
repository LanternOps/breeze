import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { DocumentWorkspace, type DocumentTab } from '../shared/DocumentWorkspace';
import QuoteEditor from './QuoteEditor';
import QuoteDetail from './QuoteDetail';
import QuoteDocumentPreview from './QuoteDocument';
import QuoteActions from './QuoteActions';
import { type QuoteDetail as QuoteDetailData } from './quoteTypes';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

type Tab = 'editor' | 'preview' | 'detail';

const TAB_LABELS: { value: Tab; label: string }[] = [
  { value: 'editor', label: 'Editor' },
  { value: 'preview', label: 'Preview' },
  { value: 'detail', label: 'Detail' },
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
  const [detail, setDetail] = useState<QuoteDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<Tab>('editor');
  // True while the editor has an in-flight save or a dirty rail field — the
  // header Send button waits for quiescence so it can't race a blur-save.
  const [editorSavePending, setEditorSavePending] = useState(false);

  // A `quiet` reload (after an inline edit) refetches without flipping `loading`,
  // so the editor stays mounted — a full-page spinner would remount the form and
  // discard the user's in-progress local state and cursor position. Only the
  // initial load shows the spinner / replaces the view on error.
  const fetchDetail = useCallback(async (quiet = false) => {
    if (!id) { setError('Missing quote id'); setLoading(false); return; }
    try {
      if (!quiet) setLoading(true);
      setError(undefined);
      const res = await fetchWithAuth(`/quotes/${id}`);
      if (res.status === 401) return UNAUTHORIZED();
      if (res.status === 404) { if (!quiet) setError('Quote not found.'); return; }
      if (!res.ok) throw new Error('Failed to load quote');
      const body = (await res.json()) as { data: QuoteDetailData };
      setDetail(body.data);
    } catch (err) {
      // A failed quiet reload leaves the editor intact; the inline action's own
      // runAction toast already surfaced the failure.
      if (!quiet) setError(err instanceof Error ? err.message : 'Failed to load quote');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [id]);

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
        {error ?? 'Quote unavailable.'}
        <div>
          <a href="/billing/quotes" className="mt-3 inline-block rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted">
            Back to quotes
          </a>
        </div>
      </div>
    );
  }

  // The Editor only applies to drafts, so it's hidden once a quote is issued —
  // no dead-end tab that just shows a "can't edit" message. A stale #editor hash
  // on a non-draft falls back to Detail.
  const tabs: DocumentTab[] = TAB_LABELS.map((t) => ({
    id: t.value,
    label: t.label,
    hidden: t.value === 'editor' && !isDraft,
  }));
  const activeTab: Tab = tabs.some((t) => t.id === tab && !t.hidden) ? tab : 'detail';

  return (
    <DocumentWorkspace
      idPrefix="quote"
      backHref="/billing/quotes"
      backLabel="Quotes"
      title={detail.quote.title?.trim() || detail.quote.quoteNumber || 'Draft quote'}
      // Primary actions live in the header so Send (the money-moment) and Download
      // are reachable from any tab, not buried inside the Detail tab.
      actions={<QuoteActions detail={detail} onChanged={reload} variant="header" savePending={editorSavePending} />}
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={selectTab}
    >
      {activeTab === 'editor' && isDraft && (
        <QuoteEditor detail={detail} onChanged={() => void reload()} onPendingEditsChange={setEditorSavePending} />
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
