import { useCallback, useMemo, useRef, useState } from 'react';
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
  SendingDomainsCapabilityDto,
} from '@breeze/shared';
import { isValidMaintenanceWindow, isHttpUrl } from '@breeze/shared';
import { fetchWithAuth } from '../../../stores/auth';
import { runAction, ActionError } from '@/lib/runAction';
import { i18n } from '@/lib/i18n';
import { navigateTo } from '@/lib/navigation';
import { normalizeLocale } from '@/lib/appearance';
import { fetchSendingDomains } from '@/lib/api/sendingDomains';
import { getPartnersMe, invalidatePartnersMe } from '@/lib/api/partnersMe';
import { PARTNER_SETTINGS_SAVED_EVENT } from '../../auth/MfaPolicyOffBanner';
import { currentIpCovered } from '../PartnerSecurityTab';
import { parseThresholds } from '../AiBudgetThresholdsInput';
import type { PinnableVersions } from '../AgentVersionPinSelectors';
import type { TopologyFeatureFlags } from '../PartnerModulesCard';
import type { ServiceManagementMode } from '@/stores/orgStore';
import { UNIT_TABS, type PartnersMeTab, type SaveOutcome, type SaveUnit, type TabValidity } from './saveUnits';
import type { TabKey } from './tabRegistry';

export type Partner = {
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
  // #5075 W04: which service-desk/billing module this partner runs. Undefined
  // before the fetch resolves and on an API too old to send it.
  serviceManagementMode?: ServiceManagementMode;
  createdAt: string;
};

/** The editable form state of the ten tabs saved by `PATCH /orgs/partners/me`. */
export type PartnersMeState = {
  companyName: string;
  emailSignature: string;
  contact: { name: string; email: string; phone: string; website: string };
  address: NonNullable<PartnerSettings['address']>;
  timezone: string;
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
  language: SupportedLocale;
  security: InheritableSecuritySettings;
  notifications: InheritableNotificationSettings;
  eventLogs: InheritableEventLogSettings;
  defaults: InheritableDefaultSettings;
  branding: InheritableBrandingSettings;
  aiBudgets: InheritableAiBudgetSettings;
  /**
   * The AI Budgets alert-threshold box as typed. `null` until the user edits
   * it. Unparseable text never reaches `aiBudgets`, so it lives here, above the
   * panel, and survives a tab switch (spec §3.3).
   */
  aiBudgetsThresholdsRaw: string | null;
  aiApprovals: AiApprovalSettings;
  remoteAccess: InheritableRemoteAccessSettings;
  networkProxy: PartnerNetworkProxySettings;
};


// Scalar security limits the API unsets when sent as null (see PATCH /partners/me).
const CLEARABLE_SECURITY_KEYS = ['minLength', 'complexity', 'expirationDays', 'sessionTimeout', 'maxSessions'] as const;

export const PARTNERS_ME_FIELD_IDS = {
  website: 'contact-website',
  maintenanceWindow: 'partner-defaults-maintenance-window',
  aiBudgetThresholds: 'partner-ai-budget-thresholds',
} as const;

export function stateFromPartner(data: Partner): PartnersMeState {
  const settings = data.settings || ({} as Partner['settings']);
  // Keep only a real boolean: anything else is "never chose" (platform default).
  const dedicated = settings.networkProxy?.dedicatedTunnelOrigin;
  return {
    companyName: data.name || '',
    emailSignature: data.emailSignature || '',
    contact: {
      name: settings.contact?.name || '',
      email: settings.contact?.email || '',
      phone: settings.contact?.phone || '',
      website: settings.contact?.website || '',
    },
    address: settings.address || {},
    // Prefer the legacy JSONB key the UI has always written, then the
    // first-class `partners.timezone` column (#1318), then UTC.
    timezone: settings.timezone || data.timezone || 'UTC',
    dateFormat: settings.dateFormat || 'MM/DD/YYYY',
    timeFormat: settings.timeFormat || '12h',
    language: normalizeLocale(settings.language) ?? 'en',
    security: settings.security || {},
    notifications: settings.notifications || {},
    eventLogs: settings.eventLogs || {},
    defaults: settings.defaults || {},
    branding: settings.branding || {},
    aiBudgets: settings.aiBudgets || {},
    aiBudgetsThresholdsRaw: null,
    aiApprovals: settings.aiApprovals || {},
    remoteAccess: settings.remoteAccessProviders || {},
    networkProxy: typeof dedicated === 'boolean' ? { dedicatedTunnelOrigin: dedicated } : {},
  };
}

