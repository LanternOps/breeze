import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useHashTab } from '@/lib/useHashState';
import MonitoringAssetsDashboard from './MonitoringAssetsDashboard';
import NetworkMonitorList from '../monitors/NetworkMonitorList';
import SNMPTemplateList from '../snmp/SNMPTemplateList';
import SNMPTemplateEditor from '../snmp/SNMPTemplateEditor';
// Initializes the shared i18next singleton. Islands hydrate independently, so
// an island that hydrates before whichever other island happens to pull i18n in
// would otherwise render raw keys (and mismatch the SSR markup).
import '../../lib/i18n';

const MONITORING_TABS = ['assets', 'checks', 'templates'] as const;
type MonitoringTab = (typeof MONITORING_TABS)[number];

export default function MonitoringPage() {
  const { t } = useTranslation('common');
  // SSR-safe hash tab (#2421): starts at the default, adopts the hash post-mount.
  const [activeTab, setActiveTab] = useHashTab<MonitoringTab>(MONITORING_TABS, 'assets');
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | undefined>(undefined);
  const [templateRefreshToken, setTemplateRefreshToken] = useState(0);
  const [initialAssetId, setInitialAssetId] = useState<string | null>(null);

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
    assets: t('longTail.monitoring.MonitoringPage.tabs.assets'),
    checks: t('longTail.monitoring.MonitoringPage.tabs.checks'),
    templates: t('longTail.monitoring.MonitoringPage.tabs.templates')
  };
  const tabButtons = MONITORING_TABS.map((id) => ({ id, label: tabLabels[id] }));

  const navigateToTab = useCallback((tab: MonitoringTab) => {
    if (typeof window !== 'undefined') window.location.hash = tab;
    setActiveTab(tab);
  }, [setActiveTab]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t('longTail.monitoring.MonitoringPage.title')}</h1>
        <p className="text-muted-foreground">
          {t('longTail.monitoring.MonitoringPage.description')}
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
