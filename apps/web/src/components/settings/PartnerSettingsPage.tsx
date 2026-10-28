import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Building2, Loader2, Save } from 'lucide-react';
import EmailTemplatesTab from './EmailTemplatesTab';
import SettingsSectionNav from './SettingsSectionNav';
import { useAuthStore } from '../../stores/auth';
import { useCallerVerificationEnabled } from '../../lib/useCallerVerificationEnabled';
import { useFeaturesStore } from '../../stores/featuresStore';
import { PartnerCallerVerificationPolicy } from '../callerVerification/CallerVerificationPolicyForm';
import { getJwtClaims } from '../../lib/authScope';
import { useOrgStore } from '../../stores/orgStore';
import PartnerSecurityTab from './PartnerSecurityTab';
import PartnerNotificationsTab from './PartnerNotificationsTab';
import PartnerEventLogsTab from './PartnerEventLogsTab';
import PartnerDefaultsTab from './PartnerDefaultsTab';
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
import PartnerModulesCard from './PartnerModulesCard';
import PartnerRegionalTab from './PartnerRegionalTab';
import LoginBrandingCard from './LoginBrandingCard';
import TrustTemplateSettings from '../trustCenter/TrustTemplateSettings';
import { useTranslation } from 'react-i18next';
import MfaPolicyOffBanner from '../auth/MfaPolicyOffBanner';
import { isTabVisible } from './sendingDomains/domainView';
import { TAB_BY_KEY, tabFromHash, visibleTabGroups, type TabKey } from './partnerSettings/tabRegistry';
import { usePartnersMeUnit } from './partnerSettings/usePartnersMeUnit';
import { isUnitValid, type SaveUnit } from './partnerSettings/saveUnits';
import { usePartnerSettingsSave } from './partnerSettings/usePartnerSettingsSave';
import { usePartnerSettingsDraftStore } from './partnerSettings/partnerSettingsDraftStore';
import { useCallerVerificationUnit } from './partnerSettings/units/callerVerificationUnit';
import { useLoginBrandingUnit } from './partnerSettings/units/loginBrandingUnit';
import { useTrustCenterUnit } from './partnerSettings/units/trustCenterUnit';
import { useAiFeatureDefaultsUnit } from './partnerSettings/units/aiFeatureDefaultsUnit';
import { useAiDataPolicyUnit } from './partnerSettings/units/aiDataPolicyUnit';
import PartnerSettingsStatus, { deriveStatus, type AutosaveReport } from './partnerSettings/PartnerSettingsStatus';
import FormCard from './partnerSettings/FormCard';
import { PartnerSettingsSaveContext } from './partnerSettings/partnerSettingsSaveContext';
import { useUnsavedGuard } from './partnerSettings/useUnsavedGuard';
import BadgeLegend from './partnerSettings/BadgeLegend';
import { PartnerInheritanceContext } from './partnerSettings/inheritanceContext';
import InheritanceSidePanel, { InheritanceDrawer } from './partnerSettings/InheritanceSidePanel';
import { usePartnerInheritanceUi } from './partnerSettings/usePartnerInheritanceUi';

// Kept on this module's surface: existing callers and tests import it from here.
export { runPartnerSave } from './partnerSettings/usePartnersMeUnit';

