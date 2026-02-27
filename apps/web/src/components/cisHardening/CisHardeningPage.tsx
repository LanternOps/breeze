import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '@/stores/auth';
import CisSummaryCards from './CisSummaryCards';
import CisComplianceTab from './CisComplianceTab';
import CisBaselinesTab from './CisBaselinesTab';
import CisRemediationsTab from './CisRemediationsTab';
import type { CisSummary } from './types';

const tabs = ['Compliance', 'Baselines', 'Remediations'] as const;
type Tab = (typeof tabs)[number];

export default function CisHardeningPage() {
  const [activeTab, setActiveTab] = useState<Tab>('Compliance');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [summary, setSummary] = useState<CisSummary | null>(null);
  const [baselinesCount, setBaselinesCount] = useState(0);
  const [pendingRemediations, setPendingRemediations] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);

  const fetchSummary = useCallback(async () => {
    setError(undefined);
    setLoading(true);
    try {
      const [complianceRes, baselinesRes, remediationsRes] = await Promise.all([
        fetchWithAuth('/cis/compliance?limit=1'),
        fetchWithAuth('/cis/baselines?active=true&limit=1'),
        fetchWithAuth('/cis/remediations?status=pending_approval&limit=1'),
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
      setError(err instanceof Error ? err.message : 'Failed to load CIS data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary, refreshKey]);

  const handleRefresh = () => setRefreshKey((k) => k + 1);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-xl font-semibold">CIS Hardening</h2>
          <p className="text-sm text-muted-foreground">
            Configuration baselines, compliance scoring, and remediation tracking.
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={loading}
          className="inline-flex h-9 items-center gap-2 rounded-md border bg-background px-3 text-sm hover:bg-muted disabled:opacity-60"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
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
                  {tab}
                </button>
              ))}
            </nav>
          </div>

          {activeTab === 'Compliance' && <CisComplianceTab refreshKey={refreshKey} />}
          {activeTab === 'Baselines' && <CisBaselinesTab refreshKey={refreshKey} onMutate={handleRefresh} />}
          {activeTab === 'Remediations' && <CisRemediationsTab refreshKey={refreshKey} />}
        </>
      )}
    </div>
  );
}
