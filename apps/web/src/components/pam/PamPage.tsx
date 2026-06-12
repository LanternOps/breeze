import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Inbox, ListChecks, ScrollText } from 'lucide-react';
import { useEventStream } from '../../hooks/useEventStream';
import PamOverviewTab from './PamOverviewTab';
import PamRequestsTab from './PamRequestsTab';
import PamRulesTab from './PamRulesTab';
import PamAuditTab from './PamAuditTab';

const VALID_TABS = ['overview', 'requests', 'rules', 'audit'] as const;
type Tab = (typeof VALID_TABS)[number];

const ELEVATION_EVENTS = [
  'elevation.requested',
  'elevation.auto_approved',
  'elevation.approved',
  'elevation.denied',
  'elevation.activated',
  'elevation.expired',
  'elevation.revoked',
];

function readTabFromHash(): Tab {
  if (typeof window === 'undefined') return 'overview';
  const hash = window.location.hash.replace('#', '');
  return (VALID_TABS as readonly string[]).includes(hash) ? (hash as Tab) : 'overview';
}

export default function PamPage() {
  const [activeTab, setActiveTab] = useState<Tab>(readTabFromHash);
  // Bumped on every elevation.* event (debounced); tabs refetch when it changes.
  const [liveTick, setLiveTick] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const switchTab = useCallback((tab: Tab) => {
    window.location.hash = tab;
    setActiveTab(tab);
  }, []);

  useEffect(() => {
    const onHashChange = () => setActiveTab(readTabFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const { connected, subscribe, unsubscribe } = useEventStream({
    onEvent: (event) => {
      if (!event.type.startsWith('elevation.')) return;
      // Debounce bursty event storms into a single refetch.
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => setLiveTick((t) => t + 1), 750);
    },
  });

  useEffect(() => {
    subscribe(ELEVATION_EVENTS);
    return () => {
      unsubscribe(ELEVATION_EVENTS);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [subscribe, unsubscribe]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="pam-heading">
            Privileged Access
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Elevation requests, approval rules, and audit history across the fleet.
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
            connected
              ? 'bg-green-500/15 text-green-600 dark:text-green-400'
              : 'bg-muted text-muted-foreground'
          }`}
          data-testid="pam-live-indicator"
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-green-500' : 'bg-muted-foreground'}`}
          />
          {connected ? 'Live' : 'Offline'}
        </span>
      </div>

      <div role="tablist" className="flex gap-1 border-b">
        <TabButton
          active={activeTab === 'overview'}
          onClick={() => switchTab('overview')}
          icon={<Activity className="h-4 w-4" />}
          testId="pam-tab-overview"
        >
          Overview
        </TabButton>
        <TabButton
          active={activeTab === 'requests'}
          onClick={() => switchTab('requests')}
          icon={<Inbox className="h-4 w-4" />}
          testId="pam-tab-requests"
        >
          Requests
        </TabButton>
        <TabButton
          active={activeTab === 'rules'}
          onClick={() => switchTab('rules')}
          icon={<ListChecks className="h-4 w-4" />}
          testId="pam-tab-rules"
        >
          Rules
        </TabButton>
        <TabButton
          active={activeTab === 'audit'}
          onClick={() => switchTab('audit')}
          icon={<ScrollText className="h-4 w-4" />}
          testId="pam-tab-audit"
        >
          Audit
        </TabButton>
      </div>

      {activeTab === 'overview' && <PamOverviewTab liveTick={liveTick} />}
      {activeTab === 'requests' && <PamRequestsTab liveTick={liveTick} />}
      {activeTab === 'rules' && <PamRulesTab />}
      {activeTab === 'audit' && <PamAuditTab liveTick={liveTick} />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  testId,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      data-testid={testId}
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
