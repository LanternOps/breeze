import { useCallback, useEffect, useState } from 'react';
import MonitoringAssetsDashboard from './MonitoringAssetsDashboard';
import NetworkMonitorList from '../monitors/NetworkMonitorList';
import SNMPTemplateList from '../snmp/SNMPTemplateList';
import SNMPTemplateEditor from '../snmp/SNMPTemplateEditor';

const MONITORING_TABS = ['assets', 'checks', 'templates'] as const;
type MonitoringTab = (typeof MONITORING_TABS)[number];

function getTabFromHash(): MonitoringTab {
  if (typeof window === 'undefined') return 'assets';
  const hash = window.location.hash.replace('#', '');
  if (hash && (MONITORING_TABS as readonly string[]).includes(hash)) {
    return hash as MonitoringTab;
  }
  return 'assets';
}

export default function MonitoringPage() {
  const [activeTab, setActiveTab] = useState<MonitoringTab>(getTabFromHash);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | undefined>(undefined);
  const [templateRefreshToken, setTemplateRefreshToken] = useState(0);
  const [initialAssetId, setInitialAssetId] = useState<string | null>(null);

  // Sync active tab when the hash changes (e.g. back/forward navigation).
  useEffect(() => {
    const onHashChange = () => setActiveTab(getTabFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const assetId = params.get('assetId');
    setInitialAssetId(assetId);
  }, []);

  // Clear initialAssetId after first use so tab switches don't re-apply it.
  useEffect(() => {
    if (initialAssetId) setInitialAssetId(null);
  }, [activeTab]);

  const tabLabels: Record<MonitoringTab, string> = {
    assets: 'Assets',
    checks: 'Network Checks',
    templates: 'SNMP Templates'
  };
  const tabButtons = MONITORING_TABS.map((id) => ({ id, label: tabLabels[id] }));

  const navigateToTab = useCallback((tab: MonitoringTab) => {
    if (typeof window !== 'undefined') window.location.hash = tab;
    setActiveTab(tab);
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Monitoring</h1>
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
        <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
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
