import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import InvoiceEditor from './InvoiceEditor';
import InvoiceDetail from './InvoiceDetail';
import { type InvoiceDetail as InvoiceDetailData } from './invoiceTypes';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

interface Props {
  invoiceId?: string;
}

export default function InvoiceWorkspace({ invoiceId }: Props) {
  const [detail, setDetail] = useState<InvoiceDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    if (!invoiceId) { setError('Missing invoice id'); setLoading(false); return; }
    try {
      setLoading(true);
      setError(undefined);
      const res = await fetchWithAuth(`/invoices/${invoiceId}`);
      if (res.status === 401) return UNAUTHORIZED();
      if (res.status === 404) { setError('Invoice not found.'); return; }
      if (!res.ok) throw new Error('Failed to load invoice');
      const body = (await res.json()) as { data: InvoiceDetailData };
      setDetail(body.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load invoice');
    } finally {
      setLoading(false);
    }
  }, [invoiceId]);

  useEffect(() => { void load(); }, [load]);

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

  const isDraft = detail.invoice.status === 'draft';

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
      {isDraft ? (
        <InvoiceEditor detail={detail} onChanged={() => void load()} />
      ) : (
        <InvoiceDetail detail={detail} onChanged={() => void load()} />
      )}
    </div>
  );
}
