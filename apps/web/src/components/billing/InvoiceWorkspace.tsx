import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import InvoiceEditor from './InvoiceEditor';
import InvoiceDetail from './InvoiceDetail';
import InvoiceDocumentPreview from './InvoiceDocument';
import { type InvoiceDetail as InvoiceDetailData } from './invoiceTypes';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

type Tab = 'editor' | 'preview' | 'detail';

const TABS: { value: Tab; label: string }[] = [
  { value: 'editor', label: 'Editor' },
  { value: 'preview', label: 'Preview' },
  { value: 'detail', label: 'Detail' },
];

interface Props {
  invoiceId?: string;
}

function readTab(isDraft: boolean): Tab {
  if (typeof window === 'undefined') return isDraft ? 'editor' : 'detail';
  const raw = window.location.hash.replace(/^#/, '');
  if (TABS.some((t) => t.value === raw)) return raw as Tab;
  return isDraft ? 'editor' : 'detail';
}

export default function InvoiceWorkspace({ invoiceId }: Props) {
  const [detail, setDetail] = useState<InvoiceDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<Tab>('editor');

  // A `quiet` reload (after an inline edit) refetches without flipping `loading`,
  // so the editor stays mounted — a full-page spinner would remount the form and
  // discard the user's in-progress local state and cursor position. Only the
  // initial load shows the spinner / replaces the view on error.
  const fetchDetail = useCallback(async (quiet = false) => {
    if (!invoiceId) { setError('Missing invoice id'); setLoading(false); return; }
    try {
      if (!quiet) setLoading(true);
      setError(undefined);
      const res = await fetchWithAuth(`/invoices/${invoiceId}`);
      if (res.status === 401) return UNAUTHORIZED();
      if (res.status === 404) { if (!quiet) setError('Invoice not found.'); return; }
      if (!res.ok) throw new Error('Failed to load invoice');
      const body = (await res.json()) as { data: InvoiceDetailData };
      setDetail(body.data);
    } catch (err) {
      // A failed quiet reload leaves the editor intact; the inline action's own
      // runAction toast already surfaced the failure.
      if (!quiet) setError(err instanceof Error ? err.message : 'Failed to load invoice');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [invoiceId]);

  const load = useCallback(() => fetchDetail(false), [fetchDetail]);
  const reload = useCallback(() => fetchDetail(true), [fetchDetail]);

  useEffect(() => { void load(); }, [load]);

  // Initialise the active tab from the hash once we know whether it's a draft.
  const isDraft = detail?.invoice.status === 'draft';
  useEffect(() => {
    if (!detail) return;
    setTab(readTab(detail.invoice.status === 'draft'));
  }, [detail]);

  // React to back/forward hash changes.
  useEffect(() => {
    const onHash = () => setTab(readTab(detail?.invoice.status === 'draft'));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [detail]);

  const selectTab = useCallback((next: Tab) => {
    setTab(next);
    if (typeof window !== 'undefined') window.location.hash = `#${next}`;
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16" data-testid="invoice-workspace-loading">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center text-sm text-destructive" data-testid="invoice-workspace-error">
        {error ?? 'Invoice unavailable.'}
        <div>
          <a href="/billing/invoices" className="mt-3 inline-block rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted">
            Back to invoices
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="invoice-workspace">
      <div className="flex items-center justify-between">
        <div>
          <a href="/billing/invoices" className="text-xs text-muted-foreground hover:underline">← Invoices</a>
          <h1 className="text-xl font-semibold" data-testid="invoice-workspace-title">
            {detail.invoice.invoiceNumber ?? 'Draft invoice'}
          </h1>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b" role="tablist" data-testid="invoice-workspace-tabs">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={tab === t.value}
            onClick={() => selectTab(t.value)}
            data-testid={`invoice-tab-${t.value}`}
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
          <InvoiceEditor detail={detail} onChanged={() => void reload()} />
        ) : (
          <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground" data-testid="invoice-editor-locked">
            This invoice is no longer a draft and can no longer be edited. Switch to the Detail tab to review it.
          </div>
        )
      )}

      {tab === 'preview' && <InvoiceDocumentPreview detail={detail} />}

      {tab === 'detail' && <InvoiceDetail detail={detail} onChanged={() => void reload()} />}
    </div>
  );
}
