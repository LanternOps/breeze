import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { Plus, Trash2, ListChecks } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import AddDnsPolicyModal from './AddDnsPolicyModal';

type PolicyType = 'blocklist' | 'allowlist';

interface PolicyDomain {
  domain: string;
  reason?: string;
  addedAt?: string;
  addedBy?: string;
}

interface Policy {
  id: string;
  orgId: string;
  integrationId: string;
  integrationName: string;
  provider: string;
  name: string;
  description: string | null;
  type: PolicyType;
  domains: PolicyDomain[];
  categories: string[] | null;
  isActive: boolean;
  syncStatus: string | null;
  lastSynced: string | null;
}

export default function DnsSecurityPoliciesTab() {
  const { t } = useTranslation('security');
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [domainDraft, setDomainDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const fetchPolicies = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth('/dns-security/policies', { signal });
      if (!res.ok) {
        if (res.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        throw new Error(t('dnsSecurityDnsSecurityPoliciesTab.messages.loadHttpError', { status: res.status }));
      }
      const body = await res.json();
      setPolicies((body.data ?? []) as Policy[]);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : t('dnsSecurityDnsSecurityPoliciesTab.messages.loadFailed'));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchPolicies(controller.signal);
    return () => controller.abort();
  }, [fetchPolicies]);

  /**
   * Apply add/remove changes to a policy's domain list. Both inputs are
   * arrays so a single PATCH can do bulk paste + bulk delete atomically.
   */
  const patchDomains = async (
    policyId: string,
    delta: { add?: PolicyDomain[]; remove?: string[] }
  ): Promise<void> => {
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/dns-security/policies/${policyId}/domains`, {
          method: 'PATCH',
          body: JSON.stringify(delta),
        }),
        errorFallback: t('dnsSecurityDnsSecurityPoliciesTab.messages.updateDomainsFailed'),
        successMessage: t('dnsSecurityDnsSecurityPoliciesTab.messages.domainsUpdated'),
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      await fetchPolicies();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      // runAction already surfaced a toast; nothing else inline.
    } finally {
      setBusy(false);
    }
  };

  /**
   * Add domains from the editor. Accepts a single domain OR a bulk paste
   * (newline / comma / whitespace separated). Trims + filters empties +
   * de-dupes against the existing list before sending.
   */
  const handleAddDomains = async (policy: Policy) => {
    const raw = domainDraft.trim();
    if (!raw) return;
    const existing = new Set(policy.domains.map((d) => d.domain.toLowerCase()));
    const incoming = raw
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0 && s.length <= 500 && !existing.has(s));
    if (incoming.length === 0) {
      setDomainDraft('');
      return;
    }
    await patchDomains(policy.id, {
      add: incoming.map((domain) => ({ domain })),
    });
    setDomainDraft('');
  };

  const handleRemoveDomain = async (policy: Policy, domain: string) => {
    await patchDomains(policy.id, { remove: [domain] });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">{t('dnsSecurityDnsSecurityPoliciesTab.title')}</h2>
        <button
          type="button"
          onClick={() => setShowAddModal(true)}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          {t('dnsSecurityDnsSecurityPoliciesTab.actions.newPolicy')}
        </button>
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 rounded-md border bg-card px-4 py-6 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          {t('dnsSecurityDnsSecurityPoliciesTab.loading')}
        </div>
      ) : policies.length === 0 ? (
        <div className="rounded-md border border-dashed bg-card px-4 py-8 text-center">
          <ListChecks className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">{t('dnsSecurityDnsSecurityPoliciesTab.empty.title')}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('dnsSecurityDnsSecurityPoliciesTab.empty.description')}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {policies.map((policy) => {
            const isExpanded = expandedId === policy.id;
            return (
              <div key={policy.id} className="rounded-md border bg-card">
                <button
                  type="button"
                  onClick={() => {
                    setDomainDraft('');
                    setExpandedId(isExpanded ? null : policy.id);
                  }}
                  className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/30"
                >
                  <div>
                    <div className="text-sm font-medium">
                      {policy.name}{' '}
                      <span
                        className={`ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          policy.type === 'blocklist'
                            ? 'bg-destructive/15 text-destructive'
                            : 'bg-success/15 text-success'
                        }`}
                      >
                        {t(`dnsSecurityDnsSecurityPoliciesTab.policyTypes.${policy.type}`)}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t('dnsSecurityDnsSecurityPoliciesTab.domainCount', {
                        integrationName: policy.integrationName,
                        count: policy.domains.length,
                      })}
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {isExpanded
                      ? t('dnsSecurityDnsSecurityPoliciesTab.actions.hide')
                      : t('dnsSecurityDnsSecurityPoliciesTab.actions.editDomains')}
                  </span>
                </button>

                {isExpanded && (
                  <div className="border-t px-4 py-3 space-y-3">
                    {policy.domains.length === 0 ? (
                      <p className="text-xs text-muted-foreground italic">{t('dnsSecurityDnsSecurityPoliciesTab.noDomains')}</p>
                    ) : (
                      <ul className="space-y-1 max-h-64 overflow-y-auto rounded border bg-muted/20 p-2 text-sm">
                        {policy.domains.map((d) => (
                          <li key={d.domain} className="flex items-center justify-between gap-2 px-2 py-1">
                            <span className="font-mono text-xs">{d.domain}</span>
                            <button
                              type="button"
                              onClick={() => handleRemoveDomain(policy, d.domain)}
                              disabled={busy}
                              className="inline-flex h-6 w-6 items-center justify-center rounded text-destructive hover:bg-destructive/10 disabled:opacity-50"
                              aria-label={t('dnsSecurityDnsSecurityPoliciesTab.actions.removeDomain', { domain: d.domain })}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}

                    <div className="space-y-1">
                      <label className="block text-xs font-medium" htmlFor={`add-domains-${policy.id}`}>
                        {t('dnsSecurityDnsSecurityPoliciesTab.fields.addDomains')}
                        <span className="ml-1 font-normal text-muted-foreground">
                          {t('dnsSecurityDnsSecurityPoliciesTab.addDomainsHelp')}
                        </span>
                      </label>
                      <textarea
                        id={`add-domains-${policy.id}`}
                        rows={3}
                        value={domainDraft}
                        onChange={(e) => setDomainDraft(e.target.value)}
                        placeholder={t('dnsSecurityDnsSecurityPoliciesTab.placeholders.domains')}
                        className="w-full rounded-md border bg-background px-2 py-1.5 font-mono text-xs"
                      />
                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={() => handleAddDomains(policy)}
                          disabled={busy || !domainDraft.trim()}
                          className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          {t('dnsSecurityDnsSecurityPoliciesTab.actions.add')}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showAddModal && (
        <AddDnsPolicyModal
          onClose={() => setShowAddModal(false)}
          onCreated={() => void fetchPolicies()}
        />
      )}
    </div>
  );
}
