import { useCallback, useEffect, useState } from 'react';
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
const LOAD_ERROR = 'Customer domain mappings failed to load.';
const SAVE_ERROR = 'Could not save customer domain mapping. Retry.';

export function CustomerDomainsCard() {
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
        errorFallback: SAVE_ERROR,
        successMessage: 'Customer domain mapping added',
        onUnauthorized: UNAUTHORIZED,
      });
      setDomain('');
      setAutoCreateContact(true);
      await loadRows();
    } catch (err) {
      handleActionError(err, SAVE_ERROR);
    } finally {
      setSaving(false);
    }
  }, [autoCreateContact, domain, loadRows, orgId]);

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
          errorFallback: SAVE_ERROR,
          successMessage: 'Customer domain mapping saved',
          onUnauthorized: UNAUTHORIZED,
        });
        await loadRows();
      } catch (err) {
        handleActionError(err, SAVE_ERROR);
      } finally {
        setSaving(false);
      }
    },
    [loadRows],
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
          errorFallback: SAVE_ERROR,
          successMessage: 'Customer domain mapping deleted',
          onUnauthorized: UNAUTHORIZED,
        });
        await loadRows();
      } catch (err) {
        handleActionError(err, SAVE_ERROR);
      } finally {
        setSaving(false);
      }
    },
    [loadRows],
  );

  return (
    <section className="rounded-lg border p-4" data-testid="customer-domains-card">
      <h2 className="mb-1 text-sm font-semibold">Customer email domains</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Route verified customer email domains to the right organization.
      </p>

      {loading ? (
        <p className="text-sm text-muted-foreground" data-testid="customer-domains-loading">
          Loading.
        </p>
      ) : error ? (
        <p className="text-sm text-muted-foreground" data-testid="customer-domains-error">
          {LOAD_ERROR}{' '}
          <button
            type="button"
            onClick={() => void loadAll()}
            className="underline hover:text-foreground"
            data-testid="customer-domains-retry"
          >
            Retry
          </button>
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-2 py-2 font-medium">Domain</th>
                <th className="px-2 py-2 font-medium">Organization</th>
                <th className="px-2 py-2 font-medium">Auto-create contact</th>
                <th className="px-2 py-2 font-medium">Active</th>
                <th className="px-2 py-2 font-medium">
                  <span className="sr-only">Actions</span>
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
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td className="px-2 py-3 text-muted-foreground" colSpan={5}>
                    No customer domain mappings yet.
                  </td>
                </tr>
              )}
              <tr data-testid="customer-domain-add-row">
                <td className="px-2 py-2">
                  <input
                    type="text"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    placeholder="customer.example.com"
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
                    <option value="">Select organization...</option>
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
                <td className="px-2 py-2 text-muted-foreground">New</td>
                <td className="px-2 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => void addDomain()}
                    disabled={saving || !domain.trim() || !orgId}
                    className="rounded-md bg-primary px-2.5 py-1 text-sm text-white disabled:opacity-50"
                    data-testid="customer-domain-add"
                  >
                    Add domain
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
