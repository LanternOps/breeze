import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../../lib/i18n';
import { QuoteDocumentView, type DocumentHostComponents } from '@breeze/document-ui';
import {
  buildQuoteDocumentModel,
  documentLabelsFor,
  type CustomerQuoteDocument,
  type QuoteDocumentModel,
} from '@breeze/shared/documents';
import { fetchWithAuth } from '../../../stores/auth';
import { useQuotePdfDownload } from './useQuoteImage';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { webQuoteHostComponents } from '../documentHostComponents';

type PreviewState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; model: QuoteDocumentModel; dto: CustomerQuoteDocument };

/** Statuses a customer can still sign from; the Preview shows where the signature goes. */
const SIGNABLE = new Set(['draft', 'sent', 'viewed']);

/** Preview-tab wrapper: renders the CUSTOMER document (`GET /quotes/:id/customer-view`, the
 *  same assembler the portal and the public link use), so what staff see is what the customer
 *  sees. The staff `detail` is only the refetch trigger: the workspace hands a new object after
 *  every `reload()`, and the tab remounts this component on each visit. */
export default function QuoteDocumentPreview({
  detail,
  components,
}: {
  detail: QuoteDetailData;
  /** Test seam: parity tests inject deterministic stand-ins. */
  components?: DocumentHostComponents;
}) {
  const { t } = useTranslation('billing');
  const { quote } = detail;
  const [state, setState] = useState<PreviewState>({ status: 'loading' });
  const [retryNonce, setRetryNonce] = useState(0);
  const accentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Cleanup flips this, so an older request finishing after a newer one is discarded.
    let current = true;
    void (async () => {
      try {
        const res = await fetchWithAuth(`/quotes/${quote.id}/customer-view`);
        if (!res.ok) throw new Error(`customer-view ${res.status}`);
        const body = (await res.json()) as { data?: CustomerQuoteDocument };
        const dto = body.data;
        if (!dto?.quote || !Array.isArray(dto.blocks) || !Array.isArray(dto.lines)) throw new Error('customer-view: malformed body');
        // Built inside the try: a payload that passes the shape check but breaks the builder
        // shows the error state instead of throwing in render.
        const model = buildQuoteDocumentModel(dto, documentLabelsFor(dto.documentLocale));
        if (current) setState({ status: 'ready', model, dto });
      } catch (err) {
        console.error('[QuoteDocumentPreview] customer view failed', quote.id, err instanceof Error ? err.message : err);
        if (current) setState({ status: 'error' });
      }
    })();
    return () => { current = false; };
    // `detail` is the refetch trigger (new object per reload()); `quote.id` rides along with it.
  }, [detail, retryNonce]);

  const ready = state.status === 'ready' ? state : null;
  const dto = ready?.dto ?? null;
  const hostComponents = useMemo(() => components ?? (dto ? webQuoteHostComponents(dto) : null), [components, dto]);

  // The accent is host chrome (the package writes no style attribute): the wrapper, not the paper, carries it.
  const accent = dto?.branding.primaryColor ?? null;
  useEffect(() => {
    const el = accentRef.current;
    if (!el) return;
    if (accent) el.style.setProperty('--doc-accent', accent);
    else el.style.removeProperty('--doc-accent');
  }, [accent, ready]);

  const { busy, downloadPdf } = useQuotePdfDownload(quote);

  return (
    <div className="space-y-4" data-testid="quote-preview">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{t('quotes.document.preview.description')}</p>
        <button
          type="button"
          onClick={() => void downloadPdf()}
          disabled={busy}
          data-testid="quote-preview-download-pdf"
          className="inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {busy ? t('quotes.document.preview.preparing') : t('quotes.document.preview.downloadPdf')}
        </button>
      </div>
      <div className="rounded-xl bg-muted/30 p-2 sm:p-8">
        {state.status === 'loading' && (
          <p className="py-12 text-center text-sm text-muted-foreground" data-testid="quote-preview-loading">
            {t('quotes.document.preview.loading')}
          </p>
        )}
        {state.status === 'error' && (
          <div className="space-y-3 py-12 text-center text-sm text-muted-foreground" data-testid="quote-preview-error">
            <p>{t('quotes.document.preview.loadError')}</p>
            <button
              type="button"
              onClick={() => { setState({ status: 'loading' }); setRetryNonce((n) => n + 1); }}
              data-testid="quote-preview-retry"
              className="inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              {t('quotes.document.preview.retry')}
            </button>
          </div>
        )}
        {ready && hostComponents && (
          <div ref={accentRef} data-testid="quote-preview-paper" className="mx-auto max-w-3xl">
            <QuoteDocumentView
              model={ready.model}
              components={hostComponents}
              slots={{
                // The customer signs on their own link; the Preview only marks the spot.
                signature: SIGNABLE.has(ready.dto.quote.status) ? (
                  <div
                    className="rounded-lg border border-dashed bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground"
                    data-testid="quote-preview-signature"
                  >
                    {t('quotes.document.preview.signatureInert')}
                  </div>
                ) : undefined,
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
