import { useState, useEffect } from 'react';
import { ScanSearch } from 'lucide-react';
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

function getTabFromHash(): Tab {
  if (typeof window === 'undefined') return 'dashboard';
  const hash = window.location.hash.replace('#', '');
  if (TABS.some((t) => t.id === hash)) return hash as Tab;
  return 'dashboard';
}

export default function SensitiveDataPage() {
  const [activeTab, setActiveTab] = useState<Tab>(getTabFromHash);

  useEffect(() => {
    const onHashChange = () => setActiveTab(getTabFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const switchTab = (tab: Tab) => {
    window.location.hash = tab;
    setActiveTab(tab);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <ScanSearch className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold">Sensitive Data Discovery</h1>
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
              {tab.label}
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
