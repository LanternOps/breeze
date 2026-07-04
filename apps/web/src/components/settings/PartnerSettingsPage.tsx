import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  Building2,
  Globe,
  Loader2,
  LogIn,
  MonitorSmartphone,
  Palette,
  Save,
  ScrollText,
  Shield,
  SlidersHorizontal,
  Ticket,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import TicketingSettingsTabs from './TicketingSettingsTabs';
import SettingsSectionNav from './SettingsSectionNav';
import { fetchWithAuth } from '../../stores/auth';
import { getJwtClaims } from '../../lib/authScope';
import { useOrgStore } from '../../stores/orgStore';
import PartnerSecurityTab, { currentIpCovered } from './PartnerSecurityTab';
import PartnerNotificationsTab from './PartnerNotificationsTab';
import PartnerEventLogsTab from './PartnerEventLogsTab';
import PartnerDefaultsTab from './PartnerDefaultsTab';
import type { PinnableVersions } from './AgentVersionPinSelectors';
import PartnerBrandingTab from './PartnerBrandingTab';
import PartnerAiBudgetsTab from './PartnerAiBudgetsTab';
import PartnerRemoteAccessTab from './PartnerRemoteAccessTab';
import PartnerCompanyTab from './PartnerCompanyTab';
import PartnerRegionalTab, { DEFAULT_BUSINESS_HOURS } from './PartnerRegionalTab';
import LoginBrandingCard from './LoginBrandingCard';
import type {
  PartnerSettings,
  BusinessHoursPreset,
  DateFormat,
  TimeFormat,
  DaySchedule,
  InheritableSecuritySettings,
  InheritableNotificationSettings,
  InheritableEventLogSettings,
  InheritableDefaultSettings,
  InheritableBrandingSettings,
  InheritableAiBudgetSettings,
  InheritableRemoteAccessSettings,
  IpAllowlistStatus
} from '@breeze/shared';
import { isValidMaintenanceWindow, MAINTENANCE_WINDOW_ERROR_MESSAGE } from '@breeze/shared';
import { navigateTo } from '@/lib/navigation';
import { runAction, ActionError } from '@/lib/runAction';

type TabKey = 'company' | 'regional' | 'security' | 'notifications' | 'eventLogs' | 'defaults' | 'branding' | 'loginBranding' | 'aiBudgets' | 'remoteAccess' | 'ticketing';

type Partner = {
  id: string;
  name: string;
  slug: string;
  type: string;
  plan: string;
  // First-class partner timezone column (#1318); the canonical tz default.
  timezone?: string;
  settings: PartnerSettings;
  createdAt: string;
};

type TabDef = {
  key: TabKey;
  /** Canonical URL fragment (kebab-case). Legacy camelCase keys still resolve. */
  hash: string;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Tab persists its own changes; the global Save button does not apply. */
  selfSaving?: boolean;
  /** Values set here are enforced across all organizations (inheritance banner). */
  enforced?: boolean;
};

const TAB_GROUPS: { label: string; tabs: TabDef[] }[] = [
  {
    label: 'Company',
    tabs: [
      { key: 'company', hash: 'company', label: 'Company', description: 'Name, address, contacts', icon: Building2 },
      { key: 'regional', hash: 'regional', label: 'Regional', description: 'Timezone, formats, hours', icon: Globe },
      { key: 'defaults', hash: 'defaults', label: 'Defaults', description: 'Maintenance, agent pins', icon: SlidersHorizontal, enforced: true },
    ],
  },
  {
    label: 'Security & Access',
    tabs: [
      { key: 'security', hash: 'security', label: 'Security', description: 'IP allowlist and access', icon: Shield, enforced: true },
      { key: 'remoteAccess', hash: 'remote-access', label: 'Remote Access', description: 'Remote desktop providers', icon: MonitorSmartphone, enforced: true },
      { key: 'eventLogs', hash: 'event-logs', label: 'Event Logs', description: 'Forwarding and retention', icon: ScrollText, enforced: true },
    ],
  },
  {
    label: 'Communications',
    tabs: [
      { key: 'notifications', hash: 'notifications', label: 'Notifications', description: 'Email and webhook alerts', icon: Bell, enforced: true },
      { key: 'ticketing', hash: 'ticketing', label: 'Ticketing', description: 'Statuses, SLAs, exports', icon: Ticket, selfSaving: true },
      { key: 'aiBudgets', hash: 'ai-budgets', label: 'AI Budgets', description: 'AI spending limits', icon: Wallet, enforced: true },
    ],
  },
  {
    label: 'Branding',
    tabs: [
      { key: 'branding', hash: 'branding', label: 'Branding', description: 'Logo and colors', icon: Palette, enforced: true },
      { key: 'loginBranding', hash: 'login-branding', label: 'Login Branding', description: 'Login page appearance', icon: LogIn, selfSaving: true },
    ],
  },
];

