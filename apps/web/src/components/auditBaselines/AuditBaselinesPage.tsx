import { useState, useEffect } from 'react';
import { BarChart3, ListChecks, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import ComplianceDashboard from './ComplianceDashboard';
import BaselineList from './BaselineList';
import BaselineApplyTab from './BaselineApplyTab';

const tabs = [
  { id: 'dashboard', label: 'Dashboard', icon: BarChart3 },
  { id: 'baselines', label: 'Baselines', icon: ListChecks },
  { id: 'approvals', label: 'Approvals', icon: ShieldCheck },
] as const;

type TabId = (typeof tabs)[number]['id'];

export default function AuditBaselinesPage() {
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    if (typeof window !== 'undefined') {
      const hash = window.location.hash.replace('#', '') as TabId;
      if (tabs.some((t) => t.id === hash)) return hash;
    }
    return 'dashboard';
  });

  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash.replace('#', '') as TabId;
      if (tabs.some((t) => t.id === hash)) setActiveTab(hash);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const handleTabChange = (id: TabId) => {
    setActiveTab(id);
    window.location.hash = id;
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Audit Baselines</h1>
        <p className="text-muted-foreground">
          Define compliance baselines, evaluate device drift, and remediate with approval-gated workflows.
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
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
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
