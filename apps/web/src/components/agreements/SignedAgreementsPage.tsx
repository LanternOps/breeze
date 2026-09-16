import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText } from 'lucide-react';
import '@/lib/i18n';
import { navigateTo } from '@/lib/navigation';
import { useHashState } from '@/lib/useHashState';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';
import { listContractDocuments, contractDocumentPdfPath, linkContractDocument, type ContractDocument } from '../../lib/api/contractDocuments';
import { listContracts, type ContractSummary } from '../../lib/api/contracts';
import { usePdfDownload } from '../billing/shared/usePdfDownload';
import { formatDate } from '../billing/invoiceTypes';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

interface Organization {
  id: string;
  name: string;
}

/** Same reasoning as ContractDocumentsSection's DocumentDownloadButton — the
 *  download hook must be called once per row, not inside a `.map()`. */
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
      {downloading ? t('contracts.documentsTab.preparing') : t('contracts.documentsTab.download')}
    </button>
  );
}

export interface SignedAgreementsPageProps {
  /** Org-record embed: pin the list to one organization and hide the Organization column. */
  lockedOrgId?: string;
  /** Contract-detail embed: pin the list to one contract, hide the Contract column and the link action. */
  lockedContractId?: string;
  /** Start with the "Unlinked only" chip on. Default false (W03 scope decision 2). */
  defaultUnlinkedOnly?: boolean;
}

/**
 * The signed-agreement inventory (spec §6) — every executed contract-document
 * snapshot the caller can read, not just the orphans the old Documents tab
 * showed. One component serves three surfaces: the standalone
 * /agreements/signed page, the org record (`lockedOrgId`) and contract detail
 * (`lockedContractId`), so there is no second table to keep in step.
 */
