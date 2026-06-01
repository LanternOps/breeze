import { useState } from 'react';
import {
  Activity,
  Plug,
  Shield,
  Users,
  Webhook
} from 'lucide-react';
import WebhooksPage from '../webhooks/WebhooksPage';
import PsaConnectionsPage from '../psa/PsaConnectionsPage';
import SecurityIntegration from './SecurityIntegration';
import HuntressIntegration from './HuntressIntegration';
import MonitoringIntegration from './MonitoringIntegration';
import GoogleWorkspaceIntegration from './GoogleWorkspaceIntegration';
import M365Integration from './M365Integration';

type TabId = 'webhooks' | 'psa' | 'security' | 'monitoring' | 'identity';
type SecuritySubTab = 'sentinelone' | 'huntress';
type IdentitySubTab = 'google' | 'm365';

const tabs: { id: TabId; label: string; icon: typeof Activity }[] = [
  { id: 'webhooks', label: 'Webhooks', icon: Webhook },
  { id: 'psa', label: 'PSA', icon: Plug },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'monitoring', label: 'Monitoring', icon: Activity },
  { id: 'identity', label: 'Identity', icon: Users },
];

const securitySubTabs: { id: SecuritySubTab; label: string }[] = [
  { id: 'sentinelone', label: 'SentinelOne' },
  { id: 'huntress', label: 'Huntress' },
];

const identitySubTabs: { id: IdentitySubTab; label: string }[] = [
  { id: 'google', label: 'Google Workspace' },
  { id: 'm365', label: 'Microsoft 365' },
];

interface IntegrationsPageProps {
  initialTab?: TabId;
}

export default function IntegrationsPage({ initialTab = 'webhooks' }: IntegrationsPageProps) {
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);
  const [securitySubTab, setSecuritySubTab] = useState<SecuritySubTab>('sentinelone');
  const [identitySubTab, setIdentitySubTab] = useState<IdentitySubTab>('google');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Integrations</h1>
        <p className="text-sm text-muted-foreground">
          Manage all connections and keep automation workflows healthy.
        </p>
      </div>

      {/* Top-level tabs */}
      <div className="flex flex-wrap gap-3">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-3 rounded-full border px-4 py-2 text-sm transition ${
                isActive
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-background text-muted-foreground hover:text-foreground'
              }`}
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted/60">
                <Icon className="h-4 w-4" />
              </span>
              <span className="font-medium">{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Security sub-tabs */}
      {activeTab === 'security' && (
        <div className="flex gap-2">
          {securitySubTabs.map((sub) => {
            const isActive = sub.id === securitySubTab;
            return (
              <button
                key={sub.id}
                type="button"
                onClick={() => setSecuritySubTab(sub.id)}
                className={`rounded-md border px-3 py-1.5 text-sm font-medium transition ${
                  isActive
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-background text-muted-foreground hover:text-foreground'
                }`}
              >
                {sub.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Identity sub-tabs */}
      {activeTab === 'identity' && (
        <div className="flex gap-2">
          {identitySubTabs.map((sub) => {
            const isActive = sub.id === identitySubTab;
            return (
              <button
                key={sub.id}
                type="button"
                onClick={() => setIdentitySubTab(sub.id)}
                className={`rounded-md border px-3 py-1.5 text-sm font-medium transition ${
                  isActive
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-background text-muted-foreground hover:text-foreground'
                }`}
              >
                {sub.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Tab content */}
      {activeTab === 'webhooks' && <WebhooksPage />}
      {activeTab === 'psa' && <PsaConnectionsPage />}
      {activeTab === 'security' && securitySubTab === 'sentinelone' && <SecurityIntegration />}
      {activeTab === 'security' && securitySubTab === 'huntress' && <HuntressIntegration />}
      {activeTab === 'monitoring' && <MonitoringIntegration />}
      {activeTab === 'identity' && identitySubTab === 'google' && <GoogleWorkspaceIntegration />}
      {activeTab === 'identity' && identitySubTab === 'm365' && <M365Integration />}
    </div>
  );
}
