import { useCallback, useEffect, useState } from 'react';
import { Network, Plug, ListChecks, ScrollText } from 'lucide-react';
import DnsSecurityIntegrationsTab from './DnsSecurityIntegrationsTab';
import DnsSecurityPoliciesTab from './DnsSecurityPoliciesTab';
import DnsSecurityEventsTab from './DnsSecurityEventsTab';
import DnsSecurityOverviewTab from './DnsSecurityOverviewTab';

type Tab = 'overview' | 'integrations' | 'policies' | 'events';

const VALID_TABS: readonly Tab[] = ['overview', 'integrations', 'policies', 'events'];

function readTabFromHash(): Tab {
  if (typeof window === 'undefined') return 'overview';
  const hash = window.location.hash.replace('#', '');
  return (VALID_TABS as readonly string[]).includes(hash) ? (hash as Tab) : 'overview';
}

export default function DnsSecurityPage() {
  const [activeTab, setActiveTab] = useState<Tab>(readTabFromHash);

  // Reflect tab into URL hash per the CLAUDE.md "URL State in Components"
  // rule — matches DeviceDetails.tsx / OrganizationsPage.tsx.
  const switchTab = useCallback((tab: Tab) => {
    window.location.hash = tab;
    setActiveTab(tab);
  }, []);

  useEffect(() => {
    const onHashChange = () => setActiveTab(readTabFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">DNS Security</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            DNS filtering integrations, blocklist/allowlist policies, and threat events
            across Umbrella, Cloudflare Gateway, DNSFilter, Pi-hole, OpenDNS, Quad9, and AdGuard Home.
          </p>
        </div>
      </header>

      <nav className="flex gap-1 border-b">
        <TabButton active={activeTab === 'overview'} onClick={() => switchTab('overview')} icon={<Network className="h-4 w-4" />}>
          Overview
        </TabButton>
        <TabButton active={activeTab === 'integrations'} onClick={() => switchTab('integrations')} icon={<Plug className="h-4 w-4" />}>
          Integrations
        </TabButton>
        <TabButton active={activeTab === 'policies'} onClick={() => switchTab('policies')} icon={<ListChecks className="h-4 w-4" />}>
          Policies
        </TabButton>
        <TabButton active={activeTab === 'events'} onClick={() => switchTab('events')} icon={<ScrollText className="h-4 w-4" />}>
          Events
        </TabButton>
      </nav>

      <div role="tabpanel">
        {activeTab === 'overview' && <DnsSecurityOverviewTab />}
        {activeTab === 'integrations' && <DnsSecurityIntegrationsTab />}
        {activeTab === 'policies' && <DnsSecurityPoliciesTab />}
        {activeTab === 'events' && <DnsSecurityEventsTab />}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
        active
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

