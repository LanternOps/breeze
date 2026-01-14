import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  Building2,
  CheckCircle2,
  CreditCard,
  Paintbrush,
  Shield
} from 'lucide-react';
import OrgBrandingEditor from './OrgBrandingEditor';
import OrgDefaultsEditor from './OrgDefaultsEditor';
import OrgNotificationSettings from './OrgNotificationSettings';
import OrgSecuritySettings from './OrgSecuritySettings';
import OrgBillingInfo from './OrgBillingInfo';

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
    id: 'billing',
    label: 'Billing',
    description: 'Plan, usage, and invoices',
    icon: CreditCard
  }
] as const;

type TabKey = (typeof tabs)[number]['id'];

type SaveState = {
  hasUnsavedChanges: boolean;
  lastSavedAt: string;
};

const mockOrganization = {
  name: 'Breeze Labs',
  slug: 'breeze-labs',
  owner: 'ops@breeze.io',
  region: 'us-east-1',
  plan: 'Growth',
  createdAt: 'Apr 12, 2022',
  members: 42,
  sites: 8
};

const formatTime = (date: Date) =>
  date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export default function OrgSettingsPage() {
  const [activeTab, setActiveTab] = useState<TabKey>('general');
  const [saveState, setSaveState] = useState<SaveState>({
    hasUnsavedChanges: false,
    lastSavedAt: formatTime(new Date())
  });

  const statusLabel = useMemo(() => {
    if (saveState.hasUnsavedChanges) {
      return 'Unsaved changes';
    }

    return `Saved at ${saveState.lastSavedAt}`;
  }, [saveState.hasUnsavedChanges, saveState.lastSavedAt]);

  const handleDirty = () => {
    setSaveState(prev => ({ ...prev, hasUnsavedChanges: true }));
  };

  const handleSave = () => {
    setSaveState({
      hasUnsavedChanges: false,
      lastSavedAt: formatTime(new Date())
    });
  };

  const renderContent = () => {
    switch (activeTab) {
      case 'branding':
        return <OrgBrandingEditor onDirty={handleDirty} onSave={handleSave} />;
      case 'notifications':
        return <OrgNotificationSettings onDirty={handleDirty} onSave={handleSave} />;
      case 'security':
        return <OrgSecuritySettings onDirty={handleDirty} onSave={handleSave} />;
      case 'billing':
        return <OrgBillingInfo />;
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
                  <dd className="mt-2 text-base font-semibold">{mockOrganization.name}</dd>
                  <p className="mt-1 text-xs text-muted-foreground">{mockOrganization.owner}</p>
                </div>
                <div className="rounded-md border bg-muted/40 p-4">
                  <dt className="text-xs uppercase text-muted-foreground">Plan</dt>
                  <dd className="mt-2 text-base font-semibold">{mockOrganization.plan}</dd>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Active since {mockOrganization.createdAt}
                  </p>
                </div>
                <div className="rounded-md border bg-muted/40 p-4">
                  <dt className="text-xs uppercase text-muted-foreground">Region</dt>
                  <dd className="mt-2 text-base font-semibold">{mockOrganization.region}</dd>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {mockOrganization.sites} sites connected
                  </p>
                </div>
                <div className="rounded-md border bg-muted/40 p-4">
                  <dt className="text-xs uppercase text-muted-foreground">Members</dt>
                  <dd className="mt-2 text-base font-semibold">{mockOrganization.members}</dd>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Default slug {mockOrganization.slug}
                  </p>
                </div>
              </dl>
            </section>
            <OrgDefaultsEditor onDirty={handleDirty} onSave={handleSave} />
          </div>
        );
    }
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Organization settings</h1>
          <p className="text-sm text-muted-foreground">
            Configure preferences for {mockOrganization.name}.
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
                  onClick={() => setActiveTab(tab.id)}
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
