import { useEffect, useMemo, useState } from 'react';
import { useMlFeatureFlags } from '../../hooks/useMlFeatureFlags';

const TABS = [
  { href: '/alerts', label: 'Alerts' },
  { href: '/alerts/correlations', label: 'Correlations' },
  { href: '/alerts/rules', label: 'Rules' },
  { href: '/alerts/channels', label: 'Channels' },
] as const;

interface AlertsTabStripProps {
  // SSR-correct current path supplied by the rendering page/component so the
  // server and client first paint agree on the active tab (no hydration mismatch).
  currentPath?: string;
}

// Seed from the prop (SSR-stable) and update after mount so the active tab
// stays correct across Astro View Transitions and back/forward navigation.
// Mirrors useCurrentPath in components/layout/Sidebar.tsx.
function useCurrentPath(initialPath: string): string {
  const [path, setPath] = useState(initialPath);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    document.addEventListener('astro:after-swap', update);
    window.addEventListener('popstate', update);
    return () => {
      document.removeEventListener('astro:after-swap', update);
      window.removeEventListener('popstate', update);
    };
  }, []);
  return path;
}

export default function AlertsTabStrip({ currentPath = '/alerts' }: AlertsTabStripProps) {
  const mlFlags = useMlFeatureFlags();
  const alertCorrelationDisabled = mlFlags.isDisabled('ml.alert_correlation.enabled');
  const path = useCurrentPath(currentPath);
  const activeHref = useMemo(() => {
    if (path.startsWith('/alerts/correlations')) return '/alerts/correlations';
    if (path.startsWith('/alerts/channels')) return '/alerts/channels';
    if (path.startsWith('/alerts/rules')) return '/alerts/rules';
    return '/alerts';
  }, [path]);

  return (
    <nav className="flex gap-1 border-b text-sm" aria-label="Alerts sections">
      {TABS.map((tab) => {
        const isActive = tab.href === activeHref;
        const isDisabled = tab.href === '/alerts/correlations' && alertCorrelationDisabled;
        if (isDisabled) {
          return (
            <span
              key={tab.href}
              className={
                'inline-flex h-10 cursor-not-allowed items-center px-4 -mb-px border-b-2 text-muted-foreground opacity-70 ' +
                (isActive ? 'border-muted-foreground/40 font-semibold' : 'border-transparent')
              }
              aria-current={isActive ? 'page' : undefined}
              aria-disabled="true"
              title="Alert correlation is disabled for this organization"
            >
              Correlations disabled
            </span>
          );
        }
        return (
          <a
            key={tab.href}
            href={tab.href}
            className={
              'inline-flex h-10 items-center px-4 -mb-px border-b-2 transition ' +
              (isActive
                ? 'border-primary font-semibold text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/40')
            }
            aria-current={isActive ? 'page' : undefined}
          >
            {tab.label}
          </a>
        );
      })}
    </nav>
  );
}
