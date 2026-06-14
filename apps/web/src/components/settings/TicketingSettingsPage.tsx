import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import TicketCategoriesPage from './TicketCategoriesPage';
import BillablesExportCard from './BillablesExportCard';
import TicketStatusesTab from './TicketStatusesTab';
import TicketPrioritiesTab from './TicketPrioritiesTab';
import InboundEmailCard from './InboundEmailCard';
import { getJwtClaims } from '../../lib/authScope';

const VALID_TABS = ['statuses', 'priorities', 'categories', 'export', 'inbound'] as const;
type Tab = (typeof VALID_TABS)[number];

// Inbound email settings + queue are a partner-scoped surface (the queue routes
// are additionally admin-gated server-side). We have no synchronous fine-grained
// capability on the client, so gate the tab on partner scope — any partner user
// can use the settings; the card's own 403 handler is the defense-in-depth
// backstop that hides the queue for non-admins reached directly via hash.
const BASE_TABS: Array<{ id: Tab; label: string }> = [
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
  // Seed the SSR-safe default ('statuses') so the first client render matches the
  // server (which has no hash); the deep-linked #tab= is applied in the mount
  // effect below. Reading the hash directly into useState caused a hydration
  // mismatch on `/settings/ticketing#tab=export` (same class as the login #418).
  const [activeTab, setActiveTab] = useState<Tab>('statuses');

  // Render the Inbound Email tab only for partner-scoped users (matches how the
  // Sidebar gates other partner-only settings surfaces). Decoded client-side as
  // a UX hint only — the server re-checks every request.
  const canManageInbound = useMemo(() => getJwtClaims().scope === 'partner', []);
  const TABS = useMemo(
    () => (canManageInbound ? [...BASE_TABS, { id: 'inbound' as Tab, label: 'Inbound Email' }] : BASE_TABS),
    [canManageInbound]
  );

  const switchTab = (tab: Tab) => {
    history.replaceState(null, '', hashFor(tab));
    setActiveTab(tab);
  };

  useEffect(() => {
    setActiveTab(parseHash());
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

      {activeTab === 'inbound' && canManageInbound && (
        <div data-testid="ticketing-tab-panel-inbound">
          <InboundEmailCard />
        </div>
      )}
    </div>
  );
}
