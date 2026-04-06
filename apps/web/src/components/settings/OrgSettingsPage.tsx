import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Bell,
  Building2,
  CheckCircle2,
  Copy,
  Check,
  Monitor,
  Paintbrush,
  ScrollText,
  Shield
} from 'lucide-react';
import OrgBrandingEditor from './OrgBrandingEditor';
import OrgDefaultsEditor from './OrgDefaultsEditor';
import OrgNotificationSettings from './OrgNotificationSettings';
import OrgSecuritySettings from './OrgSecuritySettings';
import OrgEventLogSettings from './OrgEventLogSettings';
import OrgRemoteAccessSettings from './OrgRemoteAccessSettings';
import { useOrgStore } from '../../stores/orgStore';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';

const tabs = [
  {
    id: 'general',
    label: 'General',
    description: 'Organization profile and defaults',
    icon: Building2
  },
  {
    id: 'branding',
    label: 'Branding',
    description: 'Portal theme and visuals',
    icon: Paintbrush
  },
  {
    id: 'notifications',
    label: 'Notifications',
    description: 'Email, Slack, and webhooks',
    icon: Bell
  },
  {
    id: 'security',
    label: 'Security',
    description: 'Access policies and MFA',
    icon: Shield
  },
  {
    id: 'event-logs',
    label: 'Event Logs',
    description: 'Forwarding and retention',
    icon: ScrollText
  },
  {
    id: 'remote-access',
    label: 'Remote Access',
    description: 'VNC, proxy, and tunnel settings',
    icon: Monitor
  }
] as const;

type TabKey = (typeof tabs)[number]['id'];

const VALID_TABS = tabs.map(t => t.id) as unknown as TabKey[];

function getTabFromHash(): TabKey {
  if (typeof window === 'undefined') return 'general';
  const hash = window.location.hash.replace('#', '');
  if (VALID_TABS.includes(hash as TabKey)) return hash as TabKey;
  return 'general';
}

type SaveState = {
  hasUnsavedChanges: boolean;
  lastSavedAt: string;
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

// Fixed reference time for SSR hydration consistency
const REFERENCE_TIME = '12:00 PM';

const formatTime = (date: Date) =>
  date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

type OrgSettingsPageProps = {
  orgId?: string;
};

export default function OrgSettingsPage({ orgId: propOrgId }: OrgSettingsPageProps) {
  const [activeTab, setActiveTab] = useState<TabKey>(getTabFromHash);

  useEffect(() => {
    const onHashChange = () => setActiveTab(getTabFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const switchTab = (tab: TabKey) => {
    window.location.hash = tab;
    setActiveTab(tab);
  };

  const [saveState, setSaveState] = useState<SaveState>({
    hasUnsavedChanges: false,
    lastSavedAt: REFERENCE_TIME
  });
  const [orgDetails, setOrgDetails] = useState<OrgDetails | null>(null);
  const [locked, setLocked] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [copiedOrgId, setCopiedOrgId] = useState(false);

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

      // Fetch effective settings to determine partner-locked fields
      const effRes = await fetchWithAuth(`/orgs/organizations/${effectiveOrgId}/effective-settings`);
      if (effRes.ok) {
        const effData = await effRes.json();
        setLocked(effData.locked || []);
      } else {
        console.warn('[OrgSettingsPage] Failed to fetch effective settings:', effRes.status);
      }
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

      const response = await fetchWithAuth(`/orgs/organizations/${effectiveOrgId}`, {
        method: 'PATCH',
        body: JSON.stringify({ settings: updatedSettings })
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || body.message || 'Failed to save settings');
      }

      await fetchOrgDetails();
      setSaveState({
        hasUnsavedChanges: false,
        lastSavedAt: formatTime(new Date())
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    }
  }, [effectiveOrgId, orgDetails, fetchOrgDetails]);

  // Fallback display data — prefer fetched orgDetails; when accessed via URL prop the org
  // might not be in the store's organizations array, so fall back to a minimal object.
  const displayOrg = orgDetails || organizations.find(org => org.id === effectiveOrgId) || { id: effectiveOrgId, name: 'Organization' } as OrgDetails;

  const statusLabel = useMemo(() => {
    if (saveState.hasUnsavedChanges) {
      return 'Unsaved changes';
    }

    return `Saved at ${saveState.lastSavedAt}`;
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

  // Error state
  if (error) {
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
      case 'general':
      default:
        return (
          <div className="space-y-6">
            <section className="rounded-lg border bg-card p-6 shadow-sm">
              <div className="space-y-2">
                <h2 className="text-lg font-semibold">Organization overview</h2>
                <p className="text-sm text-muted-foreground">
                  Manage your organization profile and default experiences.
                </p>
              </div>
              <dl className="mt-6 grid gap-4 text-sm sm:grid-cols-2">
                <div className="rounded-md border bg-muted/40 p-4">
                  <dt className="text-xs uppercase text-muted-foreground">Organization</dt>
                  <dd className="mt-2 text-base font-semibold">{displayOrg.name}</dd>
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
                  <dd className="mt-2 text-base font-semibold capitalize">
                    {orgDetails?.type || 'Customer'}
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
        <div className="flex items-center gap-2 rounded-full border bg-card px-4 py-2 text-sm">
          {saveState.hasUnsavedChanges ? (
            <AlertTriangle className="h-4 w-4 text-amber-500" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          )}
          <span className="text-xs font-medium">{statusLabel}</span>
        </div>
      </header>

      {saveState.hasUnsavedChanges ? (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-900">
          <AlertTriangle className="mt-0.5 h-5 w-5" />
          <div>
            <p className="text-sm font-medium">You have unsaved changes</p>
            <p className="text-xs text-amber-800">
              Review each section and save to keep your updates.
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
        <aside className="space-y-2 rounded-lg border bg-card p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Settings
          </p>
          <nav className="space-y-1">
            {tabs.map(tab => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;

              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => switchTab(tab.id)}
                  className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition ${
                    isActive
                      ? 'bg-muted font-semibold text-foreground'
                      : 'text-muted-foreground hover:bg-muted/60'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  <div>
                    <p>{tab.label}</p>
                    <p className="text-xs text-muted-foreground">{tab.description}</p>
                  </div>
                </button>
              );
            })}
          </nav>
        </aside>

        <main className="space-y-6">{renderContent()}</main>
      </div>
    </div>
  );
}
