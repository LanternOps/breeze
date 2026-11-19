import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authNext';
import { stateBadgeClass, stateLabel } from './orgDomains/labels';
import { DOMAIN_VERIFICATION_METHODS, orgDomainsHref, type CustomerDomainView, type DomainVerificationMethod } from './orgDomains/types';

/**
 * One row of `GET /ticket-config/inbound-domains`. The verification fields are
 * additive (portal registration W5); an older API sends none, which reads as
 * a declared row.
 */
interface DomainRow {
  id: string;
  domain: string;
  orgId: string;
  orgName: string;
  state?: CustomerDomainView['state'];
  method?: DomainVerificationMethod | null;
}

function rowState(row: DomainRow): Pick<CustomerDomainView, 'state' | 'method'> {
  const method = row.method && (DOMAIN_VERIFICATION_METHODS as readonly string[]).includes(row.method) ? row.method : null;
  if (row.state === 'verified' && method) return { state: 'verified', method };
  if (row.state === 'pending_dns') return { state: 'pending_dns', method: null };
  return { state: 'declared', method: null };
}

/**
 * Ticketing › Email: a read-only, partner-wide summary of customer email
 * domains. Domains are managed per organization, under Organization › Domains
 * (W5, spec §5.4 / §9 Q3: one home for the concept); each row links there.
 */
export function CustomerDomainsCard() {
  const { t } = useTranslation('settings');
  const [rows, setRows] = useState<DomainRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetchWithAuth('/ticket-config/inbound-domains');
      if (res.status === 401) {
        void navigateTo(loginPathWithNext(), { replace: true });
        return;
      }
      if (!res.ok) throw new Error(`inbound domains load failed: ${res.status}`);
      const body = (await res.json()) as { data?: DomainRow[] };
      if (!Array.isArray(body.data)) throw new Error('inbound domains load returned an unexpected body');
      setRows(body.data);
    } catch (err) {
      console.error('[CustomerDomainsCard] load failed', err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="rounded-lg border p-4" data-testid="customer-domains-card">
      <h2 className="mb-1 text-sm font-semibold">{t('customerDomainsCard.title')}</h2>
      <p className="mb-3 text-xs text-muted-foreground" data-testid="customer-domains-managed-per-org">
        {t('customerDomainsCard.managedPerOrg')}
      </p>

      {loading ? (
        <p className="text-sm text-muted-foreground" data-testid="customer-domains-loading">
          {t('common:states.loading')}
        </p>
      ) : error ? (
        <p className="text-sm text-muted-foreground" data-testid="customer-domains-error">
          {t('customerDomainsCard.errors.load')}{' '}
          <button
            type="button"
            onClick={() => void load()}
            className="underline hover:text-foreground"
            data-testid="customer-domains-retry"
          >
            {t('common:actions.retry')}
          </button>
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-2 py-2 font-medium">{t('customerDomainsCard.columns.domain')}</th>
                <th className="px-2 py-2 font-medium">{t('common:labels.organization')}</th>
                <th className="px-2 py-2 font-medium">{t('customerDomainsCard.columns.status')}</th>
                <th className="px-2 py-2 font-medium">
                  <span className="sr-only">{t('common:labels.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row) => {
                const state = rowState(row);
                return (
                  <tr key={row.id} data-testid={`customer-domain-row-${row.id}`}>
                    <td className="px-2 py-2 font-medium">{row.domain}</td>
                    <td className="px-2 py-2">{row.orgName}</td>
                    <td className="px-2 py-2">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${stateBadgeClass(state.state)}`}
                        data-testid={`customer-domain-state-${row.id}`}
                      >
                        {stateLabel(t, state)}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right">
                      <a
                        href={orgDomainsHref(row.orgId)}
                        className="text-primary hover:underline"
                        data-testid={`customer-domain-manage-${row.id}`}
                      >
                        {t('customerDomainsCard.actions.manage')}
                      </a>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td className="px-2 py-3 text-muted-foreground" colSpan={4}>
                    {t('customerDomainsCard.emptySummary')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
