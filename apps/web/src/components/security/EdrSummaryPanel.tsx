import { useEffect, useState } from 'react';
import { Activity, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import SecurityStatCard from './SecurityStatCard';

interface S1Summary {
  totalAgents: number;
  mappedDevices: number;
  infectedAgents: number;
  activeThreats: number;
  highOrCriticalThreats: number;
  pendingActions: number;
  reportedThreatCount: number;
}

interface S1Status {
  integration: { id: string } | null;
  summary: S1Summary;
}

interface HuntressStatus {
  integration: { id: string } | null;
  coverage: {
    totalAgents: number;
    mappedAgents: number;
    unmappedAgents: number;
    offlineAgents: number;
  };
  incidents: {
    open: number;
  };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export default function EdrSummaryPanel() {
  const [s1, setS1] = useState<S1Status | null>(null);
  const [huntress, setHuntress] = useState<HuntressStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const [s1Res, huntressRes] = await Promise.allSettled([
        getJson<S1Status>('/s1/status'),
        getJson<HuntressStatus>('/huntress/status')
      ]);

      if (cancelled) return;

      setS1(s1Res.status === 'fulfilled' ? s1Res.value : null);
      setHuntress(
        huntressRes.status === 'fulfilled' ? huntressRes.value : null
      );
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const showS1 = s1?.integration != null;
  const showHuntress = huntress?.integration != null;

  if (loading) {
    return (
      <div
        className="rounded-lg border bg-card p-6 shadow-sm"
        data-testid="edr-summary-panel"
      >
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading EDR posture...
        </div>
      </div>
    );
  }

  if (!showS1 && !showHuntress) return null;

  return (
    <div
      className="rounded-lg border bg-card p-6 shadow-sm"
      data-testid="edr-summary-panel"
    >
      <div className="mb-4 flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-primary" />
        <h3 className="text-lg font-semibold">
          Endpoint Detection &amp; Response
        </h3>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {showS1 && s1 && (
          <>
            <div data-testid="edr-card-s1-active-threats">
              <SecurityStatCard
                icon={ShieldAlert}
                label="SentinelOne Active Threats"
                value={s1.summary.activeThreats}
                variant={s1.summary.activeThreats > 0 ? 'danger' : 'success'}
                detail={`${s1.summary.highOrCriticalThreats} high/critical`}
              />
            </div>
            <div data-testid="edr-card-s1-coverage">
              <SecurityStatCard
                icon={ShieldCheck}
                label="SentinelOne Agents"
                value={`${s1.summary.mappedDevices}/${s1.summary.totalAgents}`}
                detail={`${s1.summary.infectedAgents} infected`}
                variant={s1.summary.infectedAgents > 0 ? 'warning' : 'default'}
              />
            </div>
          </>
        )}

        {showHuntress && huntress && (
          <>
            <div data-testid="edr-card-huntress-open-incidents">
              <SecurityStatCard
                icon={Activity}
                label="Huntress Open Incidents"
                value={huntress.incidents.open}
                variant={huntress.incidents.open > 0 ? 'danger' : 'success'}
              />
            </div>
            <div data-testid="edr-card-huntress-coverage">
              <SecurityStatCard
                icon={ShieldCheck}
                label="Huntress Agents"
                value={`${huntress.coverage.mappedAgents}/${huntress.coverage.totalAgents}`}
                detail={`${huntress.coverage.offlineAgents} offline, ${huntress.coverage.unmappedAgents} unmapped`}
                variant={
                  huntress.coverage.unmappedAgents > 0 ? 'warning' : 'default'
                }
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
