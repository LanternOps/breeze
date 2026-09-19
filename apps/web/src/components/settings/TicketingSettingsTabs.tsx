import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import TicketCategoriesPage from './TicketCategoriesPage';
import TicketStatusesTab from './TicketStatusesTab';
import TicketPrioritiesTab from './TicketPrioritiesTab';
import InboundEmailCard from './InboundEmailCard';
import M365MailboxCard from './M365MailboxCard';
import CannedResponsesCard from './CannedResponsesCard';
import TicketFormsCard from './TicketFormsCard';
import TicketChecklistTemplatesPage from './TicketChecklistTemplatesPage';
import TimeTrackingSettingsCard from './TimeTrackingSettingsCard';
import { useJwtClaims } from '../../lib/authScope';
import { usePermissions } from '../../lib/permissions';
import { useHashTab } from '../../lib/useHashState';

export const TICKETING_HUB_TABS = [
  'statuses', 'priorities', 'categories', 'forms', 'email', 'templates', 'timeTracking',
] as const;
export type TicketingHubTab = (typeof TICKETING_HUB_TABS)[number];

// Tabs that require partner scope server-side (Forms/Email/Time capture all
// touch partner-wide config or PATCH /orgs/partners/me). BASE_TABS render for
// any scope.
//
// `templates` is NOT here: TicketChecklistTemplatesPage is a dual-ownership
// (org XOR partner) surface that does its own scope gating internally — an
// org-scoped user creates org-owned checklist templates and never sees the
// owner selector. Gating the whole tab on partner scope regressed that (an
// org-scoped user lost checklist-template management entirely). Only the
// CannedResponsesCard half of this tab's panel is partner-only.
const PARTNER_ONLY_TABS: Array<{ id: TicketingHubTab; labelKey: string }> = [
  { id: 'forms', labelKey: 'ticketingSettingsTabs.intakeForms' },
  { id: 'email', labelKey: 'ticketingSettingsTabs.email' },
  { id: 'timeTracking', labelKey: 'ticketingSettingsTabs.timeCapture' },
];
const PARTNER_ONLY_TAB_IDS: readonly TicketingHubTab[] = PARTNER_ONLY_TABS.map((tab) => tab.id);

const BASE_TABS: Array<{ id: TicketingHubTab; labelKey: string }> = [
  { id: 'statuses', labelKey: 'ticketingSettingsTabs.statuses' },
  { id: 'priorities', labelKey: 'ticketingSettingsTabs.prioritiesSLAs' },
  { id: 'categories', labelKey: 'ticketingSettingsTabs.categories' },
  { id: 'templates', labelKey: 'ticketingSettingsTabs.templates' },
];

/**
 * `/settings/ticketing` — single-level hash tabs, symmetrical with
 * PartnerBillingSettingsPage. Was embedded two-hash-levels deep in the Partner
 * hub (`#ticketing` then `#tab=`); the Partner hub's Ticketing tab is now a
 * link out to this page (see PartnerSettingsPage.tsx). All child components
 * are unchanged imports — only this shell's tab set and hash ownership
 * changed (M0).
 *
 * THREE states, not two (#4013): access tokens are never persisted, so on a
 * cold load every user briefly decodes as `scope: null`. `'unresolved'` means
 * "not known yet", never "denied" — see the pending placeholder below.
 */
export default function TicketingSettingsTabs() {
  const { t } = useTranslation('settings');
  const { can } = usePermissions();
  const canReadMailbox = can('ticket_mailbox', 'read');

  // Renamed from `canManageInbound` (M8): the name predates this tab covering
  // Forms/Email/Templates/Time capture. Local derived const only.
  const jwt = useJwtClaims();
  const inboundAccess: 'unresolved' | 'allowed' | 'denied' =
    jwt.status === 'unresolved' ? 'unresolved' : jwt.claims.scope === 'partner' ? 'allowed' : 'denied';
  const canManagePartnerTicketing = inboundAccess === 'allowed';

  // A `?ticketMailbox=` query param on mount (M365 OAuth consent return) seeds
  // the Email tab even before scope resolves — the replacement for the old
  // parent-owned `initialTab` prop mechanism (see mailboxConnect.ts, which now
  // redirects straight here instead of to the Partner hub's embedded group).
  const [deepLinkMailbox] = useState(
    () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('ticketMailbox')
  );
  const [activeTab, setActiveTab] = useHashTab<TicketingHubTab>(TICKETING_HUB_TABS, deepLinkMailbox ? 'email' : 'statuses');

  const TABS = [...BASE_TABS, ...(canManagePartnerTicketing ? PARTNER_ONLY_TABS : [])].map((tab) => ({
    ...tab,
    label: t(/* i18n-dynamic */ tab.labelKey),
  }));

  const switchTab = (tab: TicketingHubTab) => {
    window.location.hash = tab;
    setActiveTab(tab);
  };

  return (
    <div className="space-y-6">
      <div role="tablist" className="flex flex-wrap gap-1 border-b" data-testid="ticketing-settings-tabs">
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
              activeTab === tab.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {inboundAccess === 'unresolved' && PARTNER_ONLY_TAB_IDS.includes(activeTab) && (
        <div data-testid="ticketing-tab-panel-pending" className="text-sm text-muted-foreground">
          {t('ticketingSettingsTabs.checkingAccess')}
        </div>
      )}

      {activeTab === 'statuses' && (
        <div data-testid="ticketing-tab-panel-statuses"><TicketStatusesTab /></div>
      )}
      {activeTab === 'priorities' && (
        <div data-testid="ticketing-tab-panel-priorities"><TicketPrioritiesTab /></div>
      )}
      {activeTab === 'categories' && <TicketCategoriesPage />}
      {activeTab === 'forms' && canManagePartnerTicketing && (
        <div data-testid="ticketing-tab-panel-forms"><TicketFormsCard /></div>
      )}
      {activeTab === 'email' && canManagePartnerTicketing && (
        <div data-testid="ticketing-tab-panel-email" className="space-y-6">
          <InboundEmailCard />
          {canReadMailbox ? <M365MailboxCard /> : null}
        </div>
      )}
      {activeTab === 'templates' && (
        <div data-testid="ticketing-tab-panel-templates" className="space-y-6">
          {canManagePartnerTicketing && <CannedResponsesCard />}
          <TicketChecklistTemplatesPage />
        </div>
      )}
      {activeTab === 'timeTracking' && canManagePartnerTicketing && (
        <div data-testid="ticketing-tab-panel-timeTracking"><TimeTrackingSettingsCard /></div>
      )}
    </div>
  );
}
