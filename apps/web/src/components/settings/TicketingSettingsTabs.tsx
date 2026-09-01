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
import TicketFormsCard from './TicketFormsCard';
import TimeTrackingSettingsCard from './TimeTrackingSettingsCard';
import { useJwtClaims } from '../../lib/authScope';
import { usePermissions } from '../../lib/permissions';

const VALID_TABS = ['statuses', 'priorities', 'categories', 'forms', 'export', 'inbound', 'canned', 'timeTracking'] as const;
type Tab = (typeof VALID_TABS)[number];

// The sub-tabs that only exist for partner-scoped users. The tab list is BUILT
// from this and the pending-placeholder gate reads its ids, so those two cannot
// drift. The three panel bodies are still written out individually — each
// mounts a different card — and share the one `canManageInbound` gate rather
// than this list.
//
// Inbound email settings + queue are a partner-scoped surface (the queue routes
// are additionally admin-gated server-side). The mailbox card has a separate
// ticket_mailbox:read UX gate; every API route remains authoritative.
const PARTNER_ONLY_TABS: Array<{ id: Tab; labelKey: string }> = [
  { id: 'forms', labelKey: 'ticketingSettingsTabs.intakeForms' },
  { id: 'inbound', labelKey: 'ticketingSettingsTabs.inboundEmail' },
  { id: 'canned', labelKey: 'ticketingSettingsTabs.cannedResponses' },
  // W06 (#3900). Partner-only for the same reason as the three above: the
  // setting it edits is partner-wide and PATCH /orgs/partners/me requires
  // partner scope server-side.
  { id: 'timeTracking', labelKey: 'ticketingSettingsTabs.timeTracking' }
];
const PARTNER_ONLY_TAB_IDS: readonly Tab[] = PARTNER_ONLY_TABS.map((tab) => tab.id);

// Shown to every scope. The partner-only tabs above are appended to these.
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
  const { can } = usePermissions();
  const canReadMailbox = can('ticket_mailbox', 'read');

  // Gate Inbound Email, Intake Forms and Canned Responses on partner scope
  // (matching how the Sidebar gates other partner-only settings surfaces): all
  // three have CRUD routes that require partner scope server-side, and intake
  // forms can be authored partner-wide ("All orgs"). BASE_TABS renders for any
  // scope, so these three are added on top rather than gated out of it.
  // Decoded client-side as a UX hint only — the server re-checks every request,
  // and org-owned forms are still creatable here via the form editor's org
  // selector.
  //
  // THREE states, not two (#4013). Access tokens are deliberately never
  // persisted (`partialize` in stores/auth.ts keeps only `user` +
  // `isAuthenticated`), so on every cold load the store is empty and EVERY user
  // decodes as `scope: null`. `'unresolved'` therefore means "not known yet",
  // never "denied". It also has to stay REACTIVE: this was a
  // `useMemo(() => getJwtClaims().scope === 'partner', [])`, which froze the
  // empty-store answer for the life of the mount and so hid all three
  // partner-only tabs, permanently, from any partner user who landed here
  // directly — which is exactly what the permanent `/settings/ticketing` → 301
  // and the M365 consent return both do.
  const jwt = useJwtClaims();
  const inboundAccess: 'unresolved' | 'allowed' | 'denied' =
    jwt.status === 'unresolved' ? 'unresolved' : jwt.claims.scope === 'partner' ? 'allowed' : 'denied';
  // Both non-'allowed' states fail closed for rendering — an unknown scope is
  // never treated as a grant. What they must NOT share is the *explanation*:
  // 'denied' is a settled answer, 'unresolved' is a pending one, and only the
  // latter gets the placeholder below. Nothing here writes the URL or discards
  // state, so there is no #4010-style destructive branch to defer.
  const canManageInbound = inboundAccess === 'allowed';
  const TABS = useMemo(
    () =>
      [...BASE_TABS, ...(canManageInbound ? PARTNER_ONLY_TABS : [])].map((tab) => ({
        ...tab,
        label: t(/* i18n-dynamic */ tab.labelKey)
      })),
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

      {/* Deep-linked onto a partner-only sub-tab before the scope is known (a
          `#tab=` link, or `initialTab='inbound'` from PartnerSettingsPage on the
          M365 consent return): say the answer is pending rather than render an
          unexplained blank body.
          On an ordinary cold load this is rarely what the user is looking at —
          AuthOverlay masks the whole window while the access token is absent
          (`shouldHide` requires `tokens?.accessToken`). Keep it regardless: it
          is the ONLY DOM difference between 'unresolved' and 'denied', so
          without it nothing would notice a future "simplification" back to a
          boolean; and it is the sole cue on the one path AuthOverlay does not
          re-arm for — a token cleared after the overlay has already faded out
          for this mount.
          A settled 'denied' still renders nothing, as before. That leaves a
          pre-existing gap (an org user who hand-crafts `#tab=inbound` gets a
          blank body rather than "no access"), deliberately untouched here: it
          is not what #4013 broke. */}
      {inboundAccess === 'unresolved' && PARTNER_ONLY_TAB_IDS.includes(activeTab) && (
        <div data-testid="ticketing-tab-panel-pending" className="text-sm text-muted-foreground">
          {t('ticketingSettingsTabs.checkingAccess')}
        </div>
      )}

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

      {activeTab === 'timeTracking' && canManageInbound && (
        <div data-testid="ticketing-tab-panel-timeTracking">
          <TimeTrackingSettingsCard />
        </div>
      )}

      {activeTab === 'forms' && canManageInbound && (
        <div data-testid="ticketing-tab-panel-forms">
          <TicketFormsCard />
        </div>
      )}

      {activeTab === 'export' && <BillablesExportCard />}

      {activeTab === 'inbound' && canManageInbound && (
        <div data-testid="ticketing-tab-panel-inbound" className="space-y-6">
          <InboundEmailCard />
          {canReadMailbox ? <M365MailboxCard /> : null}
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
