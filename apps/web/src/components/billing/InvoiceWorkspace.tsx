import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { usePermissions } from '../../lib/permissions';
import { DocumentWorkspace, type DocumentTab } from './shared/DocumentWorkspace';
import { StatusPill } from './shared/StatusPill';
import { usePdfDownload } from './shared/usePdfDownload';
import InvoiceEditor from './InvoiceEditor';
import InvoiceDetail from './InvoiceDetail';
import InvoiceDocumentPreview from './InvoiceDocument';
import { type InvoiceDetail as InvoiceDetailData, STATUS_ROLES, statusLabel } from './invoiceTypes';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

type Tab = 'editor' | 'preview' | 'detail';

const TAB_LABELS: { value: Tab; label: string }[] = [
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
  if (TAB_LABELS.some((t) => t.value === raw)) return raw as Tab;
  return isDraft ? 'editor' : 'detail';
}

export default function InvoiceWorkspace({ invoiceId }: Props) {
  const { can } = usePermissions();
  const [detail, setDetail] = useState<InvoiceDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<Tab>('editor');

  const invoice = detail?.invoice;
  // Download PDF is the one primary action liftable to the header for free: it's a
  // stateless authed-fetch hook, so both the draft editor tab and the read-only
  // detail tab can reach it without duplicating a stateful confirm flow. (Issue /
  // Issue & Send / Delete carry runAction + ConfirmDialog state that lives in
  // InvoiceEditor / InvoiceDetail and stays there.)
  const { download: downloadPdf, downloading } = usePdfDownload({
    path: `/invoices/${invoiceId}/pdf`,
    filename: `${invoice?.invoiceNumber ?? `invoice-${invoiceId}`}.pdf`,
    errorMessage: 'Could not download the invoice PDF.',
  });

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

  const selectTab = useCallback((next: string) => {
    setTab(next as Tab);
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

  // The Editor only applies to drafts, so it's hidden once an invoice is issued —
  // no dead-end tab that just shows a "can't edit" message. A stale #editor hash
  // on a non-draft falls back to Detail.
  const tabs: DocumentTab[] = TAB_LABELS.map((t) => ({
    id: t.value,
    label: t.label,
    hidden: t.value === 'editor' && !isDraft,
  }));
  const activeTab: Tab = tabs.some((t) => t.id === tab && !t.hidden) ? tab : 'detail';

  const roles = STATUS_ROLES[detail.invoice.status];
  const statusPill = (
    <StatusPill
      role={roles.role}
      label={statusLabel(detail.invoice)}
      className={roles.className ? `${roles.className} shrink-0` : 'shrink-0'}
      testId="invoice-workspace-status"
    />
  );

  // Download PDF is surfaced from any tab; the Detail tab suppresses its own copy
  // (actionsInHeader) so the two don't render at once.
  const actions = can('invoices', 'export') ? (
    <button
      type="button"
      onClick={() => void downloadPdf()}
      disabled={downloading}
      data-testid="invoice-download-pdf"
      className="inline-flex items-center justify-center rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
    >
      {downloading ? 'Preparing…' : 'Download PDF'}
    </button>
  ) : undefined;

  return (
    <DocumentWorkspace
      idPrefix="invoice"
      backHref="/billing/invoices"
      backLabel="Invoices"
      title={detail.invoice.invoiceNumber ?? 'Draft invoice'}
      statusPill={statusPill}
      actions={actions}
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={selectTab}
    >
      {activeTab === 'editor' && isDraft && (
        <InvoiceEditor detail={detail} onChanged={() => void reload()} />
      )}
      {activeTab === 'preview' && (
        <InvoiceDocumentPreview detail={detail} />
      )}
      {activeTab === 'detail' && (
        <InvoiceDetail detail={detail} onChanged={() => void reload()} actionsInHeader />
      )}
    </DocumentWorkspace>
  );
}
