import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { handleActionError, runAction } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';

interface DomainRow {
  id: string;
  domain: string;
  orgId: string;
  orgName: string;
  autoCreateContact: boolean;
  isActive: boolean;
}

interface OrgOption {
  id: string;
  name: string;
}

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

export function CustomerDomainsCard() {
  const { t } = useTranslation('settings');
  const loadErrorMessage = t('customerDomainsCard.errors.load');
  const saveErrorMessage = t('customerDomainsCard.errors.save');
  const [rows, setRows] = useState<DomainRow[]>([]);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [domain, setDomain] = useState('');
  const [orgId, setOrgId] = useState('');
  const [autoCreateContact, setAutoCreateContact] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadRows = useCallback(async () => {
    const res = await fetchWithAuth('/ticket-config/inbound-domains');
    if (!res.ok) {
      setError(true);
      return;
    }
    const body = (await res.json()) as { data?: DomainRow[] };
    setRows(body.data ?? []);
  }, []);

  const loadOrgs = useCallback(async () => {
    const res = await fetchWithAuth('/orgs/organizations?limit=100');
    if (!res.ok) {
      setError(true);
      return;
    }
    const body = (await res.json()) as { data?: OrgOption[] };
    const nextOrgs = body.data ?? [];
    setOrgs(nextOrgs);
    setOrgId((current) => current || nextOrgs[0]?.id || '');
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      await Promise.all([loadRows(), loadOrgs()]);
    } catch {
      setError(true);
    }
    setLoading(false);
  }, [loadRows, loadOrgs]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const addDomain = useCallback(async () => {
    const trimmedDomain = domain.trim();
    if (!trimmedDomain || !orgId) return;
    setSaving(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth('/ticket-config/inbound-domains', {
            method: 'POST',
            body: JSON.stringify({ domain: trimmedDomain, orgId, autoCreateContact }),
          }),
        errorFallback: saveErrorMessage,
        successMessage: t('customerDomainsCard.toasts.added'),
        onUnauthorized: UNAUTHORIZED,
      });
      setDomain('');
      setAutoCreateContact(true);
      await loadRows();
    } catch (err) {
      handleActionError(err, saveErrorMessage);
    } finally {
      setSaving(false);
    }
  }, [autoCreateContact, domain, loadRows, orgId, saveErrorMessage, t]);

  const updateRow = useCallback(
    async (id: string, patch: Partial<Pick<DomainRow, 'autoCreateContact' | 'isActive'>>) => {
      setSaving(true);
      try {
        await runAction({
          request: () =>
            fetchWithAuth(`/ticket-config/inbound-domains/${id}`, {
              method: 'PATCH',
              body: JSON.stringify(patch),
            }),
          errorFallback: saveErrorMessage,
          successMessage: t('customerDomainsCard.toasts.saved'),
          onUnauthorized: UNAUTHORIZED,
        });
        await loadRows();
      } catch (err) {
        handleActionError(err, saveErrorMessage);
      } finally {
        setSaving(false);
      }
    },
    [loadRows, saveErrorMessage, t],
  );

  const removeRow = useCallback(
    async (id: string) => {
      setSaving(true);
      try {
        await runAction({
          request: () =>
            fetchWithAuth(`/ticket-config/inbound-domains/${id}`, {
              method: 'DELETE',
            }),
          errorFallback: saveErrorMessage,
          successMessage: t('customerDomainsCard.toasts.deleted'),
          onUnauthorized: UNAUTHORIZED,
        });
        await loadRows();
      } catch (err) {
        handleActionError(err, saveErrorMessage);
      } finally {
        setSaving(false);
      }
    },
    [loadRows, saveErrorMessage, t],
  );

  return (
    <section className="rounded-lg border p-4" data-testid="customer-domains-card">
      <h2 className="mb-1 text-sm font-semibold">{t('customerDomainsCard.title')}</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        {t('customerDomainsCard.description')}
      </p>

      {loading ? (
        <p className="text-sm text-muted-foreground" data-testid="customer-domains-loading">
          {t('common:states.loading')}
        </p>
      ) : error ? (
        <p className="text-sm text-muted-foreground" data-testid="customer-domains-error">
          {loadErrorMessage}{' '}
          <button
            type="button"
            onClick={() => void loadAll()}
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
                <th className="px-2 py-2 font-medium">{t('customerDomainsCard.columns.autoCreateContact')}</th>
                <th className="px-2 py-2 font-medium">{t('common:states.active')}</th>
                <th className="px-2 py-2 font-medium">
                  <span className="sr-only">{t('common:labels.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row) => (
                <tr key={row.id} data-testid={`customer-domain-row-${row.id}`}>
                  <td className="px-2 py-2 font-medium">{row.domain}</td>
                  <td className="px-2 py-2">{row.orgName}</td>
                  <td className="px-2 py-2">
                    <input
                      type="checkbox"
                      checked={row.autoCreateContact}
                      disabled={saving}
                      onChange={(e) => void updateRow(row.id, { autoCreateContact: e.target.checked })}
                      data-testid={`customer-domain-auto-create-${row.id}`}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <input
                      type="checkbox"
                      checked={row.isActive}
                      disabled={saving}
                      onChange={(e) => void updateRow(row.id, { isActive: e.target.checked })}
                      data-testid={`customer-domain-active-${row.id}`}
                    />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => void removeRow(row.id)}
                      disabled={saving}
                      className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                      data-testid={`customer-domain-delete-${row.id}`}
                    >
                      {t('common:actions.delete')}
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td className="px-2 py-3 text-muted-foreground" colSpan={5}>
                    {t('customerDomainsCard.empty')}
                  </td>
                </tr>
              )}
              <tr data-testid="customer-domain-add-row">
                <td className="px-2 py-2">
                  <input
                    type="text"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    placeholder={t('customerDomainsCard.placeholders.domain')}
                    className="w-full rounded-md border bg-background px-2 py-1 text-sm"
                    data-testid="customer-domain-input"
                  />
                </td>
                <td className="px-2 py-2">
                  <select
                    value={orgId}
                    onChange={(e) => setOrgId(e.target.value)}
                    className="w-full rounded-md border bg-background px-2 py-1 text-sm"
                    data-testid="customer-domain-org"
                  >
                    <option value="">{t('customerDomainsCard.placeholders.organization')}</option>
                    {orgs.map((org) => (
                      <option key={org.id} value={org.id}>
                        {org.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-2 py-2">
                  <input
                    type="checkbox"
                    checked={autoCreateContact}
                    onChange={(e) => setAutoCreateContact(e.target.checked)}
                    data-testid="customer-domain-auto-create"
                  />
                </td>
                <td className="px-2 py-2 text-muted-foreground">{t('customerDomainsCard.new')}</td>
                <td className="px-2 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => void addDomain()}
                    disabled={saving || !domain.trim() || !orgId}
                    className="rounded-md bg-primary px-2.5 py-1 text-sm text-white disabled:opacity-50"
                    data-testid="customer-domain-add"
                  >
                    {t('customerDomainsCard.actions.addDomain')}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
