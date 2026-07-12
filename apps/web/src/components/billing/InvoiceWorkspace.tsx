import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { DocumentWorkspace, type DocumentTab } from './shared/DocumentWorkspace';
import { StatusPill } from './shared/StatusPill';
import InvoiceEditor from './InvoiceEditor';
import InvoiceDetail from './InvoiceDetail';
import InvoiceDocumentPreview from './InvoiceDocument';
import InvoiceActions from './InvoiceActions';
import { type InvoiceDetail as InvoiceDetailData, STATUS_ROLES } from './invoiceTypes';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

type Tab = 'editor' | 'preview' | 'detail';

const TAB_LABELS: { value: Tab; labelKey: string }[] = [
  { value: 'editor', labelKey: 'invoiceWorkspace.tabs.editor' },
  { value: 'preview', labelKey: 'invoiceWorkspace.tabs.preview' },
  { value: 'detail', labelKey: 'invoiceWorkspace.tabs.detail' },
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
  const { t } = useTranslation('billing');
  const [detail, setDetail] = useState<InvoiceDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<Tab>('editor');

  // A `quiet` reload (after an inline edit) refetches without flipping `loading`,
  // so the editor stays mounted — a full-page spinner would remount the form and
  // discard the user's in-progress local state and cursor position. Only the
  // initial load shows the spinner / replaces the view on error.
  const fetchDetail = useCallback(async (quiet = false) => {
    if (!invoiceId) { setError(t('invoiceWorkspace.errors.missingId')); setLoading(false); return; }
    try {
      if (!quiet) setLoading(true);
      setError(undefined);
      const res = await fetchWithAuth(`/invoices/${invoiceId}`);
      if (res.status === 401) return UNAUTHORIZED();
      if (res.status === 404) { if (!quiet) setError(t('invoiceWorkspace.errors.notFound')); return; }
      if (!res.ok) throw new Error(t('invoiceWorkspace.errors.loadFailed'));
      const body = (await res.json()) as { data: InvoiceDetailData };
      setDetail(body.data);
    } catch (err) {
      // A failed quiet reload leaves the editor intact; the inline action's own
      // runAction toast already surfaced the failure.
      if (!quiet) setError(err instanceof Error ? err.message : t('invoiceWorkspace.errors.loadFailed'));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [invoiceId, t]);

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
        {error ?? t('invoiceWorkspace.errors.unavailable')}
        <div>
          <a href="/billing/invoices" className="mt-3 inline-block rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted">
            {t('invoiceWorkspace.backToInvoices')}
          </a>
        </div>
      </div>
    );
  }

  // The Editor only applies to drafts, so it's hidden once an invoice is issued —
  // no dead-end tab that just shows a "can't edit" message. A stale #editor hash
  // on a non-draft falls back to Detail.
  const tabs: DocumentTab[] = TAB_LABELS.map((tabDef) => ({
    id: tabDef.value,
    label: t(/* i18n-dynamic */ tabDef.labelKey),
    hidden: tabDef.value === 'editor' && !isDraft,
  }));
  const activeTab: Tab = tabs.some((t) => t.id === tab && !t.hidden) ? tab : 'detail';

  const roles = STATUS_ROLES[detail.invoice.status];
  const invoiceStatusLabel = detail.invoice.status === 'sent' && !detail.invoice.sentAt
    ? t('invoice.status.issued')
    : t(/* i18n-dynamic */ `invoice.status.${detail.invoice.status}`);
  const statusPill = (
    <StatusPill
      role={roles.role}
      label={invoiceStatusLabel}
      className={roles.className ? `${roles.className} shrink-0` : 'shrink-0'}
      testId="invoice-workspace-status"
    />
  );

  return (
    <DocumentWorkspace
      idPrefix="invoice"
      backHref="/billing/invoices"
      backLabel={t('invoiceWorkspace.backLabel')}
      title={detail.invoice.invoiceNumber ?? t('invoiceWorkspace.draftTitle')}
      statusPill={statusPill}
      // Primary actions live in the header so Issue / Issue & Send (the
      // money-moment) and Download are reachable from any tab, not buried inside
      // the Editor tab. The Detail tab suppresses its rail copy (actionsInHeader)
      // so the two never render at once.
      actions={<InvoiceActions detail={detail} onChanged={reload} variant="header" />}
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
