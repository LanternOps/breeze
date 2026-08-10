import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { Loader2, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '@/stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import CisSummaryCards from './CisSummaryCards';
import CisComplianceTab from './CisComplianceTab';
import CisBaselinesTab from './CisBaselinesTab';
import CisRemediationsTab from './CisRemediationsTab';
import type { CisSummary } from './types';

const tabs = ['compliance', 'baselines', 'remediations'] as const;
type Tab = (typeof tabs)[number];

export default function CisHardeningPage() {
  const { t } = useTranslation('security');
  // `fetchWithAuth` already appends the selected org to every /cis URL, so the
  // explicit param below is belt-and-braces (it also documents the dependency
  // at the call site). What actually matters is that `currentOrgId` is in the
  // callback deps: the org store hydrates asynchronously, so the first render
  // of a cold session fetches with no org and must re-fetch once one resolves.
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const [activeTab, setActiveTab] = useState<Tab>('compliance');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [summary, setSummary] = useState<CisSummary | null>(null);
  const [baselinesCount, setBaselinesCount] = useState(0);
  const [pendingRemediations, setPendingRemediations] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const fetchSummary = useCallback(async () => {
    setError(undefined);
    setLoading(true);

    // That cold-session re-fetch puts two bursts in flight at once. Without a
    // guard the slower unscoped one can land last and overwrite the org-scoped
    // totals — fleet-wide numbers sitting above a single-org table, sticky
    // until the next manual refresh.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const orgParam = currentOrgId ? `&orgId=${encodeURIComponent(currentOrgId)}` : '';
      const init = { signal: controller.signal };
      const [complianceRes, baselinesRes, remediationsRes] = await Promise.all([
        fetchWithAuth(`/cis/compliance?limit=1${orgParam}`, init),
        fetchWithAuth(`/cis/baselines?active=true&limit=1${orgParam}`, init),
        fetchWithAuth(`/cis/remediations?status=pending_approval&limit=1${orgParam}`, init),
      ]);

      if (!complianceRes.ok) throw new Error(`${complianceRes.status} ${complianceRes.statusText}`);
      if (!baselinesRes.ok) throw new Error(`${baselinesRes.status} ${baselinesRes.statusText}`);
      if (!remediationsRes.ok) throw new Error(`${remediationsRes.status} ${remediationsRes.statusText}`);

      const complianceData = await complianceRes.json();
      const baselinesData = await baselinesRes.json();
      const remediationsData = await remediationsRes.json();

      setSummary(complianceData.summary ?? null);
      setBaselinesCount(baselinesData.pagination?.total ?? 0);
      setPendingRemediations(remediationsData.pagination?.total ?? 0);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : t('cisHardeningCisHardeningPage.messages.loadFailed'));
    } finally {
      // Only the newest request may clear the spinner: an aborted one still
      // runs its `finally`, and clearing there would render the page as loaded
      // while its replacement is still in flight.
      if (abortRef.current === controller) setLoading(false);
    }
    // `t` is deliberately omitted — it changes identity when i18n resources
    // finish loading, which would fire a third redundant burst.
  }, [currentOrgId]);

  useEffect(() => {
    fetchSummary();
    return () => abortRef.current?.abort();
  }, [fetchSummary, refreshKey]);

  const handleRefresh = () => setRefreshKey((k) => k + 1);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-xl font-semibold">{t('cisHardeningCisHardeningPage.title')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('cisHardeningCisHardeningPage.description')}
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={loading}
          className="inline-flex h-9 items-center gap-2 rounded-md border bg-background px-3 text-sm hover:bg-muted disabled:opacity-60"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {t('cisHardeningCisHardeningPage.actions.refresh')}
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading && !summary ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <CisSummaryCards
            summary={summary}
            baselinesCount={baselinesCount}
            pendingRemediations={pendingRemediations}
          />

          <div className="border-b">
            <nav className="-mb-px flex gap-6">
              {tabs.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  className={cn(
                    'border-b-2 pb-3 text-sm font-medium transition-colors',
                    activeTab === tab
                      ? 'border-primary text-primary'
                      : 'border-transparent text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground'
                  )}
                >
                  {t(/* i18n-dynamic */ `cisHardeningCisHardeningPage.tabs.${tab}`)}
                </button>
              ))}
            </nav>
          </div>

          {activeTab === 'compliance' && <CisComplianceTab refreshKey={refreshKey} />}
          {activeTab === 'baselines' && <CisBaselinesTab refreshKey={refreshKey} onMutate={handleRefresh} />}
          {activeTab === 'remediations' && <CisRemediationsTab refreshKey={refreshKey} />}
        </>
      )}
    </div>
  );
}