const ALL_TABS: TabDef[] = TAB_GROUPS.flatMap(g => g.tabs);
const TAB_BY_KEY = Object.fromEntries(ALL_TABS.map(t => [t.key, t])) as Record<TabKey, TabDef>;

// Canonical kebab-case fragments plus the legacy camelCase keys this page used
// to write (`#eventLogs`, `#remoteAccess`, ...) so old bookmarks keep working.
const HASH_TO_TAB: Record<string, TabKey> = {};
for (const t of ALL_TABS) {
  HASH_TO_TAB[t.hash] = t.key;
  HASH_TO_TAB[t.key] = t.key;
}

/**
 * Map a top-level URL hash to a partner settings tab. The Ticketing tab is
 * deep-linkable via `/settings/partner#ticketing` (the old `/settings/ticketing`
 * route redirects here), so honor that fragment on first render. Other fragments
 * fall back to the default Company tab. The nested ticketing sub-tab `#tab=…`
 * fragment is intentionally NOT used here — the embedded TicketingSettingsTabs
 * keeps its own local state so the two hash schemes don't collide.
 */
function getTabFromHash(): TabKey | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash.replace('#', '');
  return HASH_TO_TAB[hash] ?? null;
}

// The per-tab keys whose form state participates in dirty tracking. Self-saving
// tabs (Ticketing, Login Branding) persist independently and are never "dirty"
// from this page's perspective.
type SnapshotKey = Exclude<TabKey, 'ticketing' | 'loginBranding'>;
type Snapshot = Record<SnapshotKey, string>;

// Exported for unit-testing without mounting the full component.
export async function runPartnerSave(
  payload: Record<string, unknown>,
  deps: { onUnauthorized: () => void }
): Promise<Partner> {
  return runAction<Partner>({
    request: () => fetchWithAuth('/orgs/partners/me', { method: 'PATCH', body: JSON.stringify(payload) }),
    successMessage: 'Partner settings saved',
    errorFallback: 'Failed to save settings',
    onUnauthorized: deps.onUnauthorized,
  });
}

