import { useEffect, useState } from 'react';
import OrgsTab from './OrgsTab';
import PolicyEditor from './PolicyEditor';
import SessionsTab from './SessionsTab';
import UsageTab from './UsageTab';
import TemplatesTab from './TemplatesTab';

/**
 * AI for Office — MSP admin surface shell (spec §9). Tab state lives in
 * window.location.hash (#orgs default, #sessions, #usage, #templates,
 * #policy/<orgId>) per the DeviceDetails.tsx hash-tab convention — never
 * query params. Deep links and reloads land on the right tab.
 */

const SIMPLE_TABS = ['orgs', 'sessions', 'usage', 'templates'] as const;
type SimpleTab = (typeof SIMPLE_TABS)[number];

export type TabState = { tab: SimpleTab } | { tab: 'policy'; orgId: string };

export function getStateFromHash(): TabState {
  if (typeof window === 'undefined') return { tab: 'orgs' };
  const hash = window.location.hash.replace('#', '');
  if (hash.startsWith('policy/')) {
    const orgId = hash.slice('policy/'.length);
    if (orgId) return { tab: 'policy', orgId };
  }
  if ((SIMPLE_TABS as readonly string[]).includes(hash)) return { tab: hash as SimpleTab };
  return { tab: 'orgs' };
}

const TAB_DEFS: { id: SimpleTab; label: string }[] = [
  { id: 'orgs', label: 'Organizations' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'usage', label: 'Usage' },
  { id: 'templates', label: 'Templates' },
];

export default function AiForOfficePage() {
  const [state, setState] = useState<TabState>(getStateFromHash);

  useEffect(() => {
    const onHashChange = () => setState(getStateFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const switchTab = (tab: SimpleTab) => {
    window.location.hash = tab;
    setState({ tab });
  };

  const openPolicy = (orgId: string) => {
    window.location.hash = `policy/${orgId}`;
    setState({ tab: 'policy', orgId });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">AI for Office</h1>
        <p className="text-muted-foreground">
          Governed AI assistant in your clients&apos; Excel — provisioning, policy, audit, usage
          and templates
        </p>
      </div>

      <div className="border-b">
        <nav className="-mb-px flex gap-4">
          {TAB_DEFS.map((t) => {
            const active = state.tab === t.id || (t.id === 'orgs' && state.tab === 'policy');
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => switchTab(t.id)}
                className={`border-b-2 px-1 pb-2 text-sm font-medium transition-colors ${
                  active
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
                data-testid={`ai-office-tab-${t.id}`}
              >
                {t.label}
              </button>
            );
          })}
        </nav>
      </div>

      {state.tab === 'orgs' && <OrgsTab onOpenPolicy={openPolicy} />}
      {state.tab === 'policy' && (
        <PolicyEditor orgId={state.orgId} onBack={() => switchTab('orgs')} />
      )}
      {state.tab === 'sessions' && <SessionsTab />}
      {state.tab === 'usage' && <UsageTab />}
      {state.tab === 'templates' && <TemplatesTab />}
    </div>
  );
}