export default function SignedAgreementsPage({
  lockedOrgId,
  lockedContractId,
  defaultUnlinkedOnly = false,
}: SignedAgreementsPageProps = {}) {
  const { t } = useTranslation('billing');
  const locked = Boolean(lockedOrgId || lockedContractId);

  // CLAUDE.md: hash for transient UI state, never query params. Embeds do NOT
  // read the hash — two lists on one page (org record) would fight over it.
  const [unlinkedOnly, setUnlinkedOnly] = useHashState<boolean>(
    defaultUnlinkedOnly,
    (h) => (locked ? undefined : new URLSearchParams(h).get('unlinked') === '1' || undefined),
  );
  const toggleUnlinked = () => {
    const next = !unlinkedOnly;
    setUnlinkedOnly(next);
    if (!locked) window.location.hash = next ? 'unlinked=1' : '';
  };

  const [documents, setDocuments] = useState<ContractDocument[]>([]);
  const [orgNames, setOrgNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  // Link dialog state.
  const [linkingDoc, setLinkingDoc] = useState<ContractDocument | null>(null);
  const [orgContracts, setOrgContracts] = useState<ContractSummary[]>([]);
  const [contractsLoading, setContractsLoading] = useState(false);
  const [selectedContractId, setSelectedContractId] = useState('');
  const [linkError, setLinkError] = useState<string>();
  const [linking, setLinking] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      // `linked` MUST be sent explicitly — an omitted param means 'unlinked'
      // server-side (W03 Task 1), so the inventory would silently look empty.
      const res = await listContractDocuments(
        lockedContractId
          ? { contractId: lockedContractId }
          : { orgId: lockedOrgId, linked: unlinkedOnly ? 'unlinked' : 'all' },
      );
      if (res.status === 401) return UNAUTHORIZED();
      if (!res.ok) throw new Error(t('contracts.documentsTab.loadError'));
      const body = (await res.json().catch(() => null)) as { data?: ContractDocument[] } | null;
      if (!body) throw new Error(t('contracts.documentsTab.loadError'));
      setDocuments(body.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('contracts.documentsTab.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t, unlinkedOnly, lockedOrgId, lockedContractId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetchWithAuth('/orgs/organizations');
        if (!res.ok) return;
        const body = (await res.json().catch(() => null)) as
          | { data?: Organization[]; organizations?: Organization[] }
          | null;
        const list = body?.data ?? body?.organizations ?? [];
        setOrgNames(Object.fromEntries(list.map((o) => [o.id, o.name])));
      } catch {
        // Cosmetic org-name enrichment only — a failed GET just leaves the
        // organization column showing its '—' fallback. No toast.
      }
    })();
  }, []);

  const openLinkDialog = (doc: ContractDocument) => {
    setLinkingDoc(doc);
    setSelectedContractId('');
    setLinkError(undefined);
    setOrgContracts([]);
    setContractsLoading(true);
    void (async () => {
      try {
        const res = await listContracts({ orgId: doc.orgId });
        // Match the tab's load() handling: a 401 redirects, a non-OK response is
        // surfaced as an error — never rendered as an (empty) "no contracts" list.
        if (res.status === 401) return UNAUTHORIZED();
        if (!res.ok) {
          setLinkError(t('contracts.documentsTab.linkDialog.loadContractsError'));
          return;
        }
        const body = (await res.json().catch(() => null)) as { data?: ContractSummary[] } | null;
        setOrgContracts(body?.data ?? []);
      } catch {
        setLinkError(t('contracts.documentsTab.linkDialog.loadContractsError'));
      } finally {
        setContractsLoading(false);
      }
    })();
  };

  const confirmLink = async () => {
    if (!linkingDoc || !selectedContractId) {
      setLinkError(t('contracts.documentsTab.linkDialog.selectContract'));
      return;
    }
    setLinkError(undefined);
    setLinking(true);
    try {
      await runAction({
        request: () => linkContractDocument(linkingDoc.id, selectedContractId),
        errorFallback: t('contracts.documentsTab.linkError'),
        successMessage: t('contracts.documentsTab.linkSuccess'),
        onUnauthorized: UNAUTHORIZED,
      });
      setLinkingDoc(null);
      await load();
    } catch (err) {
      handleActionError(err, t('contracts.documentsTab.linkError'));
    } finally {
      setLinking(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="signed-agreements-tab">
      {/* Inside an embed the surrounding section already names this list (the
          org record's <summary>, the contract page's own heading). */}
      {!locked && (
        <div>
          <h2 className="text-lg font-semibold">{t('agreements.signedPage.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('agreements.signedPage.description')}</p>
        </div>
      )}

      {!lockedContractId && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleUnlinked}
            aria-pressed={unlinkedOnly}
            data-testid="signed-agreements-unlinked-filter"
            className={`rounded-full border px-3 py-1 text-xs font-medium ${
              unlinkedOnly ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            {t('agreements.signedPage.unlinkedOnly')}
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16" data-testid="contract-documents-loading">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      ) : error ? (
        <div
          className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center text-sm text-destructive"
          data-testid="contract-documents-error"
        >
          {error}
        </div>
      ) : documents.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center" data-testid="contract-documents-empty">
          <FileText className="mx-auto h-8 w-8 text-muted-foreground" />
          {/* "No signed agreements yet" under an active filter is a lie. */}
          <p className="mt-2 text-sm font-medium">
            {unlinkedOnly
              ? t('agreements.signedPage.emptyUnlinked.title')
              : t('agreements.signedPage.empty.title')}
          </p>
          <p className="text-sm text-muted-foreground">
            {unlinkedOnly
              ? t('agreements.signedPage.emptyUnlinked.description')
              : t('agreements.signedPage.empty.description')}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t('contracts.documentsTab.columns.template')}</th>
                {!lockedOrgId && (
                  <th className="px-3 py-2 font-medium">{t('contracts.documentsTab.columns.organization')}</th>
                )}
                <th className="px-3 py-2 font-medium">{t('contracts.documentsTab.columns.signer')}</th>
                <th className="px-3 py-2 font-medium">{t('contracts.documentsTab.columns.signedAt')}</th>
                <th className="px-3 py-2 font-medium">{t('contracts.documentsTab.columns.quote')}</th>
                {!lockedContractId && (
                  <th className="px-3 py-2 font-medium">{t('agreements.signedPage.columns.contract')}</th>
                )}
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id} data-testid="contract-document-row" className="border-t hover:bg-muted/20">
                  <td className="px-3 py-2">
                    {t('contracts.contractDetail.documents.templateVersion', {
                      name: doc.templateName,
                      number: doc.templateVersionNumber,
                    })}
                    {/* The no-quote variant exists because quoteId/quoteNumber are
                        left-joined and genuinely null for a deleted quote. */}
                    <div className="text-xs text-muted-foreground" data-testid="signed-agreement-subtitle">
                      {doc.quoteNumber
                        ? t('agreements.signedPage.rowSubtitle', {
                            quoteNumber: doc.quoteNumber,
                            signer: doc.signerName ?? '—',
                            date: doc.signedAt ? formatDate(doc.signedAt) : '—',
                          })
                        : t('agreements.signedPage.rowSubtitleNoQuote', {
                            signer: doc.signerName ?? '—',
                            date: doc.signedAt ? formatDate(doc.signedAt) : '—',
                          })}
                    </div>
                  </td>
                  {!lockedOrgId && (
                    <td className="px-3 py-2 text-muted-foreground">{orgNames[doc.orgId] ?? '—'}</td>
                  )}
                  <td className="px-3 py-2">{doc.signerName ?? '—'}</td>
                  <td className="px-3 py-2">{doc.signedAt ? formatDate(doc.signedAt) : '—'}</td>
                  <td className="px-3 py-2">
                    {doc.quoteId ? (
                      <a
                        href={`/billing/quotes/${doc.quoteId}`}
                        data-testid={`contract-document-quote-link-${doc.id}`}
                        className="text-primary hover:underline"
                      >
                        {doc.quoteNumber ?? t('contracts.documentsTab.viewQuote')}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  {!lockedContractId && (
                    <td className="px-3 py-2">
                      {/* A generic label, not the contract's name: the list projection
                          carries contractId but no name, and joining `contracts` into
                          a list endpoint is not worth it for one cell. */}
                      {doc.contractId ? (
                        <a
                          href={`/contracts/${doc.contractId}`}
                          data-testid="signed-agreement-contract-link"
                          className="text-primary hover:underline"
                        >
                          {t('agreements.signedPage.viewContract')}
                        </a>
                      ) : (
                        <span className="text-muted-foreground">{t('agreements.signedPage.notLinked')}</span>
                      )}
                    </td>
                  )}
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <DocumentDownloadButton doc={doc} />
                      {!doc.contractId && !lockedContractId && (
                        <button
                          type="button"
                          onClick={() => openLinkDialog(doc)}
                          data-testid="contract-document-link-open"
                          className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                        >
                          {t('contracts.documentsTab.linkAction')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {linkingDoc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div
            className="w-full max-w-md space-y-4 rounded-lg border bg-background p-5 shadow-lg"
            data-testid="contract-document-link-dialog"
          >
            <h3 className="text-base font-semibold">{t('contracts.documentsTab.linkDialog.title')}</h3>

            <div className="space-y-1">
              <label htmlFor="link-contract" className="text-sm font-medium">
                {t('contracts.documentsTab.linkDialog.contractLabel')}
              </label>
              {contractsLoading ? (
                <div className="flex items-center justify-center py-3">
                  <div className="h-5 w-5 animate-spin rounded-full border-4 border-primary border-t-transparent" />
                </div>
              ) : orgContracts.length === 0 ? (
                // Suppress the "no contracts" copy when the fetch actually failed —
                // the error is surfaced by the linkError block below instead.
                linkError ? null : <p className="text-sm text-muted-foreground">{t('contracts.documentsTab.linkDialog.noContracts')}</p>
              ) : (
                <select
                  id="link-contract"
                  value={selectedContractId}
                  onChange={(e) => setSelectedContractId(e.target.value)}
                  data-testid="contract-document-link-select"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                >
                  <option value="">{t('contracts.documentsTab.linkDialog.selectContract')}</option>
                  {orgContracts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {linkError && (
              <p className="text-sm text-destructive" data-testid="contract-document-link-error">
                {linkError}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setLinkingDoc(null)}
                className="h-9 rounded-md border px-4 text-sm font-medium hover:bg-muted"
              >
                {t('contracts.documentsTab.linkDialog.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void confirmLink()}
                disabled={linking || orgContracts.length === 0}
                data-testid="contract-document-link-confirm"
                className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
              >
                {linking ? t('contracts.documentsTab.linkDialog.linking') : t('contracts.documentsTab.linkDialog.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
