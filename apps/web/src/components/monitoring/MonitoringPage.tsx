import { useCallback, useEffect, useState } from 'react';
import MonitoringAssetsDashboard from './MonitoringAssetsDashboard';
import NetworkMonitorList from '../monitors/NetworkMonitorList';
import SNMPTemplateList from '../snmp/SNMPTemplateList';
import SNMPTemplateEditor from '../snmp/SNMPTemplateEditor';

const MONITORING_TABS = ['assets', 'checks', 'templates'] as const;
type MonitoringTab = (typeof MONITORING_TABS)[number];

function getTabFromURL(): MonitoringTab {
  if (typeof window === 'undefined') return 'assets';
  const params = new URLSearchParams(window.location.search);
  const tab = params.get('tab');
  if (tab && (MONITORING_TABS as readonly string[]).includes(tab)) {
    return tab as MonitoringTab;
  }
  return 'assets';
}

function pushTabToURL(tab: MonitoringTab) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (tab === 'assets') {
    url.searchParams.delete('tab');
  } else {
    url.searchParams.set('tab', tab);
  }
  window.history.pushState({ tab }, '', url.toString());
}

export default function MonitoringPage() {
  const [activeTab, setActiveTab] = useState<MonitoringTab>(getTabFromURL);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | undefined>(undefined);
  const [templateRefreshToken, setTemplateRefreshToken] = useState(0);
  const [initialAssetId, setInitialAssetId] = useState<string | null>(null);

  // Listen for back/forward navigation and query changes.
  useEffect(() => {
    const onPopState = () => setActiveTab(getTabFromURL());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const assetId = params.get('assetId');
    setInitialAssetId(assetId);
  }, []);

  const tabLabels: Record<MonitoringTab, string> = {
    assets: 'Assets',
    checks: 'Network Checks',
    templates: 'SNMP Templates'
  };
  const tabButtons = MONITORING_TABS.map((id) => ({ id, label: tabLabels[id] }));

  const navigateToTab = useCallback((tab: MonitoringTab) => {
    setActiveTab(tab);
    pushTabToURL(tab);
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Monitoring</h1>
        <p className="text-muted-foreground">
          SNMP polling and network checks. Discovery can feed into monitoring, but monitoring is managed here.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {tabButtons.map(tab => (
          <button
            key={tab.id}
            type="button"
            onClick={() => navigateToTab(tab.id)}
            className={`rounded-full border px-4 py-2 text-sm font-medium transition ${
              activeTab === tab.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'assets' && (
        <MonitoringAssetsDashboard
          initialAssetId={initialAssetId}
          onOpenChecks={() => navigateToTab('checks')}
        />
      )}

      {activeTab === 'checks' && <NetworkMonitorList assetId={initialAssetId} />}

      {activeTab === 'templates' && (
        <div className="grid gap-6 xl:grid-cols-[2fr,1fr]">
          <SNMPTemplateList
            selectedTemplateId={selectedTemplateId}
            refreshToken={templateRefreshToken}
            onSelectTemplate={setSelectedTemplateId}
            onCreateTemplate={() => setSelectedTemplateId('')}
          />
          <SNMPTemplateEditor
            selectedTemplateId={selectedTemplateId}
            refreshToken={templateRefreshToken}
            onTemplateSaved={(templateId) => {
              setSelectedTemplateId(templateId);
              setTemplateRefreshToken((value) => value + 1);
            }}
          />
        </div>
      )}
    </div>
  );
}