/** The PATCH body. Byte-identical to the pre-W2 page `handleSave` (fixture-tested). */
export function buildPartnersMePayload(state: PartnersMeState): Record<string, unknown> {
  const { contact, address } = state;
  const settings: Record<string, unknown> = {
    timezone: state.timezone,
    dateFormat: state.dateFormat,
    timeFormat: state.timeFormat,
    language: state.language,
    contact: {
      name: contact.name || undefined,
      email: contact.email || undefined,
      phone: contact.phone || undefined,
      // Trimmed to match the validity check, so a whitespace-only entry never
      // passes the client and then fails server-side.
      website: contact.website.trim() || undefined,
    },
    address: {
      street1: address.street1 || undefined,
      street2: address.street2 || undefined,
      city: address.city || undefined,
      region: address.region || undefined,
      postalCode: address.postalCode || undefined,
      country: address.country || undefined,
    },
  };

  // Always include all categories so clearing all fields removes locks.
  // The API deep-merges `security`, so an omitted key keeps its stored value;
  // a cleared scalar limit must go out as an explicit null to be unset (#8976).
  settings.security = {
    ...state.security,
    ...Object.fromEntries(
      CLEARABLE_SECURITY_KEYS.filter(key => state.security[key] === undefined).map(key => [key, null])
    ),
  };
  settings.notifications = state.notifications;
  settings.eventLogs = state.eventLogs;
  settings.defaults = state.defaults;
  settings.branding = state.branding;
  settings.aiBudgets = state.aiBudgets;
  settings.aiApprovals = state.aiApprovals;
  settings.remoteAccessProviders = state.remoteAccess;
  // Only an explicit choice is written. An unset value stays unset so the
  // platform default (TUNNEL_ORIGIN_PARTNER_DEFAULT) can later flip for
  // partners who never chose.
  if (typeof state.networkProxy.dedicatedTunnelOrigin === 'boolean') {
    settings.networkProxy = state.networkProxy;
  }

  const payload: Record<string, unknown> = { settings };
  const trimmedName = state.companyName.trim();
  if (trimmedName) payload.name = trimmedName;
  // Top-level partner column (not settings JSONB). Always sent so clearing the
  // field persists null; the server trims and stores empty as null too.
  payload.emailSignature = state.emailSignature.trim() ? state.emailSignature : null;
  return payload;
}

function tabValidity(invalidFieldIds: string[]): TabValidity {
  return { isValid: invalidFieldIds.length === 0, invalidCount: invalidFieldIds.length, firstInvalidFieldId: invalidFieldIds[0] ?? null };
}

/**
 * Field checks that used to run only inside `handleSave` now run on every edit
 * (spec §3.5); each field also shows its own inline error.
 */
export function partnersMeValidity(state: PartnersMeState): Partial<Record<TabKey, TabValidity>> {
  const website = state.contact.website.trim();
  const mw = state.defaults.maintenanceWindow;
  const raw = state.aiBudgetsThresholdsRaw;
  return {
    company: tabValidity(website !== '' && !isHttpUrl(website) ? [PARTNERS_ME_FIELD_IDS.website] : []),
    defaults: tabValidity(typeof mw === 'string' && mw.trim() !== '' && !isValidMaintenanceWindow(mw) ? [PARTNERS_ME_FIELD_IDS.maintenanceWindow] : []),
    // The box only renders while budgets are enabled; a hidden box cannot block Save.
    aiBudgets: tabValidity(state.aiBudgets.enabled && raw !== null && !parseThresholds(raw).ok ? [PARTNERS_ME_FIELD_IDS.aiBudgetThresholds] : []),
  };
}

/** One serialised snapshot per tab; a tab is dirty when its snapshot differs from the baseline's. */
export function tabSnapshots(state: PartnersMeState): Record<PartnersMeTab, string> {
  const raw = state.aiBudgetsThresholdsRaw;
  // Unparseable threshold text is an edit even though `aiBudgets` is unchanged.
  const thresholdsDraft = state.aiBudgets.enabled && raw !== null && !parseThresholds(raw).ok ? raw : undefined;
  return {
    company: JSON.stringify({ n: state.companyName, a: state.address, c: state.contact, s: state.emailSignature }),
    regional: JSON.stringify([state.timezone, state.dateFormat, state.timeFormat, state.language]),
    security: JSON.stringify(state.security),
    notifications: JSON.stringify(state.notifications),
    eventLogs: JSON.stringify(state.eventLogs),
    defaults: JSON.stringify(state.defaults),
    branding: JSON.stringify(state.branding),
    aiBudgets: JSON.stringify({ b: state.aiBudgets, t: thresholdsDraft }),
    aiApprovals: JSON.stringify(state.aiApprovals),
    remoteAccess: JSON.stringify({ r: state.remoteAccess, p: state.networkProxy }),
  };
}

