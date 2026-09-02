import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import '@/lib/i18n';
import { navigateTo } from '@/lib/navigation';
import { StatusPill } from '../billing/shared/StatusPill';
import { formatDate } from '../billing/invoiceTypes';
import {
  CONTRACT_STATUS_ROLES,
  listContractCurrencyMismatches,
  type ContractCurrencyMismatch,
  type ContractCurrencyMismatchReport,
} from '../../lib/api/contracts';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

const PAGE_SIZE = 50;

/**
 * Contract-vs-org currency mismatch report (multi-currency wave 6, #3778,
 * Task 15) — the operator's inventory of contracts still stamped in a currency
 * their organization no longer bills in.
 *
 * READ-ONLY BY DESIGN. There is no bulk restamp and no bulk fix here: the
 * owner-fixed decisions forbid bulk restamping history, so each row is acted on
 * individually from the contract's own detail page, where the server re-checks
 * eligibility under the contract's row lock. The row link therefore points at
 * the contract detail route (which exists today); the in-page currency action
 * itself is Task 16. Nothing here ever links to a route that could 404.
 *
 * `activeChangeEligible` is the server's verdict from the SAME helper the
 * mutation gates on — the UI never re-derives it, so the two can't disagree.
 */
export default function CurrencyMismatchesTab() {
  const { t } = useTranslation('billing');

  const [items, setItems] = useState<ContractCurrencyMismatch[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();

  const fetchPage = useCallback(async (cursor?: string): Promise<ContractCurrencyMismatchReport | null> => {
    const res = await listContractCurrencyMismatches({ limit: PAGE_SIZE, cursor });
    if (res.status === 401) { UNAUTHORIZED(); return null; }
    if (!res.ok) throw new Error(t('contracts.currencyMismatches.loadError'));
    const body = (await res.json().catch(() => null)) as { data?: ContractCurrencyMismatchReport } | null;
    if (!body?.data) throw new Error(t('contracts.currencyMismatches.loadError'));
    return body.data;
  }, [t]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const data = await fetchPage();
      if (!data) return;
      setItems(data.items);
      setNextCursor(data.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('contracts.currencyMismatches.loadError'));
    } finally {
      setLoading(false);
    }
  }, [fetchPage, t]);

  useEffect(() => { void load(); }, [load]);

  const loadMore = async () => {
    if (!nextCursor) return;
    try {
      setLoadingMore(true);
      setError(undefined);
      const data = await fetchPage(nextCursor);
      if (!data) return;
      setItems((prev) => [...prev, ...data.items]);
      setNextCursor(data.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('contracts.currencyMismatches.loadError'));
    } finally {
      setLoadingMore(false);
    }
  };

  const eligibilityLabel = (row: ContractCurrencyMismatch) => {
    if (row.activeChangeEligible) return t('contracts.currencyMismatches.eligible');
    return t(/* i18n-dynamic */ `contracts.currencyMismatches.reason.${row.ineligibleReason ?? 'STATUS_NOT_ACTIVE'}`);
  };

  return (
    <div className="space-y-4" data-testid="currency-mismatches-tab">
      <div>
        <h2 className="text-lg font-semibold">{t('contracts.currencyMismatches.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('contracts.currencyMismatches.description')}</p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
             data-testid="currency-mismatches-error">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground" data-testid="currency-mismatches-loading">
          {t('contracts.currencyMismatches.loading')}
        </p>
      ) : items.length === 0 ? (
        <div className="rounded-md border border-dashed px-4 py-10 text-center" data-testid="currency-mismatches-empty">
          <p className="text-sm font-medium">{t('contracts.currencyMismatches.emptyTitle')}</p>
          <p className="text-sm text-muted-foreground">{t('contracts.currencyMismatches.emptyBody')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">{t('contracts.currencyMismatches.columns.contract')}</th>
                <th className="px-3 py-2">{t('contracts.currencyMismatches.columns.organization')}</th>
                <th className="px-3 py-2">{t('contracts.currencyMismatches.columns.status')}</th>
                <th className="px-3 py-2">{t('contracts.currencyMismatches.columns.currencies')}</th>
                <th className="px-3 py-2">{t('contracts.currencyMismatches.columns.nextBilling')}</th>
                <th className="px-3 py-2">{t('contracts.currencyMismatches.columns.eligibility')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.contractId} className="border-t" data-testid={`currency-mismatch-row-${row.contractId}`}>
                  <td className="px-3 py-3 font-medium">
                    <a
                      href={`/contracts/${row.contractId}`}
                      data-testid={`currency-mismatch-link-${row.contractId}`}
                      className="text-primary hover:underline"
                    >
                      {row.contractName}
                    </a>
                  </td>
                  <td className="px-3 py-3">{row.orgName}</td>
                  <td className="px-3 py-3">
                    <StatusPill
                      role={CONTRACT_STATUS_ROLES[row.status].role}
                      label={t(/* i18n-dynamic */ `contracts.shared.status.${row.status}`)}
                      className={CONTRACT_STATUS_ROLES[row.status].className}
                      testId={`currency-mismatch-status-${row.contractId}`}
                    />
                  </td>
                  <td className="px-3 py-3 tabular-nums" data-testid={`currency-mismatch-currencies-${row.contractId}`}>
                    {t('contracts.currencyMismatches.currencyPair', {
                      contractCurrency: row.contractCurrencyCode,
                      orgCurrency: row.orgCurrencyCode,
                    })}
                  </td>
                  <td className="px-3 py-3">{formatDate(row.nextBillingAt)}</td>
                  <td className="px-3 py-3" data-testid={`currency-mismatch-eligibility-${row.contractId}`}>
                    <span className={row.activeChangeEligible ? 'text-success' : 'text-muted-foreground'}>
                      {eligibilityLabel(row)}
                    </span>
                    {row.blockingDraftInvoiceIds.length > 0 && (
                      <span className="ml-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                        {t('contracts.currencyMismatches.blockingDrafts', { count: row.draftMonetaryInvoiceCount })}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {nextCursor && (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loadingMore}
          data-testid="currency-mismatches-load-more"
          className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {loadingMore ? t('contracts.currencyMismatches.loading') : t('contracts.currencyMismatches.loadMore')}
        </button>
      )}
    </div>
  );
}
