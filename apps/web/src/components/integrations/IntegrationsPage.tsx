import { useState } from 'react';
import {
  Activity,
  Boxes,
  MessageSquare,
  Plug,
  Shield,
  Users,
  Webhook
} from 'lucide-react';
import WebhooksPage from '../webhooks/WebhooksPage';
import CommunicationIntegrations from './CommunicationIntegrations';
import PsaConnectionsPage from '../psa/PsaConnectionsPage';
import SecurityIntegration from './SecurityIntegration';
import HuntressIntegration from './HuntressIntegration';
import MonitoringIntegration from './MonitoringIntegration';
import GoogleWorkspaceIntegration from './GoogleWorkspaceIntegration';
import M365Integration from './M365Integration';
import Pax8Integration from './Pax8Integration';
import TdSynnexCatalogPanel from '../settings/TdSynnexCatalogPanel';
import TdSynnexEcExpressPanel from '../settings/TdSynnexEcExpressPanel';
import { getJwtClaims } from '../../lib/authScope';

type TabId = 'webhooks' | 'notifications' | 'psa' | 'security' | 'monitoring' | 'identity' | 'distributors';
type SecuritySubTab = 'sentinelone' | 'huntress';
type IdentitySubTab = 'google' | 'm365';
type DistributorSubTab = 'pax8' | 'tdsynnex' | 'tdsynnex-ec';

const tabs: { id: TabId; label: string; icon: typeof Activity }[] = [
  { id: 'webhooks', label: 'Webhooks', icon: Webhook },
  { id: 'notifications', label: 'Notifications', icon: MessageSquare },
  { id: 'psa', label: 'PSA', icon: Plug },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'monitoring', label: 'Monitoring', icon: Activity },
  { id: 'identity', label: 'Identity', icon: Users },
  { id: 'distributors', label: 'Distributors', icon: Boxes },
];

const securitySubTabs: { id: SecuritySubTab; label: string }[] = [
  { id: 'sentinelone', label: 'SentinelOne' },
  { id: 'huntress', label: 'Huntress' },
];

const identitySubTabs: { id: IdentitySubTab; label: string }[] = [
  { id: 'google', label: 'Google Workspace' },
  { id: 'm365', label: 'Microsoft 365' },
];

const distributorSubTabs: { id: DistributorSubTab; label: string }[] = [
  { id: 'pax8', label: 'Pax8' },
  // Digital Bridge "TD SYNNEX" tab is hidden for now — that API is transactional
  // only and exposes no catalog/price surface. The panel, routes, and service
  // remain; re-add this entry to restore the tab.
  { id: 'tdsynnex-ec', label: 'TD SYNNEX Pricing' },
];

interface IntegrationsPageProps {
  initialTab?: TabId;
}

export default function IntegrationsPage({ initialTab = 'webhooks' }: IntegrationsPageProps) {
  // Deep-link support: the URL hash selects the initial tab — and sub-tab — on
  // load, e.g. /integrations#psa or /integrations#huntress. Used by the legacy
  // /settings/integrations/* routes, which now 301-redirect here with a hash. A
  // sub-tab hash (e.g. #huntress) also activates its parent tab.
  const initialFromHash: {
    tab: TabId;
    securitySub?: SecuritySubTab;
    identitySub?: IdentitySubTab;
    distributorSub?: DistributorSubTab;
  } = (() => {
    if (typeof window === 'undefined') return { tab: initialTab };
    const hash = window.location.hash.replace(/^#/, '');
    if (tabs.some((t) => t.id === hash)) return { tab: hash as TabId };
    if (securitySubTabs.some((s) => s.id === hash)) return { tab: 'security', securitySub: hash as SecuritySubTab };
    if (identitySubTabs.some((s) => s.id === hash)) return { tab: 'identity', identitySub: hash as IdentitySubTab };
    if (distributorSubTabs.some((s) => s.id === hash)) return { tab: 'distributors', distributorSub: hash as DistributorSubTab };
    return { tab: initialTab };
  })();
  const [activeTab, setActiveTab] = useState<TabId>(initialFromHash.tab);
  const [securitySubTab, setSecuritySubTab] = useState<SecuritySubTab>(initialFromHash.securitySub ?? 'sentinelone');
  const [identitySubTab, setIdentitySubTab] = useState<IdentitySubTab>(initialFromHash.identitySub ?? 'google');
  const [distributorSubTab, setDistributorSubTab] = useState<DistributorSubTab>(initialFromHash.distributorSub ?? 'pax8');

  // Pax8 and TD SYNNEX APIs both enforce requireScope('partner','system'). Gate
  // the Distributors tab on the JWT scope (never on useOrgStore().partners.length,
  // which is empty for real partner users — a known broken anti-pattern here) so
  // org-scope users get a clear message instead of 403 errors. getJwtClaims returns
  // null scope on a missing/undecodable token, so only a confirmed 'organization'
  // scope is blocked; everything else falls through to the server's own check.
  const isOrgScoped = getJwtClaims().scope === 'organization';

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

      {/* Distributor sub-tabs (hidden for org-scope users, who can't use these APIs) */}
      {activeTab === 'distributors' && !isOrgScoped && (
        <div className="flex gap-2">
          {distributorSubTabs.map((sub) => {
            const isActive = sub.id === distributorSubTab;
            return (
              <button
                key={sub.id}
                type="button"
                onClick={() => setDistributorSubTab(sub.id)}
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
      {activeTab === 'notifications' && <CommunicationIntegrations />}
      {activeTab === 'psa' && <PsaConnectionsPage />}
      {activeTab === 'security' && securitySubTab === 'sentinelone' && <SecurityIntegration />}
      {activeTab === 'security' && securitySubTab === 'huntress' && <HuntressIntegration />}
      {activeTab === 'monitoring' && <MonitoringIntegration />}
      {activeTab === 'identity' && identitySubTab === 'google' && <GoogleWorkspaceIntegration />}
      {activeTab === 'identity' && identitySubTab === 'm365' && <M365Integration />}
      {activeTab === 'distributors' && isOrgScoped && (
        <p
          className="py-12 text-center text-sm text-muted-foreground"
          data-testid="distributors-org-scope"
        >
          Distributor integrations (Pax8 and TD SYNNEX) are available to partner accounts only.
        </p>
      )}
      {activeTab === 'distributors' && !isOrgScoped && distributorSubTab === 'pax8' && <Pax8Integration />}
      {activeTab === 'distributors' && !isOrgScoped && distributorSubTab === 'tdsynnex' && <TdSynnexCatalogPanel />}
      {activeTab === 'distributors' && !isOrgScoped && distributorSubTab === 'tdsynnex-ec' && <TdSynnexEcExpressPanel />}
    </div>
  );
}