export async function runPartnerSave(
  payload: Record<string, unknown>,
  deps: {
    onUnauthorized: () => void;
    /** The header Save shows one aggregate toast for every unit, so it omits the per-request one. */
    silentSuccess?: boolean;
  }
): Promise<Partner> {
  return runAction<Partner>({
    request: () => fetchWithAuth('/orgs/partners/me', { method: 'PATCH', body: JSON.stringify(payload) }),
    successMessage: deps.silentSuccess ? undefined : i18n.t('settings:partnerSettingsPage.saved'),
    errorFallback: i18n.t('settings:partnerSettingsPage.saveFailed'),
    onUnauthorized: deps.onUnauthorized,
  });
}

/**
 * The allowlist lockout guard, unchanged from the pre-W2 page. Returns false
 * when the user declines.
 *  - status known and current IP not covered → precise warning
 *  - status unavailable (fetch failed) → generic warning: coverage cannot be
 *    verified and the check must not be skipped silently
 */
function preflight(state: PartnersMeState, ipStatus: IpAllowlistStatus | null, ipStatusUnavailable: boolean): boolean {
  const nextList = state.security.ipAllowlist ?? [];
  if (nextList.length === 0) return true;
  const notCovered = ipStatus && !currentIpCovered(ipStatus.currentIp, nextList);
  if (notCovered) return window.confirm(i18n.t('settings:partnerSettingsPage.confirmIpNotCovered'));
  if (ipStatusUnavailable) return window.confirm(i18n.t('settings:partnerSettingsPage.confirmIpUnknown'));
  return true;
}

const toLogin = () => { void navigateTo('/login', { replace: true }); };

/**
 * The partners/me persistence unit: the partner record, the form state of its
 * ten tabs, the baseline those tabs are compared against, and the side reads
 * the tabs need. Lives in the page shell so panels can unmount freely.
 */
