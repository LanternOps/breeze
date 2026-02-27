import { useState } from 'react';
import { Usb, ShieldCheck, Activity } from 'lucide-react';
import PeripheralPoliciesList from './PeripheralPoliciesList';
import PeripheralActivityLog from './PeripheralActivityLog';

type Tab = 'policies' | 'activity';

type PeripheralPageProps = {
  defaultTab?: Tab;
};

export default function PeripheralPage({ defaultTab = 'policies' }: PeripheralPageProps) {
  const [activeTab, setActiveTab] = useState<Tab>(defaultTab);

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'policies', label: 'Policies', icon: <ShieldCheck className="h-4 w-4" /> },
    { id: 'activity', label: 'Activity Log', icon: <Activity className="h-4 w-4" /> },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Usb className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold">Peripheral Control</h1>
      </div>

      <div className="border-b">
        <nav className="-mb-px flex gap-4">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition ${
                activeTab === tab.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:border-muted-foreground hover:text-foreground'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === 'policies' && <PeripheralPoliciesList />}
      {activeTab === 'activity' && <PeripheralActivityLog />}
    </div>
  );
}
