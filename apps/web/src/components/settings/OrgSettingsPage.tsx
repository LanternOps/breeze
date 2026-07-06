import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Bell,
  Building2,
  CheckCircle2,
  Copy,
  Check,
  CreditCard,
  FileSignature,
  Fingerprint,
  Globe,
  Monitor,
  Paintbrush,
  ScrollText,
  Shield,
  Ticket
} from 'lucide-react';
import ContractsList from '../contracts/ContractsList';
import OrgBillingSettings from '../billing/OrgBillingSettings';
import SettingsSectionNav, { type SettingsNavGroup } from './SettingsSectionNav';
import OrgBrandingEditor from './OrgBrandingEditor';
import OrgPortalSettingsEditor from './OrgPortalSettingsEditor';
import OrgTicketSettingsEditor from './OrgTicketSettingsEditor';
import OrgDefaultsEditor from './OrgDefaultsEditor';
import type { PinnableVersions, AgentVersionPinsValue } from './AgentVersionPinSelectors';
import OrgNotificationSettings from './OrgNotificationSettings';
import OrgSecuritySettings from './OrgSecuritySettings';
import { OrgApprovalSecurityTab } from './OrgApprovalSecurityTab';
import OrgEventLogSettings from './OrgEventLogSettings';
import OrgRemoteAccessSettings from './OrgRemoteAccessSettings';
import { useOrgStore } from '../../stores/orgStore';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, ActionError } from '@/lib/runAction';
import { formatTime as formatUserTime } from '@/lib/dateTimeFormat';

type TabKey =
  | 'general' | 'branding' | 'portal' | 'notifications' | 'security'
  | 'approval-security' | 'event-logs' | 'remote-access' | 'ticketing' | 'contracts' | 'billing';

// Grouped sidebar definition — same anatomy as PartnerSettingsPage (shared
// SettingsSectionNav). Hashes are the section keys (already kebab-case).
const TAB_GROUPS: (Omit<SettingsNavGroup, 'items'> & { items: (SettingsNavGroup['items'][number] & { key: TabKey })[] })[] = [
  {
    label: 'Organization',
    items: [
      { key: 'general', hash: 'general', label: 'General', description: 'Profile and defaults', icon: Building2 },
      { key: 'contracts', hash: 'contracts', label: 'Contracts', description: 'Recurring agreements', icon: FileSignature },
      { key: 'billing', hash: 'billing', label: 'Billing', description: 'Tax and billing address', icon: CreditCard },
    ],
  },
  {
    label: 'Portal & Branding',
    items: [
      { key: 'branding', hash: 'branding', label: 'Branding', description: 'Portal theme and visuals', icon: Paintbrush },
      { key: 'portal', hash: 'portal', label: 'Customer Portal', description: 'Features and support', icon: Globe },
    ],
  },
  {
    label: 'Security & Access',
    items: [
      { key: 'security', hash: 'security', label: 'Security', description: 'Access policies and MFA', icon: Shield },
      { key: 'approval-security', hash: 'approval-security', label: 'Approval Security', description: 'Step-up verification', icon: Fingerprint },
      { key: 'remote-access', hash: 'remote-access', label: 'Remote Access', description: 'VNC, proxy, tunnels', icon: Monitor },
      { key: 'event-logs', hash: 'event-logs', label: 'Event Logs', description: 'Forwarding and retention', icon: ScrollText },
    ],
  },
  {
    label: 'Communications',
    items: [
      { key: 'notifications', hash: 'notifications', label: 'Notifications', description: 'Email, Slack, webhooks', icon: Bell },
      { key: 'ticketing', hash: 'ticketing', label: 'Ticketing', description: 'SLA and billing overrides', icon: Ticket },
    ],
  },
];

const ALL_TABS = TAB_GROUPS.flatMap(g => g.items);
const TAB_BY_KEY = Object.fromEntries(ALL_TABS.map(t => [t.key, t])) as Record<TabKey, (typeof ALL_TABS)[number]>;

