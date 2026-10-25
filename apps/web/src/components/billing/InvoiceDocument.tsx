import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { InvoiceDocumentView, type DocumentHostComponents } from '@breeze/document-ui';
import {
  buildInvoiceDocumentModel,
  documentLabelsFor,
  type CustomerInvoiceDocument,
  type InvoiceDocumentModel,
} from '@breeze/shared/documents';
import { fetchWithAuth } from '../../stores/auth';
import { usePdfDownload } from './shared/usePdfDownload';
import type { InvoiceDetail as InvoiceDetailData } from './invoiceTypes';
import { webHostComponents } from './documentHostComponents';

type PreviewState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; model: InvoiceDocumentModel; accent: string | null };

/** Preview-tab wrapper: renders the CUSTOMER document (`GET /invoices/:id/customer-view`,
 *  the same assembler the portal and the public link use), so what staff see is what the
 *  customer sees. The staff `detail` is only the refetch trigger: the workspace hands a new
 *  object after every `reload()`, and the tab remounts this component on each visit. */
export default function InvoiceDocumentPreview({
  detail,
  components = webHostComponents,
}: {
  detail: InvoiceDetailData;
  /** Test seam: parity tests inject deterministic stand-ins. */
  components?: DocumentHostComponents;
}) {
  const { t } = useTranslation('billing');
  const { invoice } = detail;
  const [state, setState] = useState<PreviewState>({ status: 'loading' });
  const [retryNonce, setRetryNonce] = useState(0);
  const accentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Cleanup flips this, so an older request finishing after a newer one is discarded.
    let current = true;
    void (async () => {
      try {
        const res = await fetchWithAuth(`/invoices/${invoice.id}/customer-view`);
        if (!res.ok) throw new Error(`customer-view ${res.status}`);
        const body = (await res.json()) as { data?: CustomerInvoiceDocument };
        if (!body.data?.invoice || !Array.isArray(body.data.lines)) throw new Error('customer-view: malformed body');
        // Built inside the try: a payload that passes the shape check but breaks the builder
        // (missing branding, bad currency) shows the error state instead of throwing in render.
        const dto = body.data;
        const model = buildInvoiceDocumentModel(dto, documentLabelsFor(dto.documentLocale));
        if (current) setState({ status: 'ready', model, accent: dto.branding.primaryColor });
      } catch (err) {
        console.error('[InvoiceDocumentPreview] customer view failed', invoice.id, err instanceof Error ? err.message : err);
        if (current) setState({ status: 'error' });
      }
    })();
    return () => { current = false; };
    // `detail` is the refetch trigger (new object per reload()); `invoice.id` rides along with it.
  }, [detail, retryNonce]);

  const model = state.status === 'ready' ? state.model : null;

  // The accent is host chrome (the package writes no style attribute): the wrapper, not the paper, carries it.
  const accent = state.status === 'ready' ? state.accent : null;
  useEffect(() => {
    const el = accentRef.current;
    if (!el) return;
    if (accent) el.style.setProperty('--doc-accent', accent);
    else el.style.removeProperty('--doc-accent');
  }, [accent, model]);

  const { download: downloadPdf, downloading: busy } = usePdfDownload({
    path: `/invoices/${invoice.id}/pdf`,
    filename: `${invoice.invoiceNumber ?? `invoice-${invoice.id}`}.pdf`,
    errorMessage: t('invoiceDocument.preview.downloadError'),
  });

  return (
    <div className="space-y-4" data-testid="invoice-preview">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{t('invoiceDocument.preview.description')}</p>
        <button
          type="button"
          onClick={() => void downloadPdf()}
          disabled={busy}
          data-testid="invoice-preview-download-pdf"
          className="inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {busy ? t('invoiceDocument.preview.preparing') : t('invoiceDocument.preview.downloadPdf')}
        </button>
      </div>
      <div className="rounded-xl bg-muted/30 p-2 sm:p-8">
        {state.status === 'loading' && (
          <p className="py-12 text-center text-sm text-muted-foreground" data-testid="invoice-preview-loading">
            {t('invoiceDocument.preview.loading')}
          </p>
        )}
        {state.status === 'error' && (
          <div className="space-y-3 py-12 text-center text-sm text-muted-foreground" data-testid="invoice-preview-error">
            <p>{t('invoiceDocument.preview.loadError')}</p>
            <button
              type="button"
              onClick={() => { setState({ status: 'loading' }); setRetryNonce((n) => n + 1); }}
              data-testid="invoice-preview-retry"
              className="inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              {t('invoiceDocument.preview.retry')}
            </button>
          </div>
        )}
        {model && (
          <div ref={accentRef} data-testid="invoice-preview-paper" className="mx-auto max-w-3xl">
            <InvoiceDocumentView model={model} components={components} />
          </div>
        )}
      </div>
    </div>
  );
}