export function usePartnersMeUnit() {
  const [partner, setPartner] = useState<Partner | null>(null);
  const [state, setState] = useState<PartnersMeState | null>(null);
  const [baseline, setBaseline] = useState<PartnersMeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const [ipStatus, setIpStatus] = useState<IpAllowlistStatus | null>(null);
  const [ipStatusUnavailable, setIpStatusUnavailable] = useState(false);
  const [pinnableVersions, setPinnableVersions] = useState<PinnableVersions | null>(null);
  const [sendingDomainsCapability, setSendingDomainsCapability] = useState<SendingDomainsCapabilityDto | null>(null);
  const [sendingDomainsChecked, setSendingDomainsChecked] = useState(false);

  // Bumped by every load. A response (load or save) from an older generation,
  // i.e. one that started before a partner switch, is dropped.
  const generation = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const ipRef = useRef({ ipStatus, ipStatusUnavailable });
  ipRef.current = { ipStatus, ipStatusUnavailable };

  const load = useCallback(async () => {
    const gen = ++generation.current;
    const isCurrent = () => generation.current === gen;
    // The first load shares the layout islands' concurrent read; a reload (partner
    // switch, retry) must never reuse a read that started before it.
    // It also drops the previous answer, so a failed reload after a partner
    // switch shows the error and Retry rather than the other partner's settings.
    if (gen > 1) {
      invalidatePartnersMe();
      setPartner(null);
      setState(null);
      setBaseline(null);
    }
    try {
      setLoading(true);
      setError(undefined);
      const read = await getPartnersMe();
      if (!isCurrent()) return;
      if (!read.ok) {
        if (read.status === 401) { toLogin(); return; }
        if (read.status === 403) { setError(i18n.t('settings:partnerSettingsPage.permissionDenied')); return; }
        throw new Error(i18n.t('settings:partnerSettingsPage.fetchFailed'));
      }
      if (!read.data) throw new Error(i18n.t('settings:partnerSettingsPage.fetchFailed'));
      const data = read.data as Partner;
      const next = stateFromPartner(data);
      setPartner(data);
      setState(next);
      setBaseline(next);

      // Best-effort: IP allowlist status for the editor (non-blocking). On
      // failure flag it, so the editor warns rather than silently hiding the
      // inactive banner and the lockout confirmation.
      fetchWithAuth('/orgs/partners/me/ip-allowlist/status')
        .then(r => (r.ok ? r.json() : Promise.reject(new Error('status fetch failed'))))
        .then((s: IpAllowlistStatus) => { if (isCurrent()) { setIpStatus(s); setIpStatusUnavailable(false); } })
        .catch(() => { if (isCurrent()) { setIpStatus(null); setIpStatusUnavailable(true); } });

      // Best-effort: registered versions for the pin selectors (#2124). On
      // failure the dropdowns offer "Latest promoted" only.
      fetchWithAuth('/agent-versions/pinnable')
        .then(r => (r.ok ? r.json() : Promise.reject(new Error('pinnable fetch failed'))))
        .then((p: PinnableVersions) => { if (isCurrent()) setPinnableVersions(p); })
        .catch(() => { if (isCurrent()) setPinnableVersions(null); });

      // Best-effort: decides whether the Sender Addresses tab appears at all.
      // A 404 means EMAIL_DOMAINS_PROVIDER is unset on this instance (the
      // default everywhere) and the tab stays hidden.
      fetchSendingDomains()
        .then(result => { if (isCurrent()) setSendingDomainsCapability(result.supported ? (result.data.capability ?? null) : null); })
        .catch(() => { if (isCurrent()) setSendingDomainsCapability(null); })
        .finally(() => { if (isCurrent()) setSendingDomainsChecked(true); });
    } catch (err) {
      if (!isCurrent()) return;
      setError(err instanceof Error ? err.message : i18n.t('settings:partnerSettingsPage.genericError'));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, []);

  /** Ends the loading state for a confirmed non-partner user (nothing to load). */
  const markNoPartner = useCallback(() => setLoading(false), []);

  const update = useCallback(<K extends keyof PartnersMeState>(key: K, value: PartnersMeState[K]) => {
    setState(prev => (prev ? { ...prev, [key]: value } : prev));
  }, []);

  // The parsed ladder reaches `aiBudgets` through the tab's own onChange.
  const setThresholdsRaw = useCallback((raw: string) => update('aiBudgetsThresholdsRaw', raw), [update]);

  /** An autosave control (the ML card) saved its own slice of the partner record; draft and baseline are untouched. */
  const patchPartnerSettings = useCallback((patch: Partial<Partner['settings']>) => {
    setPartner(p => (p ? { ...p, settings: { ...p.settings, ...patch } } : p));
  }, []);

  const dirtyTabs = useMemo(() => {
    const dirty: Partial<Record<TabKey, boolean>> = {};
    if (!state || !baseline) return dirty;
    const now = tabSnapshots(state);
    const base = tabSnapshots(baseline);
    for (const key of Object.keys(now) as PartnersMeTab[]) dirty[key] = now[key] !== base[key];
    return dirty;
  }, [state, baseline]);

  const validity = useMemo(() => (state ? partnersMeValidity(state) : {}), [state]);

  const dirtyRef = useRef(dirtyTabs);
  dirtyRef.current = dirtyTabs;
  const validityRef = useRef(validity);
  validityRef.current = validity;

  const save = useCallback(async (): Promise<SaveOutcome> => {
    const sent = stateRef.current;
    if (!sent) return { status: 'failed' };
    const gen = generation.current;
    if (!preflight(sent, ipRef.current.ipStatus, ipRef.current.ipStatusUnavailable)) return { status: 'cancelled' };
    setError(undefined);
    try {
      const updated = await runPartnerSave(buildPartnersMePayload(sent), { onUnauthorized: toLogin, silentSuccess: true });
      if (generation.current !== gen) return { status: 'cancelled' };
      setPartner(updated);
      // Lets layout islands that read partner settings (MfaPolicyOffBanner)
      // re-check without a page navigation, against a fresh read.
      invalidatePartnersMe();
      window.dispatchEvent(new Event(PARTNER_SETTINGS_SAVED_EVENT));
      // Re-baseline to what was sent: an edit made during the request stays dirty.
      setBaseline(sent);
      return { status: 'saved', savedAt: Date.now() };
    } catch (err) {
      if (generation.current !== gen) return { status: 'cancelled' };
      if (err instanceof ActionError && err.status === 401) return { status: 'failed' };
      // An ActionError was already toasted by runAction; anything else is shown on the page.
      if (!(err instanceof ActionError)) {
        setError(err instanceof Error ? err.message : i18n.t('settings:partnerSettingsPage.saveFailed'));
      }
      return { status: 'failed' };
    }
  }, []);

  const unit: SaveUnit = useMemo(() => ({
    id: 'partnersMe',
    tabs: UNIT_TABS.partnersMe,
    isDirty: () => Object.values(dirtyRef.current).some(Boolean),
    validity: () => validityRef.current,
    save,
  }), [save]);

  return {
    partner,
    state,
    /** The saved form state the draft is compared against. */
    baseline,
    update,
    setThresholdsRaw,
    patchPartnerSettings,
    loading,
    error,
    load,
    markNoPartner,
    dirtyTabs,
    validity,
    unit,
    ipStatus,
    ipStatusUnavailable,
    pinnableVersions,
    sendingDomainsCapability,
    sendingDomainsChecked,
  };
}
