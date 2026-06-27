import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import QuoteEditor from './QuoteEditor';
import QuoteDetail from './QuoteDetail';
import QuoteDocumentPreview from './QuoteDocument';
import { type QuoteDetail as QuoteDetailData } from './quoteTypes';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

type Tab = 'editor' | 'preview' | 'detail';

const TABS: { value: Tab; label: string }[] = [
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
  if (TABS.some((t) => t.value === raw)) return raw as Tab;
  return isDraft ? 'editor' : 'detail';
}

export default function QuoteWorkspace({ id }: Props) {
  const [detail, setDetail] = useState<QuoteDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<Tab>('editor');

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

  const selectTab = useCallback((next: Tab) => {
    setTab(next);
    if (typeof window !== 'undefined') window.location.hash = `#${next}`;
  }, []);

  // Roving keyboard navigation across the tablist (WAI-ARIA tabs pattern):
  // Left/Right move between tabs, Home/End jump to the ends, and the moved-to
  // tab is both activated and focused.
  const onTabKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>, tabs: { value: Tab }[], current: Tab) => {
    const idx = tabs.findIndex((t) => t.value === current);
    if (idx < 0) return;
    let nextIdx: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextIdx = (idx + 1) % tabs.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') nextIdx = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = tabs.length - 1;
    if (nextIdx === null) return;
    e.preventDefault();
    const next = tabs[nextIdx].value;
    selectTab(next);
    if (typeof document !== 'undefined') document.getElementById(`quote-tab-${next}`)?.focus();
  }, [selectTab]);

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
  const visibleTabs = isDraft ? TABS : TABS.filter((t) => t.value !== 'editor');
  const activeTab: Tab = visibleTabs.some((t) => t.value === tab) ? tab : 'detail';

  return (
    <div className="space-y-4" data-testid="quote-workspace">
      <div className="flex items-center justify-between">
        <div>
          <a href="/billing/quotes" className="text-xs text-muted-foreground hover:underline">← Quotes</a>
          <h1 className="text-xl font-semibold" data-testid="quote-workspace-title">
            {detail.quote.quoteNumber ?? 'Draft quote'}
          </h1>
        </div>
      </div>

      {/* Tabs */}
      <div
        className="flex gap-1 border-b"
        role="tablist"
        data-testid="quote-workspace-tabs"
        onKeyDown={(e) => onTabKeyDown(e, visibleTabs, activeTab)}
      >
        {visibleTabs.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            id={`quote-tab-${t.value}`}
            aria-selected={activeTab === t.value}
            aria-controls={`quote-tabpanel-${t.value}`}
            tabIndex={activeTab === t.value ? 0 : -1}
            onClick={() => selectTab(t.value)}
            data-testid={`quote-tab-${t.value}`}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition ${
              activeTab === t.value
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'editor' && isDraft && (
        <div role="tabpanel" id="quote-tabpanel-editor" aria-labelledby="quote-tab-editor" tabIndex={0}>
          <QuoteEditor detail={detail} onChanged={() => void reload()} />
        </div>
      )}

      {activeTab === 'preview' && (
        <div role="tabpanel" id="quote-tabpanel-preview" aria-labelledby="quote-tab-preview" tabIndex={0}>
          <QuoteDocumentPreview detail={detail} />
        </div>
      )}

      {activeTab === 'detail' && (
        <div role="tabpanel" id="quote-tabpanel-detail" aria-labelledby="quote-tab-detail" tabIndex={0}>
          <QuoteDetail detail={detail} onChanged={() => void reload()} />
        </div>
      )}
    </div>
  );
}
