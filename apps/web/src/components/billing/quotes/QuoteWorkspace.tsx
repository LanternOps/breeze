import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { handleActionError } from '../../../lib/runAction';
import { quotePdfUrl } from '../../../lib/api/quotes';
import QuoteEditor from './QuoteEditor';
import QuoteDetail from './QuoteDetail';
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

  const load = useCallback(async () => {
    if (!id) { setError('Missing quote id'); setLoading(false); return; }
    try {
      setLoading(true);
      setError(undefined);
      const res = await fetchWithAuth(`/quotes/${id}`);
      if (res.status === 401) return UNAUTHORIZED();
      if (res.status === 404) { setError('Quote not found.'); return; }
      if (!res.ok) throw new Error('Failed to load quote');
      const body = (await res.json()) as { data: QuoteDetailData };
      setDetail(body.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load quote');
    } finally {
      setLoading(false);
    }
  }, [id]);

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
      <div className="flex gap-1 border-b" role="tablist" data-testid="quote-workspace-tabs">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={tab === t.value}
            onClick={() => selectTab(t.value)}
            data-testid={`quote-tab-${t.value}`}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition ${
              tab === t.value
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'editor' && (
        isDraft ? (
          <QuoteEditor detail={detail} onChanged={() => void load()} />
        ) : (
          <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground" data-testid="quote-editor-locked">
            This quote is no longer a draft and can no longer be edited. Switch to the Detail tab to review it.
          </div>
        )
      )}

      {tab === 'preview' && <QuotePreview id={detail.quote.id} />}

      {tab === 'detail' && <QuoteDetail detail={detail} onChanged={() => void load()} />}
    </div>
  );
}

// The PDF route requires the auth header, so a bare `<iframe src=...>` (which the
// browser fetches without our token) would 401. Mirror InvoiceDetail's PDF flow:
// fetchWithAuth → blob → object URL → iframe. Revoke the URL on unmount/change.
function QuotePreview({ id }: { id: string }) {
  const [url, setUrl] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const loadPdf = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    let objectUrl: string | undefined;
    try {
      const res = await fetchWithAuth(quotePdfUrl(id));
      if (res.status === 401) { UNAUTHORIZED(); return; }
      if (!res.ok) { setFailed(true); handleActionError(new Error('pdf'), 'Could not load the quote preview.'); return; }
      const blob = await res.blob();
      objectUrl = window.URL.createObjectURL(blob);
      setUrl(objectUrl);
    } catch (err) {
      setFailed(true);
      handleActionError(err, 'Could not load the quote preview.');
    } finally {
      setLoading(false);
    }
    return objectUrl;
  }, [id]);

  useEffect(() => {
    let active: string | undefined;
    void loadPdf().then((u) => { active = u; });
    return () => { if (active) window.URL.revokeObjectURL(active); };
  }, [loadPdf]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16" data-testid="quote-preview-loading">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (failed || !url) {
    return (
      <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground" data-testid="quote-preview-error">
        Could not load the preview.{' '}
        <button type="button" onClick={() => void loadPdf()} className="underline hover:text-foreground">Retry</button>
      </div>
    );
  }

  return (
    <iframe
      src={url}
      title="Quote PDF preview"
      data-testid="quote-preview-frame"
      className="h-[80vh] w-full rounded-lg border bg-card"
    />
  );
}