function getTabFromHash(): TabKey | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash.replace('#', '');
  return hash in TAB_BY_KEY ? (hash as TabKey) : null;
}

type SaveState = {
  hasUnsavedChanges: boolean;
  // null until a real save happens this session — never fabricate a timestamp.
  lastSavedAt: string | null;
};

type OrgDetails = {
  id: string;
  name: string;
  slug: string;
  status: string;
  type?: string;
  maxDevices?: number;
  settings?: {
    branding?: {
      logoUrl?: string;
      primaryColor?: string;
      secondaryColor?: string;
      theme?: 'light' | 'dark' | 'system';
      customCss?: string;
      portalSubdomain?: string;
    };
    defaults?: {
      policyDefaults?: Record<string, string>;
      deviceGroup?: string;
      alertThreshold?: string;
      autoEnrollment?: {
        enabled: boolean;
        requireApproval: boolean;
        sendWelcome: boolean;
      };
      agentUpdatePolicy?: string;
      maintenanceWindow?: string;
    };
    notifications?: {
      fromAddress?: string;
      replyTo?: string;
      useCustomSmtp?: boolean;
      smtpHost?: string;
      smtpPort?: string;
      smtpUsername?: string;
      smtpEncryption?: string;
      slackWebhookUrl?: string;
      slackChannel?: string;
      webhooks?: string[];
      preferences?: Record<string, Record<string, boolean>>;
    };
    security?: {
      minLength?: number;
      complexity?: string;
      expirationDays?: number;
      requireMfa?: boolean;
      allowedMethods?: { totp: boolean; sms: boolean };
      sessionTimeout?: number;
      maxSessions?: number;
      ipAllowlist?: string;
    };
    mtls?: {
      certLifetimeDays?: number;
      expiredCertPolicy?: 'auto_reissue' | 'quarantine';
    };
    logForwarding?: {
      enabled?: boolean;
      elasticsearchUrl?: string;
      elasticsearchApiKey?: string;
      elasticsearchUsername?: string;
      elasticsearchPassword?: string;
      indexPrefix?: string;
    };
  };
  billingContact?: {
    name?: string;
    email?: string;
    phone?: string;
  };
  contractStart?: string;
  contractEnd?: string;
  createdAt: string;
  updatedAt?: string;
};

const formatTime = (date: Date) =>
  formatUserTime(date, { hour: 'numeric', minute: '2-digit' });

type OrgSettingsPageProps = {
  orgId?: string;
};

