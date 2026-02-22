import { useState } from 'react';
import { Package, ShieldCheck } from 'lucide-react';
import SoftwareInventory from './SoftwareInventory';
import ComplianceDashboard from './ComplianceDashboard';

type Tab = 'inventory' | 'policies';

type Prefill = { name: string; vendor?: string; mode?: string };

export default function SoftwarePage({ defaultTab = 'inventory' }: { defaultTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(defaultTab);
  const [prefill, setPrefill] = useState<Prefill | null>(null);

  const handleSwitchToPolicies = (data?: Prefill) => {
    setPrefill(data ?? null);
    setTab('policies');
  };

  const tabs: { key: Tab; label: string; icon: typeof Package }[] = [
    { key: 'inventory', label: 'Inventory', icon: Package },
    { key: 'policies', label: 'Policies', icon: ShieldCheck },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">Software</h1>
          <p className="text-sm text-muted-foreground">
            {tab === 'inventory'
              ? 'Aggregate view of software installed across all managed devices.'
              : 'Enforce allowlist and blocklist controls across managed endpoints.'}
          </p>
        </div>
      </div>

      <div className="flex gap-1 border-b">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => {
              if (t.key !== tab) setPrefill(null);
              setTab(t.key);
            }}
            className={`inline-flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.key
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:border-muted hover:text-foreground'
            }`}
          >
            <t.icon className="h-4 w-4" />
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'inventory' && (
        <SoftwareInventory onSwitchToPolicies={handleSwitchToPolicies} />
      )}
      {tab === 'policies' && (
        <ComplianceDashboard prefill={prefill} />
      )}
    </div>
  );
}