export default function PartnerSettingsPage() {
  const { t } = useTranslation('settings');
  const { currentPartnerId, isLoading: contextLoading, adoptPartnerId } = useOrgStore();
  const me = usePartnersMeUnit();
  const { partner, state, update, loading, error } = me;
  const [activeTab, setActiveTab] = useState<TabKey>('company');
  // A status-line link asks for a field to be focused once its tab has rendered.
  const [focusRequest, setFocusRequest] = useState<string | null>(null);
  const canManagePartnerWide = useAuthStore(s => s.user?.canManagePartnerWide) !== false;

  // Drafts of the self-contained units are page-scoped: reset on unmount and on a partner switch.
  const setDraftPartner = usePartnerSettingsDraftStore(s => s.setPartner);
  useEffect(() => { setDraftPartner(currentPartnerId ?? null); }, [currentPartnerId, setDraftPartner]);
  useEffect(() => () => usePartnerSettingsDraftStore.getState().reset(), []);

  const callerVerificationUnit = useCallerVerificationUnit();
  const loginBrandingUnit = useLoginBrandingUnit();
  const trustCenterUnit = useTrustCenterUnit();
  const aiFeatureDefaultsUnit = useAiFeatureDefaultsUnit();
  const aiDataPolicyUnit = useAiDataPolicyUnit();
  const units: SaveUnit[] = useMemo(
    () => [me.unit, callerVerificationUnit, loginBrandingUnit, trustCenterUnit, aiFeatureDefaultsUnit, aiDataPolicyUnit],
    [me.unit, callerVerificationUnit, loginBrandingUnit, trustCenterUnit, aiFeatureDefaultsUnit, aiDataPolicyUnit]
  );
  const dirtyTabs = useMemo(() => {
    const dirty: Partial<Record<TabKey, boolean>> = { ...me.dirtyTabs };
    for (const unit of units) if (unit.id !== 'partnersMe' && unit.isDirty()) for (const tab of unit.tabs) dirty[tab] = true;
    return dirty;
  }, [me.dirtyTabs, units]);
  const isDirty = units.some(u => u.isDirty());

  // Warn before a full or soft navigation away discards unsaved edits.
  useUnsavedGuard(isDirty, t('partnerSettingsPage.unsavedConfirm'));

  const { load, markNoPartner } = me;
  useEffect(() => {
    if (currentPartnerId) {
      void load();
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
    markNoPartner(); // JWT confirms non-partner scope; show access denied
  }, [currentPartnerId, contextLoading, load, markNoPartner, adoptPartnerId]);

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
  const navigateToTab = useCallback((key: TabKey) => {
    setActiveTab(key);
    const canonical = `#${TAB_BY_KEY[key].hash}`;
    if (window.location.hash !== canonical) window.location.hash = canonical;
  }, []);

  const openTab = useCallback((key: TabKey, fieldId?: string | null) => {
    navigateToTab(key);
    if (fieldId) setFocusRequest(fieldId);
  }, [navigateToTab]);

  useEffect(() => {
    if (!focusRequest) return;
    const el = document.getElementById(focusRequest);
    if (el) {
      el.focus();
      setFocusRequest(null);
    }
  }, [focusRequest, activeTab]);

  const sendingDomainsVisible = isTabVisible(me.sendingDomainsCapability);

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
    if (me.sendingDomainsChecked && !sendingDomainsVisible && activeTab === 'sendingDomains') {
      setActiveTab('company');
    }
  }, [me.sendingDomainsChecked, sendingDomainsVisible, activeTab]);

  // Same for a `#caller-verification` bookmark: wait for the features store to
  // settle, or a cold load would bounce to Security.
  useEffect(() => {
    if (callerVerificationSettled && !callerVerificationVisible && activeTab === 'callerVerification') {
      setActiveTab('security');
    }
  }, [callerVerificationSettled, callerVerificationVisible, activeTab]);

  const { save, saving, failedUnits, otherUnitsSaved, savedAt } = usePartnerSettingsSave(units);
  const canSave = canManagePartnerWide && !saving && isDirty && units.every(u => !u.isDirty() || isUnitValid(u));
  // The last outcome of an autosave control (ML switches, Modules), for the status line.
  const [autosave, setAutosave] = useState<AutosaveReport | null>(null);

  const statusState = deriveStatus({
    units,
    dirtyTabs,
    saving,
    readOnly: !canManagePartnerWide,
    failedUnits,
    otherUnitsSaved,
    savedAt,
    autosave,
  });

  // Stable across renders (the card context would otherwise re-render every
  // consumer); reads the latest state through a ref.
  const latest = useRef({ canSave, save, statusState, openTab });
  latest.current = { canSave, save, statusState, openTab };
  const handleSave = useCallback(() => {
    const { canSave: ok, save: run, statusState: s, openTab: open } = latest.current;
    if (ok) { void run(); return; }
    // Enter on a form that cannot save: take the user to what blocks it.
    if (s.kind === 'invalid') open(s.tab, s.fieldId);
  }, []);
  const { inheritanceUi, tabState, drill, setDrill, sidePanel } = usePartnerInheritanceUi({
    partnerId: currentPartnerId, partner, activeTab, state, baseline: me.baseline,
  });

  const saveApi = useMemo(() => ({
    submit: handleSave,
    reportAutosave: (tab: TabKey, outcome: AutosaveReport['outcome']) => setAutosave({ tab, outcome }),
  }), [handleSave]);

  // Show a loading state while the partner context is still resolving, NOT the
  // access-denied state. The partner store starts empty (currentPartnerId null)
  // and only fills after the store fetch or the JWT-seed effect below runs, so
  // gating "access denied" purely on `!currentPartnerId` flashes the denied UI
  // for ~1-2s before self-correcting (cousin of the partners.length>0 gating
  // class). The effect keeps `loading` true until it has CONFIRMED a
  // non-partner scope (it calls markNoPartner only on that branch), so
  // `loading || contextLoading` is the true "still resolving" signal. Only once
  // resolution finishes and there is genuinely no partner do we deny access.
  if (loading || (!currentPartnerId && contextLoading)) {
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

  if (!partner || !state) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button type="button" onClick={() => void load()}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
          {t('common:actions.retry')}
        </button>
      </div>
    );
  }

  const activeDef = TAB_BY_KEY[activeTab];
  // A form card: its fields save with the header Save, and Enter submits it.
  const card = (node: React.ReactNode) => <FormCard>{node}</FormCard>;
  const bare = (node: React.ReactNode, className = '') => <FormCard className={className}>{node}</FormCard>;

  return (
    <PartnerSettingsSaveContext.Provider value={saveApi}>
    <PartnerInheritanceContext.Provider value={inheritanceUi}>
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('partnerSettingsPage.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('partnerSettingsPage.description', { name: partner.name || t('partnerSettingsPage.yourMsp') })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <PartnerSettingsStatus state={statusState} onOpenTab={openTab} />
          <button type="button" data-testid="partner-settings-save" onClick={handleSave} disabled={!canSave}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? t('common:states.saving') : t('partnerSettingsPage.saveSettings')}
          </button>
        </div>
      </header>

      {/* The layout's copy stands down on this route (placement="layout"), so
          exactly one banner shows, aligned to this container. */}
      <MfaPolicyOffBanner placement="page" />

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-destructive">
          <p className="text-sm">{error}</p>
        </div>
      )}

      <div className={`grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]${sidePanel ? ' min-[1920px]:grid-cols-[240px_minmax(0,1fr)_360px]' : ''}`}>
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
              <BadgeLegend tab={activeTab} />
            {activeTab === 'company' && bare(
                <PartnerCompanyTab
                  name={state.companyName}
                  address={state.address}
                  contact={state.contact}
                  emailSignature={state.emailSignature}
                  onEmailSignatureChange={v => update('emailSignature', v)}
                  onNameChange={v => update('companyName', v)}
                  onAddressChange={v => update('address', v)}
                  onContactChange={c => update('contact', { name: c.name || '', email: c.email || '', phone: c.phone || '', website: c.website || '' })}
                />, 'space-y-6'
            )}

            {/* Modules Tab (M7): the service management on/off switch gets its own home. */}
            {activeTab === 'modules' && (
              <PartnerModulesCard
                serviceManagementMode={partner.serviceManagementMode}
                topologyFeatureFlags={partner.settings?.topologyFeatureFlags}
              />
            )}

            {activeTab === 'regional' && bare(
              <PartnerRegionalTab
                timezone={state.timezone}
                dateFormat={state.dateFormat}
                timeFormat={state.timeFormat}
                language={state.language}
                onTimezoneChange={v => update('timezone', v)}
                onDateFormatChange={v => update('dateFormat', v)}
                onTimeFormatChange={v => update('timeFormat', v)}
                onLanguageChange={v => update('language', v)}
              />
            )}

            {activeTab === 'security' && card(
              <PartnerSecurityTab data={state.security} onChange={v => update('security', v)} status={me.ipStatus} statusUnavailable={me.ipStatusUnavailable} />
            )}
            {/* Caller verification (#6354): partner baseline; the rail hides the
                tab (and the form renders nothing) unless the server flag is on. */}
            {activeTab === 'callerVerification' && bare(<PartnerCallerVerificationPolicy />)}

            {/* Known guests: partner-wide MAC whitelist, with its own add/remove. */}
            {activeTab === 'knownGuests' && <KnownGuestsSettings />}

            {activeTab === 'notifications' && card(<PartnerNotificationsTab data={state.notifications} onChange={v => update('notifications', v)} />)}
            {activeTab === 'eventLogs' && card(<PartnerEventLogsTab data={state.eventLogs} onChange={v => update('eventLogs', v)} />)}
            {activeTab === 'defaults' && card(
              <PartnerDefaultsTab data={state.defaults} onChange={v => update('defaults', v)} pinnableVersions={me.pinnableVersions} />
            )}
            {activeTab === 'branding' && card(<PartnerBrandingTab data={state.branding} onChange={v => update('branding', v)} />)}

            {activeTab === 'loginBranding' && bare(<LoginBrandingCard partnerSlug={partner.slug} />)}

            {/* Trust Center defaults: revisioned, MFA-gated. */}
            {activeTab === 'trustCenter' && bare(<TrustTemplateSettings />)}

            {activeTab === 'aiBudgets' && card(
              <PartnerAiBudgetsTab
                data={state.aiBudgets}
                onChange={v => update('aiBudgets', v)}
                thresholdsText={state.aiBudgetsThresholdsRaw}
                onThresholdsTextChange={me.setThresholdsRaw}
              />
            )}
            {activeTab === 'aiApprovals' && card(<PartnerAiApprovalsTab data={state.aiApprovals} onChange={v => update('aiApprovals', v)} />)}

            {/* AI Providers & Models: connection and model rows are list items; the
                feature-defaults card inside is the tab's form card. */}
            {activeTab === 'aiProvider' && (
              <section className="rounded-lg border bg-card p-6 shadow-xs"><PartnerAiModelsTab /></section>
            )}

            {/* AI Features: a data-policy form card beside the ML autosave switches. */}
            {activeTab === 'aiFeatures' && (
              <section className="rounded-lg border bg-card p-6 shadow-xs">
                {bare(<PartnerAiDataPolicyCard />)}
                <PartnerMlFeaturesCard value={partner.settings?.ml} onSaved={ml => me.patchPartnerSettings({ ml })} />
              </section>
            )}

            {activeTab === 'remoteAccess' && card(
              <PartnerRemoteAccessTab
                data={state.remoteAccess}
                onChange={v => update('remoteAccess', v)}
                networkProxy={state.networkProxy}
                onNetworkProxyChange={v => update('networkProxy', v)}
              />
            )}

            {activeTab === 'emailTemplates' && (
              <section className="space-y-2" data-testid="partner-email-templates-tab">
                <EmailTemplatesTab />
              </section>
            )}

            {/* Custom sender addresses: partner sending domains, DNS records,
                per-stream sender identities and the test send (list kind). */}
            {activeTab === 'sendingDomains' && sendingDomainsVisible && <PartnerSendingDomainTab />}
            </section>
          )}
        </div>

        {sidePanel && (
          <InheritanceSidePanel state={tabState} selection={drill} onSelect={setDrill} onClear={() => setDrill(null)} />
        )}
      </div>

      {!sidePanel && <InheritanceDrawer selection={drill} onClose={() => setDrill(null)} />}
    </div>
    </PartnerInheritanceContext.Provider>
    </PartnerSettingsSaveContext.Provider>
  );
}