// Exported for unit-testing without mounting the full component.
export async function runOrgNameSave(
  orgId: string,
  name: string,
  deps: { onUnauthorized: () => void }
): Promise<OrgDetails> {
  return runAction<OrgDetails>({
    request: () =>
      fetchWithAuth(`/orgs/organizations/${orgId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name })
      }),
    successMessage: 'Organization name saved',
    errorFallback: 'Failed to save organization name',
    onUnauthorized: deps.onUnauthorized
  });
}

export default function OrgSettingsPage({ orgId: propOrgId }: OrgSettingsPageProps) {
  // Seeded SSR-safe with the default tab; the hash is applied client-side in
  // the effect below to avoid a hydration mismatch (same pattern as
  // PartnerSettingsPage). Also tracks back/forward via hashchange.
  const [activeTab, setActiveTab] = useState<TabKey>('general');

  useEffect(() => {
    const applyHash = () => {
      const tab = getTabFromHash();
      if (tab) setActiveTab(tab);
    };
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, []);

  const [saveState, setSaveState] = useState<SaveState>({
    hasUnsavedChanges: false,
    lastSavedAt: null
  });

  // Editors hold their own draft state and unmount on tab switch, so switching
  // away from a dirty section genuinely discards the edits — never do that
  // silently. (Dirty state always belongs to the ACTIVE tab: onDirty only
  // fires from the mounted editor, and we clear it here on a confirmed switch.)
  const switchTab = (tab: TabKey) => {
    if (tab === activeTab) return;
    if (saveState.hasUnsavedChanges) {
      const proceed = window.confirm(
        'You have unsaved changes in this section. Switching will discard them. Continue?'
      );
      if (!proceed) return;
      setSaveState(prev => ({ ...prev, hasUnsavedChanges: false }));
    }
    setActiveTab(tab);
    if (window.location.hash !== `#${tab}`) window.location.hash = tab;
  };

  // Warn before a full navigation away discards unsaved edits.
  useEffect(() => {
    if (!saveState.hasUnsavedChanges) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [saveState.hasUnsavedChanges]);
  const [orgDetails, setOrgDetails] = useState<OrgDetails | null>(null);
  const [locked, setLocked] = useState<string[]>([]);
  // Issue #2124: registered versions for the pin selectors + the partner's
  // effective pins (shown when `defaults.agentVersionPins` is partner-locked).
  const [pinnableVersions, setPinnableVersions] = useState<PinnableVersions | null>(null);
  const [partnerPins, setPartnerPins] = useState<AgentVersionPinsValue | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [copiedOrgId, setCopiedOrgId] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [typeDraft, setTypeDraft] = useState<string>('customer');
  const [savingType, setSavingType] = useState(false);

  const { currentOrgId, organizations } = useOrgStore();
  const effectiveOrgId = propOrgId || currentOrgId;

  const fetchOrgDetails = useCallback(async () => {
    if (!effectiveOrgId) {
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth(`/orgs/organizations/${effectiveOrgId}`);
      if (!response.ok) {
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        throw new Error('Failed to fetch organization details');
      }
      const data = await response.json();
      setOrgDetails(data);
      setNameDraft(data.name ?? '');
      setTypeDraft(data.type ?? 'customer');

      // Fetch effective settings to determine partner-locked fields
      const effRes = await fetchWithAuth(`/orgs/organizations/${effectiveOrgId}/effective-settings`);
      if (effRes.ok) {
        const effData = await effRes.json();
        const lockedList: string[] = effData.locked || [];
        setLocked(lockedList);
        // Issue #2124: pins are inherit-with-override, NOT enforced-locked (see the
        // assertNotLocked exemption in the org PATCH). But `locked` still carries
        // `defaults.agentVersionPins` when the PARTNER set one — we use that purely
        // as a "partner has a pin" signal so the effective value is the partner's
        // (not the org's own, which mergeCategory would surface when the partner
        // hasn't pinned). The org selector is never disabled by this.
        setPartnerPins(
          lockedList.includes('defaults.agentVersionPins')
            ? effData.effective?.defaults?.agentVersionPins
            : undefined,
        );
      } else {
        console.warn('[OrgSettingsPage] Failed to fetch effective settings:', effRes.status);
      }

      // Registered agent/watchdog versions for the pin selectors (#2124).
      // Isolated (own promise chain, not awaited in this try) so a network throw
      // or JSON-parse failure on this NON-critical picker feed can't blank the
      // whole settings page — it just leaves the dropdowns with "Latest promoted".
      fetchWithAuth('/agent-versions/pinnable')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
        .then((p: PinnableVersions) => setPinnableVersions(p))
        .catch((e) => {
          console.warn('[OrgSettingsPage] Failed to fetch pinnable versions:', e);
          setPinnableVersions(null);
        });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [effectiveOrgId]);

  useEffect(() => {
    fetchOrgDetails();
  }, [fetchOrgDetails]);

  const handleSaveSettings = useCallback(async (section: string, data: Record<string, unknown>) => {
    if (!effectiveOrgId) return;

    try {
      const currentSettings = orgDetails?.settings || {};
      const updatedSettings = {
        ...currentSettings,
        [section]: data
      };

      await runAction({
        request: () =>
          fetchWithAuth(`/orgs/organizations/${effectiveOrgId}`, {
            method: 'PATCH',
            body: JSON.stringify({ settings: updatedSettings })
          }),
        successMessage: 'Settings saved',
        errorFallback: 'Failed to save settings',
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });

      await fetchOrgDetails();
      setSaveState({
        hasUnsavedChanges: false,
        lastSavedAt: formatTime(new Date())
      });
    } catch (err) {
      // runAction already toasts non-401 ActionErrors; only surface unexpected errors.
      if (!(err instanceof ActionError)) {
        setError(err instanceof Error ? err.message : 'Failed to save settings');
      }
    }
  }, [effectiveOrgId, orgDetails, fetchOrgDetails]);

  const handleSaveName = useCallback(async () => {
    if (!effectiveOrgId) return;
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === orgDetails?.name) return;

    try {
      setSavingName(true);
      setError(undefined);
      await runOrgNameSave(effectiveOrgId, trimmed, {
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      await fetchOrgDetails();
    } catch (err) {
      // runAction already toasts non-401 ActionErrors; only surface unexpected errors.
      if (!(err instanceof ActionError)) {
        setError(err instanceof Error ? err.message : 'Failed to save organization name');
      }
    } finally {
      setSavingName(false);
    }
  }, [effectiveOrgId, nameDraft, orgDetails, fetchOrgDetails]);

  const handleSaveType = useCallback(async () => {
    if (!effectiveOrgId) return;
    if (typeDraft === (orgDetails?.type ?? 'customer')) return;

    try {
      setSavingType(true);
      setError(undefined);
      await runAction({
        request: () =>
          fetchWithAuth(`/orgs/organizations/${effectiveOrgId}`, {
            method: 'PATCH',
            body: JSON.stringify({ type: typeDraft })
          }),
        successMessage: 'Organization type saved',
        errorFallback: 'Failed to save organization type',
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });

      await fetchOrgDetails();
    } catch (err) {
      if (!(err instanceof ActionError)) {
        setError(err instanceof Error ? err.message : 'Failed to save organization type');
      }
    } finally {
      setSavingType(false);
    }
  }, [effectiveOrgId, typeDraft, fetchOrgDetails]);

  // Fallback display data — prefer fetched orgDetails; when accessed via URL prop the org
  // might not be in the store's organizations array, so fall back to a minimal object.
  const displayOrg = orgDetails || organizations.find(org => org.id === effectiveOrgId) || { id: effectiveOrgId, name: 'Organization' } as OrgDetails;

  // No fabricated timestamps: the pill only appears once there is something
  // true to say — unsaved edits exist, or a save actually happened.
  const statusLabel = useMemo(() => {
    if (saveState.hasUnsavedChanges) return 'Unsaved changes';
    if (saveState.lastSavedAt) return `Saved at ${saveState.lastSavedAt}`;
    return null;
  }, [saveState.hasUnsavedChanges, saveState.lastSavedAt]);

  const handleDirty = () => {
    setSaveState(prev => ({ ...prev, hasUnsavedChanges: true }));
  };

  const handleSave = (section?: string, data?: Record<string, unknown>) => {
    if (section && data) {
      handleSaveSettings(section, data);
    } else {
      setSaveState({
        hasUnsavedChanges: false,
        lastSavedAt: formatTime(new Date())
      });
    }
  };

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading organization settings...</p>
        </div>
      </div>
    );
  }

  // No organization selected
  if (!effectiveOrgId || !displayOrg) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-center dark:border-amber-800 dark:bg-amber-950">
        <Building2 className="mx-auto h-12 w-12 text-amber-500" />
        <h2 className="mt-4 text-lg font-semibold">No Organization Selected</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Please select an organization from the switcher in the header to view settings.
        </p>
      </div>
    );
  }

  // Full-page error only when there is nothing to show yet (initial load
  // failed). Later failures (e.g. a section save) render an inline banner
  // below instead — replacing the page here would destroy the user's form state.
  if (error && !orgDetails) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchOrgDetails}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  const renderContent = () => {
    switch (activeTab) {
      case 'branding':
        return (
          <OrgBrandingEditor
            organizationName={displayOrg.name}
            branding={orgDetails?.settings?.branding}
            onDirty={handleDirty}
            onSave={(data) => handleSave('branding', data)}
            locked={locked}
          />
        );
      case 'portal':
        return effectiveOrgId ? (
          <OrgPortalSettingsEditor
            orgId={effectiveOrgId}
            onDirty={handleDirty}
            onSave={() => handleSave()}
          />
        ) : null;
      case 'notifications':
        return (
          <OrgNotificationSettings
            notifications={orgDetails?.settings?.notifications}
            onDirty={handleDirty}
            onSave={(data) => handleSave('notifications', data)}
            locked={locked}
          />
        );
      case 'security':
        return (
          <OrgSecuritySettings
            security={orgDetails?.settings?.security}
            mtls={orgDetails?.settings?.mtls}
            onDirty={handleDirty}
            onSave={(data) => handleSave('security', data)}
            locked={locked}
          />
        );
      case 'approval-security':
        return <OrgApprovalSecurityTab />;
      case 'event-logs':
        return (
          <OrgEventLogSettings
            onDirty={handleDirty}
            locked={locked}
          />
        );
      case 'remote-access':
        return effectiveOrgId ? (
          <OrgRemoteAccessSettings
            orgId={effectiveOrgId}
            onDirty={handleDirty}
          />
        ) : null;
      case 'ticketing':
        return effectiveOrgId ? (
          <OrgTicketSettingsEditor
            orgId={effectiveOrgId}
            onDirty={handleDirty}
            onSave={() => handleSave()}
          />
        ) : null;
      case 'contracts':
        return effectiveOrgId ? (
          <div data-testid="org-tab-contracts">
            <ContractsList lockedOrgId={effectiveOrgId} />
          </div>
        ) : null;
      case 'billing':
        return effectiveOrgId ? (
          <div data-testid="org-tab-billing">
            <OrgBillingSettings orgId={effectiveOrgId} />
          </div>
        ) : null;
      case 'general':
      default:
        return (
          <div className="space-y-6">
            <section className="rounded-lg border bg-card p-6 shadow-xs">
              <div className="space-y-2">
                <h2 className="text-lg font-semibold">Organization overview</h2>
                <p className="text-sm text-muted-foreground">
                  Manage your organization profile and default experiences.
                </p>
              </div>
              <dl className="mt-6 grid gap-4 text-sm sm:grid-cols-2">
                <div className="rounded-md border bg-muted/40 p-4">
                  <dt className="text-xs uppercase text-muted-foreground">Organization name</dt>
                  <dd className="mt-2 flex items-center gap-2">
                    <input
                      type="text"
                      data-testid="org-name-input"
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          // handleSaveName guards empty/unchanged internally.
                          void handleSaveName();
                        }
                      }}
                      className="flex-1 rounded-md border bg-background px-3 py-1.5 text-base font-semibold focus:outline-hidden focus:ring-2 focus:ring-primary"
                      placeholder="Organization name"
                      aria-label="Organization name"
                    />
                    <button
                      type="button"
                      data-testid="org-name-save"
                      onClick={() => void handleSaveName()}
                      disabled={savingName || !nameDraft.trim() || nameDraft.trim() === orgDetails?.name}
                      className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {savingName ? 'Saving…' : 'Save'}
                    </button>
                  </dd>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {orgDetails?.slug || displayOrg.id}
                  </p>
                </div>
                <div className="rounded-md border bg-muted/40 p-4">
                  <dt className="text-xs uppercase text-muted-foreground">Status</dt>
                  <dd className="mt-2 text-base font-semibold capitalize">{displayOrg.status}</dd>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Created {new Date(displayOrg.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="rounded-md border bg-muted/40 p-4">
                  <dt className="text-xs uppercase text-muted-foreground">Type</dt>
                  <dd className="mt-2 flex items-center gap-2">
                    <select
                      data-testid="org-type-select"
                      value={typeDraft}
                      onChange={(e) => setTypeDraft(e.target.value)}
                      className="flex-1 rounded-md border bg-background px-3 py-1.5 text-base font-semibold focus:outline-hidden focus:ring-2 focus:ring-primary"
                      aria-label="Organization type"
                    >
                      <option value="customer">Customer</option>
                      <option value="internal">Internal</option>
                    </select>
                    <button
                      type="button"
                      data-testid="org-type-save"
                      onClick={() => void handleSaveType()}
                      disabled={savingType || typeDraft === (orgDetails?.type ?? 'customer')}
                      className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {savingType ? 'Saving…' : 'Save'}
                    </button>
                  </dd>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {orgDetails?.maxDevices ? `Max ${orgDetails.maxDevices} devices` : 'Unlimited devices'}
                  </p>
                </div>
                <div className="rounded-md border bg-muted/40 p-4">
                  <dt className="text-xs uppercase text-muted-foreground">Contract</dt>
                  <dd className="mt-2 text-base font-semibold">
                    {orgDetails?.contractEnd
                      ? new Date(orgDetails.contractEnd).toLocaleDateString()
                      : 'No end date'}
                  </dd>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {orgDetails?.contractStart
                      ? `Started ${new Date(orgDetails.contractStart).toLocaleDateString()}`
                      : 'No contract dates set'}
                  </p>
                </div>
                <div className="rounded-md border bg-muted/40 p-4 sm:col-span-2">
                  <dt className="text-xs uppercase text-muted-foreground">Organization ID</dt>
                  <dd className="mt-2 flex items-center gap-2">
                    <code className="rounded bg-muted px-2 py-1 font-mono text-sm">{displayOrg.id}</code>
                    <button
                      type="button"
                      className="inline-flex items-center rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                      title="Copy Organization ID"
                      aria-label="Copy Organization ID"
                      onClick={() => {
                        navigator.clipboard.writeText(displayOrg.id);
                        setCopiedOrgId(true);
                        setTimeout(() => setCopiedOrgId(false), 2000);
                      }}
                    >
                      {copiedOrgId ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                    </button>
                  </dd>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Use this ID when inviting users or configuring integrations.
                  </p>
                </div>
              </dl>
            </section>
            <OrgDefaultsEditor
              organizationName={displayOrg.name}
              defaults={orgDetails?.settings?.defaults}
              onDirty={handleDirty}
              onSave={(data) => handleSave('defaults', data)}
              pinnableVersions={pinnableVersions}
              partnerPins={partnerPins}
            />
          </div>
        );
    }
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      {propOrgId && (
        <>
          <nav className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
            <a href="/settings" className="hover:text-foreground">Settings</a>
            <span>/</span>
            <a href="/settings/organizations" className="hover:text-foreground">Organizations</a>
            <span>/</span>
            <span className="text-foreground">{displayOrg.name}</span>
          </nav>
          <a href="/settings/organizations" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
            Back to Organizations
          </a>
        </>
      )}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Organization settings</h1>
          <p className="text-sm text-muted-foreground">
            Configure preferences for {displayOrg.name}.
          </p>
        </div>
        {statusLabel && (
          <div className="flex items-center gap-2 rounded-full border bg-card px-4 py-2 text-sm">
            {saveState.hasUnsavedChanges ? (
              <AlertTriangle className="h-4 w-4 text-amber-500" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            )}
            <span className="text-xs font-medium">{statusLabel}</span>
          </div>
        )}
      </header>

      {saveState.hasUnsavedChanges ? (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-900">
          <AlertTriangle className="mt-0.5 h-5 w-5" />
          <div>
            <p className="text-sm font-medium">
              You have unsaved changes in {TAB_BY_KEY[activeTab].label}
            </p>
            <p className="text-xs text-amber-800">
              Save in that section to keep your updates.
            </p>
          </div>
        </div>
      ) : null}

      {error && orgDetails && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-destructive">
          <p className="text-sm">{error}</p>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <SettingsSectionNav
          groups={TAB_GROUPS.map(group => ({
            label: group.label,
            items: group.items.map(item => ({
              ...item,
              dirty: saveState.hasUnsavedChanges && item.key === activeTab,
            })),
          }))}
          activeKey={activeTab}
          onNavigate={key => switchTab(key as TabKey)}
          selectId="org-settings-section"
        />

        <div className="min-w-0 space-y-6">{renderContent()}</div>
      </div>
    </div>
  );
}
