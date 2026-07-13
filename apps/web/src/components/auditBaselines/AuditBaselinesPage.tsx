import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { BarChart3, ListChecks, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useHashTab } from '@/lib/useHashState';
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

      <div className="flex gap-1 rounded-lg border bg-muted/40 p-1">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => handleTabChange(tab.id)}
              className={cn(
                'flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon className="h-4 w-4" />
              {t(/* i18n-dynamic */ `auditBaselinesAuditBaselinesPage.tabs.${tab.labelKey}`)}
            </button>
          );
        })}
      </div>

      {activeTab === 'dashboard' && <ComplianceDashboard />}
      {activeTab === 'baselines' && <BaselineList />}
      {activeTab === 'approvals' && <BaselineApplyTab mode="approvals-only" />}
    </div>
  );
}
