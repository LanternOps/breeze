import { useEffect, useState } from 'react';
import { ShieldAlert, Activity } from 'lucide-react';
import S1ThreatList from './S1ThreatList';
import HuntressIncidentList from './HuntressIncidentList';

type EdrTab = 'sentinelone' | 'huntress';

const TABS: { id: EdrTab; label: string; testid: string }[] = [
  { id: 'sentinelone', label: 'SentinelOne Threats', testid: 'edr-tab-sentinelone' },
  { id: 'huntress', label: 'Huntress Incidents', testid: 'edr-tab-huntress' },
];

function tabFromHash(): EdrTab {
  if (typeof window === 'undefined') return 'sentinelone';
  const h = window.location.hash.replace(/^#/, '');
  return h === 'huntress' ? 'huntress' : 'sentinelone';
}

export default function EdrPage() {
  const [activeTab, setActiveTab] = useState<EdrTab>(tabFromHash);

  useEffect(() => {
    const onHash = () => setActiveTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const switchTab = (t: EdrTab) => {
    window.location.hash = t;
    setActiveTab(t);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Endpoint Detection &amp; Response</h1>
        <p className="text-sm text-muted-foreground">
          Threats and incidents across your fleet from SentinelOne and Huntress.
        </p>
      </div>
      <div className="flex gap-2 border-b">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            data-testid={t.testid}
            onClick={() => switchTab(t.id)}
            className={`flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium ${
              activeTab === t.id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.id === 'sentinelone' ? <ShieldAlert className="h-4 w-4" /> : <Activity className="h-4 w-4" />}
            {t.label}
          </button>
        ))}
      </div>
      {activeTab === 'sentinelone' ? <S1ThreatList /> : <HuntressIncidentList />}
    </div>
  );
}