export default function PartnerSettingsPage() {
  const { currentPartnerId, isLoading: contextLoading, setPartner: setPartnerContext } = useOrgStore();
  const [partner, setPartner] = useState<Partner | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [activeTab, setActiveTab] = useState<TabKey>('company');

  // The M365 consent callback returns to `/settings/partner?ticketMailbox=…#ticketing`.
  // Capture that signal ONCE at mount (this page mounts a single time), before the
  // mailbox card strips the param, so we can deep-link the embedded Ticketing group's
  // Inbound sub-tab deterministically — see TicketingSettingsTabs `initialTab`.
  const [deepLinkTicketMailbox] = useState(
    () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('ticketMailbox')
  );

  // Regional form state
  const [timezone, setTimezone] = useState('UTC');
  const [dateFormat, setDateFormat] = useState<DateFormat>('MM/DD/YYYY');
  const [timeFormat, setTimeFormat] = useState<TimeFormat>('12h');
  const [businessHoursPreset, setBusinessHoursPreset] = useState<BusinessHoursPreset>('business');
  const [customHours, setCustomHours] = useState<Record<string, DaySchedule>>(DEFAULT_BUSINESS_HOURS);
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactWebsite, setContactWebsite] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [address, setAddress] = useState<NonNullable<PartnerSettings['address']>>({});

  // IP allowlist status (drives "Add my current IP" + inactive banner)
  const [ipStatus, setIpStatus] = useState<IpAllowlistStatus | null>(null);
  const [ipStatusUnavailable, setIpStatusUnavailable] = useState(false);

  // Inheritable category state
  const [securityData, setSecurityData] = useState<InheritableSecuritySettings>({});
  const [notificationsData, setNotificationsData] = useState<InheritableNotificationSettings>({});
  const [eventLogsData, setEventLogsData] = useState<InheritableEventLogSettings>({});
  const [defaultsData, setDefaultsData] = useState<InheritableDefaultSettings>({});
  const [brandingData, setBrandingData] = useState<InheritableBrandingSettings>({});
  const [aiBudgetsData, setAiBudgetsData] = useState<InheritableAiBudgetSettings>({});
  const [remoteAccessData, setRemoteAccessData] = useState<InheritableRemoteAccessSettings>({});
  // Registered agent/watchdog versions for the pin selectors (#2124).
  const [pinnableVersions, setPinnableVersions] = useState<PinnableVersions | null>(null);

  // Dirty tracking: a per-tab serialized snapshot of the saveable form state,
  // compared against the baseline captured after fetch (and reset after save).
  // Drives the disabled-when-clean Save button and the per-tab dots in the nav.
  const currentSnapshot: Snapshot = useMemo(() => ({
    company: JSON.stringify({ companyName, address, contactName, contactEmail, contactPhone, contactWebsite }),
    regional: JSON.stringify({ timezone, dateFormat, timeFormat, businessHoursPreset, customHours }),
    security: JSON.stringify(securityData),
    notifications: JSON.stringify(notificationsData),
    eventLogs: JSON.stringify(eventLogsData),
    defaults: JSON.stringify(defaultsData),
    branding: JSON.stringify(brandingData),
    aiBudgets: JSON.stringify(aiBudgetsData),
    remoteAccess: JSON.stringify(remoteAccessData),
  }), [
    companyName, address, contactName, contactEmail, contactPhone, contactWebsite,
    timezone, dateFormat, timeFormat, businessHoursPreset, customHours,
    securityData, notificationsData, eventLogsData, defaultsData, brandingData,
    aiBudgetsData, remoteAccessData,
  ]);
  const [baseline, setBaseline] = useState<Snapshot | null>(null);
  // fetchPartner can't read the state it just set (updates are async), so it
  // raises this flag and the every-render effect below captures the snapshot
  // of the very next render — which reflects the freshly fetched values.
  const baselinePending = useRef(false);
  useEffect(() => {
    if (baselinePending.current) {
      baselinePending.current = false;
      setBaseline(currentSnapshot);
    }
  });

  const dirtyTabs: Partial<Record<TabKey, boolean>> = useMemo(() => {
    if (!baseline) return {};
    const dirty: Partial<Record<TabKey, boolean>> = {};
    for (const key of Object.keys(currentSnapshot) as SnapshotKey[]) {
      dirty[key] = currentSnapshot[key] !== baseline[key];
    }
    return dirty;
  }, [currentSnapshot, baseline]);
  const isDirty = Object.values(dirtyTabs).some(Boolean);

  // Warn before a full navigation away discards unsaved edits.
  useEffect(() => {
    if (!isDirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isDirty]);

  const fetchPartner = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/orgs/partners/me');
      if (!response.ok) {
        if (response.status === 401) { void navigateTo('/login', { replace: true }); return; }
        if (response.status === 403) { setError('You do not have permission to view partner settings'); return; }
        throw new Error('Failed to fetch partner settings');
      }
      const data: Partner = await response.json();
      setPartner(data);
      setCompanyName(data.name || '');

      const settings = data.settings || {};
      // Prefer the legacy JSONB key the UI has always written, then the new
      // first-class `partners.timezone` column (#1318), then UTC.
      setTimezone(settings.timezone || data.timezone || 'UTC');
      setDateFormat(settings.dateFormat || 'MM/DD/YYYY');
      setTimeFormat(settings.timeFormat || '12h');
      setBusinessHoursPreset(settings.businessHours?.preset || 'business');
      if (settings.businessHours?.custom) {
        setCustomHours({ ...DEFAULT_BUSINESS_HOURS, ...settings.businessHours.custom });
      }
      setContactName(settings.contact?.name || '');
      setContactEmail(settings.contact?.email || '');
      setContactPhone(settings.contact?.phone || '');
      setContactWebsite(settings.contact?.website || '');
      setAddress(settings.address || {});

      // Inheritable categories
      setSecurityData(settings.security || {});
      setNotificationsData(settings.notifications || {});
      setEventLogsData(settings.eventLogs || {});
      setDefaultsData(settings.defaults || {});
      setBrandingData(settings.branding || {});
      setAiBudgetsData(settings.aiBudgets || {});
      setRemoteAccessData(settings.remoteAccessProviders || {});

      // Re-baseline dirty tracking against the values that were just fetched.
      baselinePending.current = true;

      // Best-effort: IP allowlist status for the editor (non-blocking). On
      // failure we flag it explicitly so the editor can warn rather than
      // silently hide the inactive banner / lockout confirmation.
      fetchWithAuth('/orgs/partners/me/ip-allowlist/status')
        .then(r => (r.ok ? r.json() : Promise.reject(new Error('status fetch failed'))))
        .then((s: IpAllowlistStatus) => { setIpStatus(s); setIpStatusUnavailable(false); })
        .catch(() => { setIpStatus(null); setIpStatusUnavailable(true); });

      // Best-effort: registered versions for the pin selectors (#2124). On
      // failure the dropdowns simply offer "Latest promoted" only.
      fetchWithAuth('/agent-versions/pinnable')
        .then(r => (r.ok ? r.json() : Promise.reject(new Error('pinnable fetch failed'))))
        .then((p: PinnableVersions) => setPinnableVersions(p))
        .catch(() => setPinnableVersions(null));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (currentPartnerId) {
      fetchPartner();
      return;
    }
    if (contextLoading) return;
    // No partner context in store yet. Try to seed it from the JWT (handles
    // first-login and cleared-storage cases where currentPartnerId is null).
    // getJwtClaims returns all-null on a missing/undecodable token, so the
    // access-denied fall-through below covers those cases too.
    const { scope, partnerId } = getJwtClaims();
    if (scope === 'partner' && partnerId) {
      setPartnerContext(partnerId);
      return; // Re-render will follow with currentPartnerId set
    }
    setLoading(false); // JWT confirms non-partner scope; show access denied
  }, [currentPartnerId, contextLoading, fetchPartner, setPartnerContext]);

  // Deep-link support: open the tab named in the URL hash on mount (e.g.
  // `/settings/partner#ticketing`, which the legacy `/settings/ticketing` route
  // redirects to). Seeded SSR-safe via the 'company' default above; the hash is
  // applied client-side here to avoid a hydration mismatch. Also tracks external
  // hash changes (back/forward, in-app links, the nav anchors below).
  useEffect(() => {
    const applyHash = () => {
      const tab = getTabFromHash();
      if (tab) setActiveTab(tab);
    };
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, []);

  // Activate a tab and push its canonical hash so the URL stays bookmarkable
  // and browser back/forward walks the visited tabs.
  const navigateToTab = (key: TabKey) => {
    setActiveTab(key);
    const canonical = `#${TAB_BY_KEY[key].hash}`;
    if (window.location.hash !== canonical) window.location.hash = canonical;
  };

  const handleSave = async () => {
    // Block a malformed maintenance window client-side (issue #1963) so the
    // inline feedback in PartnerDefaultsTab actually prevents the round-trip,
    // matching the org editor. The server also rejects it as defense-in-depth.
    const mw = defaultsData.maintenanceWindow;
    if (typeof mw === 'string' && mw.trim() !== '' && !isValidMaintenanceWindow(mw)) {
      setError(MAINTENANCE_WINDOW_ERROR_MESSAGE);
      return;
    }

    setSaving(true);
    setError(undefined);

    const settings: Record<string, unknown> = {
      timezone, dateFormat, timeFormat, language: 'en',
      businessHours: {
        preset: businessHoursPreset,
        ...(businessHoursPreset === 'custom' ? { custom: customHours } : {})
      },
      contact: {
        name: contactName || undefined,
        email: contactEmail || undefined,
        phone: contactPhone || undefined,
        website: contactWebsite || undefined
      },
      address: {
        street1: address.street1 || undefined,
        street2: address.street2 || undefined,
        city: address.city || undefined,
        region: address.region || undefined,
        postalCode: address.postalCode || undefined,
        country: address.country || undefined,
      }
    };

    // Always include all categories so clearing all fields removes locks
    settings.security = securityData;
    settings.notifications = notificationsData;
    settings.eventLogs = eventLogsData;
    settings.defaults = defaultsData;
    settings.branding = brandingData;
    settings.aiBudgets = aiBudgetsData;
    settings.remoteAccessProviders = remoteAccessData;

    const payload: Record<string, unknown> = { settings };
    const trimmedName = companyName.trim();
    if (trimmedName) payload.name = trimmedName;

    // Lockout guard before saving a non-empty allowlist:
    //  - status known and current IP not covered  -> precise warning
    //  - status unavailable (fetch failed)         -> generic warning, since we
    //    can't verify coverage and shouldn't silently skip the check
    const nextList = securityData.ipAllowlist ?? [];
    if (nextList.length > 0) {
      const notCovered = ipStatus && !currentIpCovered(ipStatus.currentIp, nextList);
      if (notCovered) {
        const proceed = window.confirm(
          'Your current IP is not in this allowlist. Saving may lock you out of the dashboard. Continue?'
        );
        if (!proceed) { setSaving(false); return; }
      } else if (ipStatusUnavailable) {
        const proceed = window.confirm(
          'Couldn’t verify your current IP against this allowlist. If your IP isn’t covered, saving may lock you out. Continue?'
        );
        if (!proceed) { setSaving(false); return; }
      }
    }

    try {
      const updated = await runPartnerSave(payload, {
        onUnauthorized: () => { void navigateTo('/login', { replace: true }); },
      });
      setPartner(updated);
      // The just-sent values are now the persisted state.
      setBaseline(currentSnapshot);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        setError(err instanceof Error ? err.message : 'Failed to save settings');
      }
      // ActionError non-401: runAction already toasted
    } finally {
      setSaving(false);
    }
  };

  const updateCustomHours = (day: string, field: keyof DaySchedule, value: string | boolean) => {
    setCustomHours(prev => ({ ...prev, [day]: { ...prev[day], [field]: value } }));
  };

  // Show a loading state while the partner context is still resolving, NOT the
  // access-denied state. The partner store starts empty (currentPartnerId null)
  // and only fills after the store fetch or the JWT-seed effect below runs, so
  // gating "access denied" purely on `!currentPartnerId` flashes the denied UI
  // for ~1-2s before self-correcting (cousin of the partners.length>0 gating
  // class). The effect keeps local `loading` true until it has CONFIRMED a
  // non-partner scope (it calls setLoading(false) only on that branch), so
  // `loading || contextLoading` is the true "still resolving" signal. Only once
  // resolution finishes and there is genuinely no partner do we deny access.
  if (!currentPartnerId && (loading || contextLoading)) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary" />
          <p className="mt-4 text-sm text-muted-foreground">Loading partner settings...</p>
        </div>
      </div>
    );
  }

  if (!currentPartnerId) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-center dark:border-amber-800 dark:bg-amber-950">
        <Building2 className="mx-auto h-12 w-12 text-amber-500" />
        <h2 className="mt-4 text-lg font-semibold">Partner Access Required</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Partner settings are only available to partner-level users.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary" />
          <p className="mt-4 text-sm text-muted-foreground">Loading partner settings...</p>
        </div>
      </div>
    );
  }

  if (error && !partner) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button type="button" onClick={fetchPartner}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
          Try again
        </button>
      </div>
    );
  }

  const activeDef = TAB_BY_KEY[activeTab];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Partner Settings</h1>
          <p className="text-sm text-muted-foreground">
            Configure defaults for {partner?.name || 'your MSP'}.
          </p>
        </div>
        {activeDef.selfSaving ? (
          <p className="self-center text-sm text-muted-foreground">
            This section saves its own changes.
          </p>
        ) : (
          <button type="button" onClick={handleSave} disabled={saving || !isDirty}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        )}
      </header>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-destructive">
          <p className="text-sm">{error}</p>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <SettingsSectionNav
          groups={TAB_GROUPS.map(group => ({
            label: group.label,
            items: group.tabs.map(tab => ({ ...tab, dirty: !!dirtyTabs[tab.key] })),
          }))}
          activeKey={activeTab}
          onNavigate={key => navigateToTab(key as TabKey)}
          selectId="partner-settings-section"
        />

        <div className="min-w-0 space-y-6">
          {activeDef.enforced && (
            <div className="rounded-md border bg-blue-50 dark:bg-blue-950/30 px-4 py-3 text-sm text-blue-700 dark:text-blue-300">
              Values you set here are enforced across all organizations. Leave fields empty to let each organization configure individually.
            </div>
          )}

          {/* Company Tab */}
          {activeTab === 'company' && (
            <PartnerCompanyTab
              name={companyName}
              address={address}
              contact={{
                name: contactName,
                email: contactEmail,
                phone: contactPhone,
                website: contactWebsite,
              }}
              onNameChange={setCompanyName}
              onAddressChange={setAddress}
              onContactChange={(c) => {
                setContactName(c.name || '');
                setContactEmail(c.email || '');
                setContactPhone(c.phone || '');
                setContactWebsite(c.website || '');
              }}
            />
          )}

          {/* Regional Tab */}
          {activeTab === 'regional' && (
            <PartnerRegionalTab
              timezone={timezone}
              dateFormat={dateFormat}
              timeFormat={timeFormat}
              businessHoursPreset={businessHoursPreset}
              customHours={customHours}
              onTimezoneChange={setTimezone}
              onDateFormatChange={setDateFormat}
              onTimeFormatChange={setTimeFormat}
              onBusinessHoursPresetChange={setBusinessHoursPreset}
              onCustomHoursChange={updateCustomHours}
            />
          )}

          {/* Inheritable Settings Tabs */}
          {activeTab === 'security' && (
            <section className="rounded-lg border bg-card p-6 shadow-xs">
              <PartnerSecurityTab data={securityData} onChange={setSecurityData} status={ipStatus} statusUnavailable={ipStatusUnavailable} />
            </section>
          )}

          {activeTab === 'notifications' && (
            <section className="rounded-lg border bg-card p-6 shadow-xs">
              <PartnerNotificationsTab data={notificationsData} onChange={setNotificationsData} />
            </section>
          )}

          {activeTab === 'eventLogs' && (
            <section className="rounded-lg border bg-card p-6 shadow-xs">
              <PartnerEventLogsTab data={eventLogsData} onChange={setEventLogsData} />
            </section>
          )}

          {activeTab === 'defaults' && (
            <section className="rounded-lg border bg-card p-6 shadow-xs">
              <PartnerDefaultsTab data={defaultsData} onChange={setDefaultsData} pinnableVersions={pinnableVersions} />
            </section>
          )}

          {activeTab === 'branding' && (
            <section className="rounded-lg border bg-card p-6 shadow-xs">
              <PartnerBrandingTab data={brandingData} onChange={setBrandingData} />
            </section>
          )}

          {/* Login Branding: self-contained card with its own load/save (the
              top-level "Save Settings" button does not apply here). */}
          {activeTab === 'loginBranding' && <LoginBrandingCard />}

          {activeTab === 'aiBudgets' && (
            <section className="rounded-lg border bg-card p-6 shadow-xs">
              <PartnerAiBudgetsTab data={aiBudgetsData} onChange={setAiBudgetsData} />
            </section>
          )}

          {activeTab === 'remoteAccess' && (
            <section className="rounded-lg border bg-card p-6 shadow-xs">
              <PartnerRemoteAccessTab data={remoteAccessData} onChange={setRemoteAccessData} />
            </section>
          )}

          {/* Ticketing: partner-wide statuses, priority SLAs, categories, and billing
              export. Each sub-tab persists independently, so the top-level "Save
              Settings" button does not apply here. */}
          {activeTab === 'ticketing' && (
            <section className="space-y-2" data-testid="partner-ticketing-tab">
              <p className="text-sm text-muted-foreground">
                Configure ticket statuses, priority SLA defaults, categories, and billing exports.
                These apply across all of your organizations.
              </p>
              <TicketingSettingsTabs syncHash={false} initialTab={deepLinkTicketMailbox ? 'inbound' : undefined} />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
