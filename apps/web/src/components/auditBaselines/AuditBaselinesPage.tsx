import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { BarChart3, ListChecks, ShieldCheck } from 'lucide-react';
import { useHashTab } from '@/lib/useHashState';
import { OverflowTabs, type OverflowTab } from '@/components/shared/OverflowTabs';
import ComplianceDashboard from './ComplianceDashboard';
import BaselineList from './BaselineList';
import BaselineApplyTab from './BaselineApplyTab';

const tabs = [
  { id: 'dashboard', labelKey: 'dashboard', icon: BarChart3 },
  { id: 'baselines', labelKey: 'baselines', icon: ListChecks },
  { id: 'approvals', labelKey: 'approvals', icon: ShieldCheck },
] as const;

type TabId = (typeof tabs)[number]['id'];

const TAB_IDS = tabs.map((tab) => tab.id);

export default function AuditBaselinesPage() {
  const { t } = useTranslation('security');
  // SSR-safe hash tab (#2421): starts at the default, adopts the hash post-mount.
  const [activeTab, setActiveTab] = useHashTab<TabId>(TAB_IDS, 'dashboard');

  const handleTabChange = (id: TabId) => {
    setActiveTab(id);
    window.location.hash = id;
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t('auditBaselinesAuditBaselinesPage.title')}</h1>
        <p className="text-muted-foreground">
          {t('auditBaselinesAuditBaselinesPage.description')}
        </p>
      </div>

      <OverflowTabs
        tabs={tabs.map((tab): OverflowTab => ({
          id: tab.id,
          label: t(/* i18n-dynamic */ `auditBaselinesAuditBaselinesPage.tabs.${tab.labelKey}`),
          icon: <tab.icon className="h-4 w-4" />,
        }))}
        activeTab={activeTab}
        onTabChange={(id) => handleTabChange(id as TabId)}
        testIdPrefix="audit-baselines-tab-"
      />

      {activeTab === 'dashboard' && <ComplianceDashboard />}
      {activeTab === 'baselines' && <BaselineList />}
      {activeTab === 'approvals' && <BaselineApplyTab mode="approvals-only" />}
    </div>
  );
}
