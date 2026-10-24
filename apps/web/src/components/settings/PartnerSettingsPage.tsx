import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Building2, Loader2, Save } from 'lucide-react';
import EmailTemplatesTab from './EmailTemplatesTab';
import SettingsSectionNav from './SettingsSectionNav';
import { fetchWithAuth } from '../../stores/auth';
import { useCallerVerificationEnabled } from '../../lib/useCallerVerificationEnabled';
import { useFeaturesStore } from '../../stores/featuresStore';
import { PartnerCallerVerificationPolicy } from '../callerVerification/CallerVerificationPolicyForm';
import { getJwtClaims } from '../../lib/authScope';
import { useOrgStore } from '../../stores/orgStore';
import PartnerSecurityTab, { currentIpCovered } from './PartnerSecurityTab';
import PartnerNotificationsTab from './PartnerNotificationsTab';
import PartnerEventLogsTab from './PartnerEventLogsTab';
import PartnerDefaultsTab from './PartnerDefaultsTab';
import type { PinnableVersions } from './AgentVersionPinSelectors';
import PartnerBrandingTab from './PartnerBrandingTab';
import PartnerAiBudgetsTab from './PartnerAiBudgetsTab';
import PartnerAiApprovalsTab from './PartnerAiApprovalsTab';
import PartnerAiModelsTab from './aiModels/PartnerAiModelsTab';
import PartnerMlFeaturesCard from './PartnerMlFeaturesCard';
import PartnerAiDataPolicyCard from './PartnerAiDataPolicyCard';
import PartnerRemoteAccessTab from './PartnerRemoteAccessTab';
import PartnerSendingDomainTab from './PartnerSendingDomainTab';
import PartnerCompanyTab from './PartnerCompanyTab';
import KnownGuestsSettings from './KnownGuestsSettings';
import PartnerModulesCard, { type TopologyFeatureFlags } from './PartnerModulesCard';
import type { ServiceManagementMode } from '@/stores/orgStore';
import PartnerRegionalTab from './PartnerRegionalTab';
import LoginBrandingCard from './LoginBrandingCard';
import TrustTemplateSettings from '../trustCenter/TrustTemplateSettings';
import type {
  PartnerSettings,
  SupportedLocale,
  DateFormat,
  TimeFormat,
  InheritableSecuritySettings,
  InheritableNotificationSettings,
  InheritableEventLogSettings,
  InheritableDefaultSettings,
  InheritableBrandingSettings,
  InheritableAiBudgetSettings,
  AiApprovalSettings,
  InheritableRemoteAccessSettings,
  PartnerNetworkProxySettings,
  IpAllowlistStatus,
  SendingDomainsCapabilityDto
} from '@breeze/shared';
import { isValidMaintenanceWindow, MAINTENANCE_WINDOW_ERROR_MESSAGE, isHttpUrl, httpUrlErrorMessage } from '@breeze/shared';
import { navigateTo } from '@/lib/navigation';
import { runAction, ActionError } from '@/lib/runAction';
import { useTranslation } from 'react-i18next';
import { i18n } from '@/lib/i18n';
import { normalizeLocale } from '@/lib/appearance';
import MfaPolicyOffBanner, { PARTNER_SETTINGS_SAVED_EVENT } from '../auth/MfaPolicyOffBanner';
import { fetchSendingDomains } from '@/lib/api/sendingDomains';
import { isTabVisible } from './sendingDomains/domainView';
import { useStableT } from '@/lib/i18n/useStableT';
import { TAB_BY_KEY, tabFromHash, visibleTabGroups, type TabKey } from './partnerSettings/tabRegistry';

// Scalar security limits the API unsets when sent as null (see PATCH /partners/me).
const CLEARABLE_SECURITY_KEYS = ['minLength', 'complexity', 'expirationDays', 'sessionTimeout', 'maxSessions'] as const;

type Partner = {
  id: string;
  name: string;
  slug: string;
  type: string;
  plan: string;
  // First-class partner timezone column (#1318); the canonical tz default.
  timezone?: string;
  // Plain-text signature appended to outbound customer emails (quote sends).
  emailSignature?: string | null;
  // `topologyFeatureFlags` is not on the shared PartnerSettings type yet; the
  // card owns its shape, so the intersection stays local to this page.
  settings: PartnerSettings & { topologyFeatureFlags?: TopologyFeatureFlags };
  // #5075 W04 — which service-desk/billing module this partner runs.
  // `undefined` on every render before the partner fetch resolves, and also on
  // an API too old to send it. The card treats both the same way: display
  // 'native', publish nothing to the store (see PartnerModulesCard's prop doc).
  serviceManagementMode?: ServiceManagementMode;
  createdAt: string;
};

