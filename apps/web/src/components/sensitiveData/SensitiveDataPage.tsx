import '@/lib/i18n';
import { useEffect } from 'react';
import { useHashState } from '@/lib/useHashState';
import { keepHashAcrossOrgSwitch } from '@/lib/orgSwitch';
import { ScanSearch } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import DashboardTab from './DashboardTab';
import FindingsTab from './FindingsTab';
import ScansTab from './ScansTab';
import PoliciesTab from './PoliciesTab';

type Tab = 'dashboard' | 'findings' | 'scans' | 'policies';

const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'findings', label: 'Findings' },
  { id: 'scans', label: 'Scans' },
  { id: 'policies', label: 'Policies' },
];

const isTab = (hash: string): hash is Tab => TABS.some((tab) => tab.id === hash);

export default function SensitiveDataPage() {
  const { t } = useTranslation('security');
  // SSR-safe hash tab (#2421): starts at the default, adopts the hash post-mount.
  const [activeTab, setActiveTab] = useHashState<Tab>('dashboard', (h) => (isTab(h) ? h : undefined));

  // #10083: a header org switch re-renders this page in place. The tab means the
  // same thing in every org, so keep it — only an exact tab id, read at switch
  // time; anything else in the hash is dropped.
  useEffect(
    () =>
      keepHashAcrossOrgSwitch(() => {
        const hash = window.location.hash.replace(/^#/, '');
        return isTab(hash) ? hash : null;
      }),
    [],
  );

  const switchTab = (tab: Tab) => {
    window.location.hash = tab;
    setActiveTab(tab);
  };

  const tabLabel = (tab: Tab) => {
    switch (tab) {
      case 'dashboard':
        return t('sensitiveDataSensitiveDataPage.tabs.dashboard', { defaultValue: 'Dashboard' });
      case 'findings':
        return t('sensitiveDataSensitiveDataPage.tabs.findings', { defaultValue: 'Findings' });
      case 'scans':
        return t('sensitiveDataSensitiveDataPage.tabs.scans', { defaultValue: 'Scans' });
      case 'policies':
        return t('sensitiveDataSensitiveDataPage.tabs.policies', { defaultValue: 'Policies' });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <ScanSearch className="h-6 w-6 text-primary" />
        <h1 className="text-xl font-semibold tracking-tight">
          {t('sensitiveDataSensitiveDataPage.heading', { defaultValue: 'Sensitive Data' })}
        </h1>
      </div>

      <div className="border-b">
        <nav className="-mb-px flex gap-4">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => switchTab(tab.id)}
              className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition ${
                activeTab === tab.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:border-muted-foreground hover:text-foreground'
              }`}
            >
              {tabLabel(tab.id)}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === 'dashboard' && <DashboardTab />}
      {activeTab === 'findings' && <FindingsTab />}
      {activeTab === 'scans' && <ScansTab />}
      {activeTab === 'policies' && <PoliciesTab />}
    </div>
  );
}
