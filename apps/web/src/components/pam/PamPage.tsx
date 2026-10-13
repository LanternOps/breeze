import '@/lib/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useHashTab } from '@/lib/useHashState';
import { Activity, Inbox, ListChecks, ScrollText, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useEventStream } from '../../hooks/useEventStream';
import PamOverviewTab from './PamOverviewTab';
import PamRequestsTab from './PamRequestsTab';
import PamRulesTab from './PamRulesTab';
import PamSignerGroupsTab from './PamSignerGroupsTab';
import PamAuditTab from './PamAuditTab';

const VALID_TABS = ['overview', 'requests', 'rules', 'signer-groups', 'audit'] as const;
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

const DISCONNECTED_REFRESH_MS = 10_000;
const CONNECTED_REFRESH_MS = 30_000;

export default function PamPage() {
  const { t } = useTranslation('security');
  // SSR-safe hash tab (#2421): starts at the default, adopts the hash post-mount.
  const [activeTab, setActiveTab] = useHashTab<Tab>(VALID_TABS, 'overview');
  // Bumped on every elevation.* event (debounced); tabs refetch when it changes.
  const [liveTick, setLiveTick] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    if (document.visibilityState === 'hidden') return;
    setLiveTick((tick) => tick + 1);
  }, []);

  const switchTab = useCallback((tab: Tab) => {
    window.location.hash = tab;
    setActiveTab(tab);
  }, [setActiveTab]);

  const { connected, subscribe, unsubscribe } = useEventStream({
    // The stream does not replay events missed while disconnected.
    onConnected: refresh,
    onEvent: (event) => {
      if (!event.type.startsWith('elevation.')) return;
      // Coalesce bursts without postponing refresh indefinitely during a storm.
      if (debounceRef.current) return;
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        refresh();
      }, 750);
    },
  });

  useEffect(() => {
    subscribe(ELEVATION_EVENTS);
    return () => {
      unsubscribe(ELEVATION_EVENTS);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [subscribe, unsubscribe]);

  useEffect(() => {
    // Some deployments or scopes cannot establish the event stream. Keep the
    // visible page current there, and periodically reconcile missed live events.
    const timer = setInterval(refresh, connected ? CONNECTED_REFRESH_MS : DISCONNECTED_REFRESH_MS);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [connected, refresh]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="pam-heading">
            {t('pamPamPage.heading', { defaultValue: 'Privileged Access' })}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('pamPamPage.description', {
              defaultValue: 'Elevation requests, approval rules, and audit history across the fleet.',
            })}
          </p>
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
            connected
              ? 'border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400'
              : 'border-border bg-muted text-muted-foreground'
          }`}
          data-testid="pam-live-indicator"
        >
          <span className="relative flex h-1.5 w-1.5">
            {connected && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-60 motion-reduce:hidden" />
            )}
            <span
              className={`relative inline-flex h-1.5 w-1.5 rounded-full ${connected ? 'bg-green-500' : 'bg-muted-foreground'}`}
            />
          </span>
          {connected
            ? t('pamPamPage.liveStatus.live', { defaultValue: 'Live' })
            : t('pamPamPage.liveStatus.offline', { defaultValue: 'Offline' })}
        </span>
      </div>

      <div role="tablist" className="flex gap-1 overflow-x-auto border-b">
        <TabButton
          active={activeTab === 'overview'}
          onClick={() => switchTab('overview')}
          icon={<Activity className="h-4 w-4" />}
          testId="pam-tab-overview"
        >
          {t('pamPamPage.tabs.overview', { defaultValue: 'Overview' })}
        </TabButton>
        <TabButton
          active={activeTab === 'requests'}
          onClick={() => switchTab('requests')}
          icon={<Inbox className="h-4 w-4" />}
          testId="pam-tab-requests"
        >
          {t('pamPamPage.tabs.requests', { defaultValue: 'Requests' })}
        </TabButton>
        <TabButton
          active={activeTab === 'rules'}
          onClick={() => switchTab('rules')}
          icon={<ListChecks className="h-4 w-4" />}
          testId="pam-tab-rules"
        >
          {t('pamPamPage.tabs.rules', { defaultValue: 'Rules' })}
        </TabButton>
        <TabButton
          active={activeTab === 'signer-groups'}
          onClick={() => switchTab('signer-groups')}
          icon={<ShieldCheck className="h-4 w-4" />}
          testId="pam-tab-signer-groups"
        >
          {t('pamPamPage.tabs.signerGroups', { defaultValue: 'Signer Groups' })}
        </TabButton>
        <TabButton
          active={activeTab === 'audit'}
          onClick={() => switchTab('audit')}
          icon={<ScrollText className="h-4 w-4" />}
          testId="pam-tab-audit"
        >
          {t('pamPamPage.tabs.audit', { defaultValue: 'Audit' })}
        </TabButton>
      </div>

      {activeTab === 'overview' && <PamOverviewTab liveTick={liveTick} />}
      {activeTab === 'requests' && <PamRequestsTab liveTick={liveTick} />}
      {activeTab === 'rules' && <PamRulesTab liveTick={liveTick} />}
      {activeTab === 'signer-groups' && <PamSignerGroupsTab liveTick={liveTick} />}
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
      className={`-mb-px inline-flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors ${
        active
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}