// The per-tab keys whose form state participates in dirty tracking. Self-saving
// tabs (Ticketing, Email templates, Login Branding, AI Provider, Sender
// Addresses, Modules) persist independently and are never "dirty" from this
// page's perspective.
type SnapshotKey = Exclude<TabKey, 'ticketing' | 'emailTemplates' | 'loginBranding' | 'aiProvider' | 'aiFeatures' | 'sendingDomains' | 'modules' | 'trustCenter' | 'knownGuests' | 'callerVerification'>;
type Snapshot = Record<SnapshotKey, string>;

// Exported for unit-testing without mounting the full component.
export async function runPartnerSave(
  payload: Record<string, unknown>,
  deps: { onUnauthorized: () => void }
): Promise<Partner> {
  return runAction<Partner>({
    request: () => fetchWithAuth('/orgs/partners/me', { method: 'PATCH', body: JSON.stringify(payload) }),
    successMessage: i18n.t('settings:partnerSettingsPage.saved'),
    errorFallback: i18n.t('settings:partnerSettingsPage.saveFailed'),
    onUnauthorized: deps.onUnauthorized,
  });
}

export default function PartnerSettingsPage() {
  const { t } = useTranslation('settings');
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  const { currentPartnerId, isLoading: contextLoading, adoptPartnerId } = useOrgStore();
  const [partner, setPartner] = useState<Partner | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [activeTab, setActiveTab] = useState<TabKey>('company');

  // Regional form state
  const [timezone, setTimezone] = useState('UTC');
  const [dateFormat, setDateFormat] = useState<DateFormat>('MM/DD/YYYY');
  const [timeFormat, setTimeFormat] = useState<TimeFormat>('12h');
  const [language, setLanguage] = useState<SupportedLocale>('en');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactWebsite, setContactWebsite] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [address, setAddress] = useState<NonNullable<PartnerSettings['address']>>({});
  const [emailSignature, setEmailSignature] = useState('');

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
  // The AI Budgets tab's alert-threshold box can hold text that does not parse;
  // it never reaches `aiBudgetsData`, so saving while it is red would persist
  // the previous ladder and report success (#4388 W03). The input reports true
  // again when it unmounts, so leaving the tab never strands the Save button.
  const [aiBudgetsValid, setAiBudgetsValid] = useState(true);
  const [aiApprovalsData, setAiApprovalsData] = useState<AiApprovalSettings>({});
  const [remoteAccessData, setRemoteAccessData] = useState<InheritableRemoteAccessSettings>({});
  // `settings.networkProxy` (#8155): partner-only, shown on the Remote Access tab.
  const [networkProxyData, setNetworkProxyData] = useState<PartnerNetworkProxySettings>({});
  // Registered agent/watchdog versions for the pin selectors (#2124).
  const [pinnableVersions, setPinnableVersions] = useState<PinnableVersions | null>(null);
  // Capability only: the tab does its own full read. `checked` distinguishes
  // "not fetched yet" from "fetched and this instance has no provider", so a
  // deep link to #sending-domains does not bounce to Company mid-flight.
  const [sendingDomainsCapability, setSendingDomainsCapability] = useState<SendingDomainsCapabilityDto | null>(null);
  const [sendingDomainsChecked, setSendingDomainsChecked] = useState(false);

  // Dirty tracking: a per-tab serialized snapshot of the saveable form state,
  // compared against the baseline captured after fetch (and reset after save).
  // Drives the disabled-when-clean Save button and the per-tab dots in the nav.
  const currentSnapshot: Snapshot = useMemo(() => ({
    company: JSON.stringify({ companyName, address, contactName, contactEmail, contactPhone, contactWebsite, emailSignature }),
    regional: JSON.stringify({ timezone, dateFormat, timeFormat, language }),
    security: JSON.stringify(securityData),
    notifications: JSON.stringify(notificationsData),
    eventLogs: JSON.stringify(eventLogsData),
    defaults: JSON.stringify(defaultsData),
    branding: JSON.stringify(brandingData),
    aiBudgets: JSON.stringify(aiBudgetsData),
    aiApprovals: JSON.stringify(aiApprovalsData),
    remoteAccess: JSON.stringify({ remoteAccessData, networkProxyData }),
  }), [
    companyName, address, contactName, contactEmail, contactPhone, contactWebsite, emailSignature,
    timezone, dateFormat, timeFormat, language,
    securityData, notificationsData, eventLogsData, defaultsData, brandingData,
    aiBudgetsData, aiApprovalsData, remoteAccessData, networkProxyData,
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
        if (response.status === 403) { setError(stableT('partnerSettingsPage.permissionDenied')); return; }
        throw new Error(stableT('partnerSettingsPage.fetchFailed'));
      }
      const data: Partner = await response.json();
      setPartner(data);
      setCompanyName(data.name || '');
      setEmailSignature(data.emailSignature || '');

      const settings = data.settings || {};
      // Prefer the legacy JSONB key the UI has always written, then the new
      // first-class `partners.timezone` column (#1318), then UTC.
      setTimezone(settings.timezone || data.timezone || 'UTC');
      setDateFormat(settings.dateFormat || 'MM/DD/YYYY');
      setTimeFormat(settings.timeFormat || '12h');
      setLanguage(normalizeLocale(settings.language) ?? 'en');
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
      setAiApprovalsData(settings.aiApprovals || {});
      setRemoteAccessData(settings.remoteAccessProviders || {});
      // Keep only a real boolean: anything else is "never chose" (platform default).
      const dedicated = settings.networkProxy?.dedicatedTunnelOrigin;
      setNetworkProxyData(typeof dedicated === 'boolean' ? { dedicatedTunnelOrigin: dedicated } : {});

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

      // Best-effort: decides whether the Sender Addresses tab appears at all.
      // A 404 means EMAIL_DOMAINS_PROVIDER is unset on this instance — the
      // default everywhere — and the tab stays hidden.
      fetchSendingDomains()
        .then((result) => setSendingDomainsCapability(result.supported ? (result.data.capability ?? null) : null))
        .catch(() => setSendingDomainsCapability(null))
        .finally(() => setSendingDomainsChecked(true));
    } catch (err) {
      setError(err instanceof Error ? err.message : stableT('partnerSettingsPage.genericError'));
    } finally {
      setLoading(false);
    }
  }, [stableT]);

  useEffect(() => {
    if (currentPartnerId) {
      fetchPartner();
      return;
    }
    if (contextLoading) return;
    // No partner context in store yet. Seed it from the JWT (handles
    // first-login and cleared-storage cases where currentPartnerId is null).
    // adoptPartnerId, NOT setPartner: setPartner resets the org selection and
    // the subsequent auto-select snapped scope to the first org — visiting
    // this page silently hijacked the user's chosen context.
    // getJwtClaims returns all-null on a missing/undecodable token, so the
    // access-denied fall-through below covers those cases too.
    const { scope, partnerId } = getJwtClaims();
    if (scope === 'partner' && partnerId) {
      adoptPartnerId(partnerId);
      return; // Re-render will follow with currentPartnerId set
    }
    setLoading(false); // JWT confirms non-partner scope; show access denied
  }, [currentPartnerId, contextLoading, fetchPartner, adoptPartnerId]);

  // Deep-link support: open the tab named in the URL hash on mount (e.g.
  // `/settings/partner#security`). Seeded SSR-safe via the 'company' default above; the hash is
  // applied client-side here to avoid a hydration mismatch. Also tracks external
  // hash changes (back/forward, in-app links, the nav anchors below).
  useEffect(() => {
    const applyHash = () => {
      const tab = tabFromHash(window.location.hash);
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

  const sendingDomainsVisible = isTabVisible(sendingDomainsCapability);

  const callerVerificationVisible = useCallerVerificationEnabled();
  const callerVerificationSettled = useFeaturesStore(s => s.loaded);

  // Registry hash resolution is independent of visibility, so `#sending-domains`
  // and `#caller-verification` keep resolving; visibility trims the rendered nav.
  const visibleGroups = useMemo(
    () => visibleTabGroups({ sendingDomains: sendingDomainsVisible, callerVerification: callerVerificationVisible }),
    [sendingDomainsVisible, callerVerificationVisible]
  );

  // A bookmark to a tab this instance hides falls back to Company — but only
  // once the capability read has actually settled.
  useEffect(() => {
    if (sendingDomainsChecked && !sendingDomainsVisible && activeTab === 'sendingDomains') {
      setActiveTab('company');
    }
  }, [sendingDomainsChecked, sendingDomainsVisible, activeTab]);

  // Same for a `#caller-verification` bookmark: wait for the features store to
  // settle, or a cold load would bounce to Security.
  useEffect(() => {
    if (callerVerificationSettled && !callerVerificationVisible && activeTab === 'callerVerification') {
      setActiveTab('security');
    }
  }, [callerVerificationSettled, callerVerificationVisible, activeTab]);

  const handleSave = async () => {
    // Block a malformed maintenance window client-side (issue #1963) so the
    // inline feedback in PartnerDefaultsTab actually prevents the round-trip,
    // matching the org editor. The server also rejects it as defense-in-depth.
    const mw = defaultsData.maintenanceWindow;
    if (typeof mw === 'string' && mw.trim() !== '' && !isValidMaintenanceWindow(mw)) {
      setError(MAINTENANCE_WINDOW_ERROR_MESSAGE);
      return;
    }

    // Same shape for the company Website (#3430): the server rejects any scheme
    // outside http/https, so block the round-trip here and say why. The field is
    // clearable, hence the non-empty guard.
    if (contactWebsite.trim() !== '' && !isHttpUrl(contactWebsite.trim())) {
      setError(httpUrlErrorMessage('Website'));
      return;
    }

    setSaving(true);
    setError(undefined);

    const settings: Record<string, unknown> = {
      timezone, dateFormat, timeFormat, language,
      contact: {
        name: contactName || undefined,
        email: contactEmail || undefined,
        phone: contactPhone || undefined,
        // Trimmed to match the predicate the guard above applied — sending the
        // untrimmed value made a whitespace-only entry pass the client check
        // and then fail server-side with no inline error to explain it.
        website: contactWebsite.trim() || undefined
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
    // The API deep-merges `security`, so an omitted key keeps its stored value.
    // A cleared scalar limit must go out as an explicit null to be unset (#8976).
    settings.security = {
      ...securityData,
      ...Object.fromEntries(
        CLEARABLE_SECURITY_KEYS.filter(key => securityData[key] === undefined).map(key => [key, null])
      ),
    };
    settings.notifications = notificationsData;
    settings.eventLogs = eventLogsData;
    settings.defaults = defaultsData;
    settings.branding = brandingData;
    settings.aiBudgets = aiBudgetsData;
    settings.aiApprovals = aiApprovalsData;
    settings.remoteAccessProviders = remoteAccessData;
    // Only an explicit choice is written. An unset value stays unset so the
    // platform default (TUNNEL_ORIGIN_PARTNER_DEFAULT) can later flip for
    // partners who never chose (plan W04 Task 19).
    if (typeof networkProxyData.dedicatedTunnelOrigin === 'boolean') {
      settings.networkProxy = networkProxyData;
    }

    const payload: Record<string, unknown> = { settings };
    const trimmedName = companyName.trim();
    if (trimmedName) payload.name = trimmedName;
    // Top-level partner column (not settings JSONB). Always sent so clearing
    // the field persists null; the server trims and stores empty as null too.
    payload.emailSignature = emailSignature.trim() ? emailSignature : null;

    // Lockout guard before saving a non-empty allowlist:
    //  - status known and current IP not covered  -> precise warning
    //  - status unavailable (fetch failed)         -> generic warning, since we
    //    can't verify coverage and shouldn't silently skip the check
    const nextList = securityData.ipAllowlist ?? [];
    if (nextList.length > 0) {
      const notCovered = ipStatus && !currentIpCovered(ipStatus.currentIp, nextList);
      if (notCovered) {
        const proceed = window.confirm(
          t('partnerSettingsPage.confirmIpNotCovered')
        );
        if (!proceed) { setSaving(false); return; }
      } else if (ipStatusUnavailable) {
        const proceed = window.confirm(
          t('partnerSettingsPage.confirmIpUnknown')
        );
        if (!proceed) { setSaving(false); return; }
      }
    }

    try {
      const updated = await runPartnerSave(payload, {
        onUnauthorized: () => { void navigateTo('/login', { replace: true }); },
      });
      setPartner(updated);
      // Lets layout islands that read partner settings (MfaPolicyOffBanner)
      // re-check without a page navigation.
      window.dispatchEvent(new Event(PARTNER_SETTINGS_SAVED_EVENT));
      // The just-sent values are now the persisted state.
      setBaseline(currentSnapshot);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        setError(err instanceof Error ? err.message : t('partnerSettingsPage.saveFailed'));
      }
      // ActionError non-401: runAction already toasted
    } finally {
      setSaving(false);
    }
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
          <p className="mt-4 text-sm text-muted-foreground">{t('partnerSettingsPage.loading')}</p>
        </div>
      </div>
    );
  }

  if (!currentPartnerId) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-center dark:border-amber-800 dark:bg-amber-950">
        <Building2 className="mx-auto h-12 w-12 text-amber-500" />
        <h2 className="mt-4 text-lg font-semibold">{t('partnerSettingsPage.accessRequired')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('partnerSettingsPage.accessDescription')}
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary" />
          <p className="mt-4 text-sm text-muted-foreground">{t('partnerSettingsPage.loading')}</p>
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
          {t('common:actions.retry')}
        </button>
      </div>
    );
  }

  const activeDef = TAB_BY_KEY[activeTab];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('partnerSettingsPage.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('partnerSettingsPage.description', { name: partner?.name || t('partnerSettingsPage.yourMsp') })}
          </p>
        </div>
        {activeDef.selfSaving ? (
          <p className="self-center text-sm text-muted-foreground">
            {t('partnerSettingsPage.selfSaving')}
          </p>
        ) : (
          <button type="button" onClick={handleSave} disabled={saving || !isDirty || !aiBudgetsValid}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? t('common:states.saving') : t('partnerSettingsPage.saveSettings')}
          </button>
        )}
      </header>

      {/* The layout's copy stands down on this route (placement="layout"), so
          exactly one banner shows, aligned to this container. */}
      <MfaPolicyOffBanner placement="page" />

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-destructive">
          <p className="text-sm">{error}</p>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <SettingsSectionNav
          groups={visibleGroups.map(group => ({
            label: t(/* i18n-dynamic */ group.label),
            items: group.tabs.map(tab => ({ ...tab, label: t(/* i18n-dynamic */ tab.label), description: t(/* i18n-dynamic */ tab.description), dirty: !!dirtyTabs[tab.key] })),
          }))}
          activeKey={activeTab}
          onNavigate={key => navigateToTab(key as TabKey)}
          selectId="partner-settings-section"
          testIdPrefix="partner-settings"
        />

        <div className="min-w-0 space-y-6">
          {activeDef.enforced && (
            <div className="rounded-md border bg-blue-50 dark:bg-blue-950/30 px-4 py-3 text-sm text-blue-700 dark:text-blue-300">
              {t('partnerSettingsPage.enforcedDescription')}
            </div>
          )}

          {/* Ticketing now has its own standalone page (M0) — this tab links out
              to it rather than embedding the tab group. */}
          {activeTab === 'ticketing' && (
            <div className="rounded-lg border bg-card p-6 shadow-xs" data-testid="partner-settings-ticketing-panel">
              <h2 className="text-lg font-semibold">{t('partnerSettingsPage.tabs.ticketing.label')}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{t('partnerSettingsPage.tabs.ticketing.description')}</p>
              <a
                href="/settings/ticketing"
                data-testid="partner-settings-ticketing-link"
                className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
              >
                {t('partnerSettingsPage.tabs.ticketing.linkCta')}
              </a>
            </div>
          )}


          {activeDef.kind === 'panel' && (
            <section aria-labelledby="partner-settings-panel-heading" className="space-y-6">
              <div className="space-y-1">
                <h2 id="partner-settings-panel-heading" data-testid="partner-settings-panel-heading" className="text-lg font-semibold">
                  {t(/* i18n-dynamic */ activeDef.label)}
                </h2>
                <p className="max-w-prose text-sm text-muted-foreground">{t(/* i18n-dynamic */ activeDef.description)}</p>
              </div>
            {/* Company Tab */}
            {activeTab === 'company' && (
              <div className="space-y-6">
                <PartnerCompanyTab
                name={companyName}
                address={address}
                contact={{
                  name: contactName,
                  email: contactEmail,
                  phone: contactPhone,
                  website: contactWebsite,
                }}
                emailSignature={emailSignature}
                onEmailSignatureChange={setEmailSignature}
                onNameChange={setCompanyName}
                onAddressChange={setAddress}
                onContactChange={(c) => {
                  setContactName(c.name || '');
                  setContactEmail(c.email || '');
                  setContactPhone(c.phone || '');
                  setContactWebsite(c.website || '');
                }}
              />
              </div>
            )}

            {/* Modules Tab (M7) — the service management on/off switch gets its
                own home instead of living inside Company. */}
            {activeTab === 'modules' && (
              <PartnerModulesCard
                serviceManagementMode={partner?.serviceManagementMode}
                topologyFeatureFlags={partner?.settings?.topologyFeatureFlags}
              />
            )}

            {/* Regional Tab */}
            {activeTab === 'regional' && (
              <PartnerRegionalTab
                timezone={timezone}
                dateFormat={dateFormat}
                timeFormat={timeFormat}
                language={language}
                onTimezoneChange={setTimezone}
                onDateFormatChange={setDateFormat}
                onTimeFormatChange={setTimeFormat}
                onLanguageChange={setLanguage}
              />
            )}

            {/* Inheritable Settings Tabs */}
            {activeTab === 'security' && (
              <section className="rounded-lg border bg-card p-6 shadow-xs">
                <PartnerSecurityTab data={securityData} onChange={setSecurityData} status={ipStatus} statusUnavailable={ipStatusUnavailable} />
              </section>
            )}
            {/* Caller verification (#6354): partner baseline, self-saving; the
                rail hides the tab (and the form renders nothing) unless the
                server flag is on. */}
            {activeTab === 'callerVerification' && <PartnerCallerVerificationPolicy />}

            {/* Known guests: partner-wide MAC whitelist, with its own add/remove. */}
            {activeTab === 'knownGuests' && <KnownGuestsSettings />}

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
            {activeTab === 'loginBranding' && <LoginBrandingCard partnerSlug={partner?.slug} />}

            {/* Trust Center defaults: self-contained form with its own load/save (MFA, revisioned). */}
            {activeTab === 'trustCenter' && <TrustTemplateSettings />}

            {activeTab === 'aiBudgets' && (
              <section className="rounded-lg border bg-card p-6 shadow-xs">
                <PartnerAiBudgetsTab data={aiBudgetsData} onChange={setAiBudgetsData} onValidityChange={setAiBudgetsValid} />
              </section>
            )}

            {activeTab === 'aiApprovals' && (
              <section className="rounded-lg border bg-card p-6 shadow-xs">
                <PartnerAiApprovalsTab data={aiApprovalsData} onChange={setAiApprovalsData} />
              </section>
            )}

            {/* AI Providers & Models: self-contained cards, each with its own load/save
                (the top-level "Save Settings" button does not apply here). */}
            {activeTab === 'aiProvider' && (
              <section className="rounded-lg border bg-card p-6 shadow-xs">
                <PartnerAiModelsTab />
              </section>
            )}

            {/* AI Features: self-contained card with its own autosave switches. */}
            {activeTab === 'aiFeatures' && (
              <section className="rounded-lg border bg-card p-6 shadow-xs">
                <PartnerAiDataPolicyCard />
                <PartnerMlFeaturesCard value={partner?.settings?.ml} onSaved={(ml) => setPartner((p) => (p ? { ...p, settings: { ...p.settings, ml } } : p))} />
              </section>
            )}

            {activeTab === 'remoteAccess' && (
              <section className="rounded-lg border bg-card p-6 shadow-xs">
                <PartnerRemoteAccessTab
                  data={remoteAccessData}
                  onChange={setRemoteAccessData}
                  networkProxy={networkProxyData}
                  onNetworkProxyChange={setNetworkProxyData}
                />
              </section>
            )}

            {activeTab === 'emailTemplates' && (
              <section className="space-y-2" data-testid="partner-email-templates-tab">
                <EmailTemplatesTab />
              </section>
            )}

            {/* Custom sender addresses: partner sending domains, DNS records,
                per-stream sender identities and the test send. Self-contained
                with its own load/save, so the top-level "Save Settings" button
                does not apply here. */}
            {activeTab === 'sendingDomains' && sendingDomainsVisible && <PartnerSendingDomainTab />}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
