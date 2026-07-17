import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { listContractDocuments, contractDocumentPdfPath, type ContractDocument } from '../../lib/api/contractDocuments';
import { usePdfDownload } from '../billing/shared/usePdfDownload';
import { formatDate } from '../billing/invoiceTypes';

interface Props {
  contractId: string;
}

/** One row's Download PDF affordance — its own component because
 *  `usePdfDownload` is a hook: it must be called once per row, not inside the
 *  `.map()` callback of the parent. */
function DocumentDownloadButton({ doc }: { doc: ContractDocument }) {
  const { t } = useTranslation('billing');
  const { download, downloading } = usePdfDownload({
    path: contractDocumentPdfPath(doc.id),
    filename: `contract-document-${doc.id}.pdf`,
    errorMessage: t('contracts.contractDetail.documents.downloadError'),
  });
  return (
    <button
      type="button"
      onClick={() => void download()}
      disabled={downloading}
      data-testid={`contract-document-download-${doc.id}`}
      className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
    >
      {downloading ? t('contracts.contractDetail.documents.preparing') : t('contracts.contractDetail.documents.download')}
    </button>
  );
}

/**
 * Executed contract documents for one contract (Task 18): the legal
 * snapshots created at quote-acceptance time (Task 15), each pinned to the
 * template version + variables the signer actually saw. Read-only — linking
 * an unattached document to a contract happens from the Documents tab on the
 * contracts landing page, not here.
 */
export default function ContractDocumentsSection({ contractId }: Props) {
  const { t } = useTranslation('billing');
  const [documents, setDocuments] = useState<ContractDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        setLoading(true);
        setError(undefined);
        const res = await listContractDocuments({ contractId });
        if (!res.ok) throw new Error(t('contracts.contractDetail.documents.loadError'));
        const body = (await res.json().catch(() => null)) as { data?: ContractDocument[] } | null;
        if (!body) throw new Error(t('contracts.contractDetail.documents.loadError'));
        if (!cancelled) setDocuments(body.data ?? []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : t('contracts.contractDetail.documents.loadError'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [contractId, t]);

  return (
    <div className="rounded-lg border bg-card shadow-xs" data-testid="contract-documents-section">
      <h3 className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('contracts.contractDetail.documents.title')}
      </h3>
      {loading ? (
        <div className="flex items-center justify-center py-8" data-testid="contract-documents-loading">
          <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      ) : error ? (
        <div className="px-3 py-6 text-center text-sm text-destructive" data-testid="contract-documents-error">
          {error}
        </div>
      ) : documents.length === 0 ? (
        <div className="px-3 py-8 text-center text-sm text-muted-foreground" data-testid="contract-documents-empty">
          {t('contracts.contractDetail.documents.empty')}
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2 font-medium">{t('contracts.contractDetail.documents.columns.template')}</th>
              <th className="px-3 py-2 font-medium">{t('contracts.contractDetail.documents.columns.signer')}</th>
              <th className="px-3 py-2 font-medium">{t('contracts.contractDetail.documents.columns.signedAt')}</th>
              <th className="px-3 py-2 font-medium">{t('contracts.contractDetail.documents.columns.quote')}</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => (
              <tr key={doc.id} data-testid="contract-document-row" className="border-t">
                <td className="px-3 py-2">
                  {t('contracts.contractDetail.documents.templateVersion', {
                    name: doc.templateName,
                    number: doc.templateVersionNumber,
                  })}
                </td>
                <td className="px-3 py-2">{doc.signerName ?? '—'}</td>
                <td className="px-3 py-2">{doc.signedAt ? formatDate(doc.signedAt) : '—'}</td>
                <td className="px-3 py-2">
                  {doc.quoteId ? (
                    <a
                      href={`/billing/quotes/${doc.quoteId}`}
                      data-testid={`contract-document-quote-link-${doc.id}`}
                      className="text-primary hover:underline"
                    >
                      {doc.quoteNumber ?? t('contracts.contractDetail.documents.viewQuote')}
                    </a>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <DocumentDownloadButton doc={doc} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
