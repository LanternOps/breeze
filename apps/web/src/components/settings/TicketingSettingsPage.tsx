import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import TicketCategoriesPage from './TicketCategoriesPage';
import BillablesExportCard from './BillablesExportCard';
import TicketStatusesTab from './TicketStatusesTab';
import TicketPrioritiesTab from './TicketPrioritiesTab';

const VALID_TABS = ['statuses', 'priorities', 'categories', 'export'] as const;
type Tab = (typeof VALID_TABS)[number];

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'statuses', label: 'Statuses' },
  { id: 'priorities', label: 'Priorities' },
  { id: 'categories', label: 'Categories' },
  { id: 'export', label: 'Export' }
];

function parseHash(): Tab {
  if (typeof window === 'undefined') return 'statuses';
  for (const part of window.location.hash.replace('#', '').split('&')) {
    if (part.startsWith('tab=')) {
      const value = part.slice('tab='.length);
      if ((VALID_TABS as readonly string[]).includes(value)) return value as Tab;
    }
  }
  return 'statuses';
}

function hashFor(tab: Tab): string {
  return `#tab=${tab}`;
}

export default function TicketingSettingsPage() {
  const [activeTab, setActiveTab] = useState<Tab>(parseHash);

  const switchTab = (tab: Tab) => {
    history.replaceState(null, '', hashFor(tab));
    setActiveTab(tab);
  };

  useEffect(() => {
    const onHashChange = () => setActiveTab(parseHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return (
    <div className="space-y-6" data-testid="ticketing-settings-page">
      <div>
        <h1 className="text-xl font-semibold">Ticketing Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure ticket statuses, priority SLA defaults, categories, and billing exports.
        </p>
      </div>

      <div role="tablist" className="flex gap-1 border-b" data-testid="ticketing-settings-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={activeTab === t.id}
            onClick={() => switchTab(t.id)}
            data-testid={`ticketing-tab-${t.id}`}
            className={cn(
              'border-b-2 px-4 py-2 text-sm font-medium transition-colors -mb-px',
              activeTab === t.id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'statuses' && (
        <div data-testid="ticketing-tab-panel-statuses">
          <TicketStatusesTab />
        </div>
      )}

      {activeTab === 'priorities' && (
        <div data-testid="ticketing-tab-panel-priorities">
          <TicketPrioritiesTab />
        </div>
      )}

      {activeTab === 'categories' && <TicketCategoriesPage />}

      {activeTab === 'export' && <BillablesExportCard />}
    </div>
  );
}
