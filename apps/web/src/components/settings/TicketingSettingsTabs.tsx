import { useTranslation } from 'react-i18next';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import TicketCategoriesPage from './TicketCategoriesPage';
import BillablesExportCard from './BillablesExportCard';
import TicketStatusesTab from './TicketStatusesTab';
import TicketPrioritiesTab from './TicketPrioritiesTab';
import InboundEmailCard from './InboundEmailCard';
import M365MailboxCard from './M365MailboxCard';
import CannedResponsesCard from './CannedResponsesCard';
import { getJwtClaims } from '../../lib/authScope';

const VALID_TABS = ['statuses', 'priorities', 'categories', 'export', 'inbound', 'canned'] as const;
type Tab = (typeof VALID_TABS)[number];

// Inbound email settings + queue are a partner-scoped surface (the queue routes
// are additionally admin-gated server-side). We have no synchronous fine-grained
// capability on the client, so gate the tab on partner scope — any partner user
// can use the settings; the card's own 403 handler is the defense-in-depth
// backstop that hides the queue for non-admins reached directly via hash.
const BASE_TABS: Array<{ id: Tab; labelKey: string }> = [
  { id: 'statuses', labelKey: 'ticketingSettingsTabs.statuses' },
  { id: 'priorities', labelKey: 'ticketingSettingsTabs.prioritiesSLAs' },
  { id: 'categories', labelKey: 'ticketingSettingsTabs.categories' },
  { id: 'export', labelKey: 'ticketingSettingsTabs.export' }
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
export default function TicketingSettingsTabs({
  syncHash = true,
  initialTab,
}: {
  syncHash?: boolean;
  initialTab?: Tab;
}) {
  const { t } = useTranslation('settings');
  // `initialTab` seeds the sub-tab deterministically for the embedded (syncHash=false)
  // case — used by the M365 consent deep-link (`?ticketMailbox=…`) so this group opens
  // on Inbound regardless of when it mounts. The parent captures that signal once (it
  // mounts a single time); we must NOT re-read the URL param here because the mailbox
  // card strips it on mount, and this group can remount when the parent's loading state
  // toggles — re-reading would lose the signal (the tab would snap back to Statuses).
  const [activeTab, setActiveTab] = useState<Tab>(initialTab ?? 'statuses');

  // Render the Inbound Email tab only for partner-scoped users (matches how the
  // Sidebar gates other partner-only settings surfaces). Decoded client-side as
  // a UX hint only — the server re-checks every request.
  const canManageInbound = useMemo(() => getJwtClaims().scope === 'partner', []);
  // Canned responses (like inbound) are a partner-scoped surface — the CRUD routes
  // require partner scope server-side — so they share the same client gate.
  const TABS = useMemo(
    () =>
      canManageInbound
        ? [
            ...BASE_TABS.map((tab) => ({ ...tab, label: t(/* i18n-dynamic */ tab.labelKey) })),
            { id: 'inbound' as Tab, labelKey: 'ticketingSettingsTabs.inboundEmail', label: t('ticketingSettingsTabs.inboundEmail') },
            { id: 'canned' as Tab, labelKey: 'ticketingSettingsTabs.cannedResponses', label: t('ticketingSettingsTabs.cannedResponses') }
          ]
        : BASE_TABS.map((tab) => ({ ...tab, label: t(/* i18n-dynamic */ tab.labelKey) })),
    [canManageInbound, t]
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
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => switchTab(tab.id)}
            data-testid={`ticketing-tab-${tab.id}`}
            className={cn(
              'border-b-2 px-4 py-2 text-sm font-medium transition-colors -mb-px',
              activeTab === tab.id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {tab.label}
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
        <div data-testid="ticketing-tab-panel-inbound" className="space-y-6">
          <InboundEmailCard />
          <M365MailboxCard />
        </div>
      )}

      {activeTab === 'canned' && canManageInbound && (
        <div data-testid="ticketing-tab-panel-canned">
          <CannedResponsesCard />
        </div>
      )}
    </div>
  );
}
