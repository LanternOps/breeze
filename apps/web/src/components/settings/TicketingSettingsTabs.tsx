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

/**
 * Reusable partner-wide ticketing config sub-tab group: Statuses / Priorities /
 * Categories / Export. All four child components are already partner-scoped (no
 * org context), so this renders identically whether mounted on the standalone
 * `/settings/ticketing` page or embedded inside the Partner settings hub.
 *
 * Sub-tab selection is driven by a `#tab=` hash fragment so deep-links survive a
 * page reload. The default is seeded SSR-safe ('statuses') and the deep-linked
 * value is applied in the mount effect to avoid a hydration mismatch (same class
 * as login #418).
 *
 * `syncHash` controls whether sub-tab clicks write back to the URL hash. The
 * standalone page owns the whole hash so it syncs; when embedded under the
 * Partner hub (which owns the top-level tab hash, e.g. `#ticketing`) we leave it
 * off so the two don't fight over `window.location.hash`.
 */
export default function TicketingSettingsTabs({ syncHash = true }: { syncHash?: boolean }) {
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
    if (syncHash) history.replaceState(null, '', hashFor(tab));
    setActiveTab(tab);
  };

  useEffect(() => {
    if (!syncHash) return;
    setActiveTab(parseHash());
    const onHashChange = () => setActiveTab(parseHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [syncHash]);

  return (
    <div className="space-y-6">
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
