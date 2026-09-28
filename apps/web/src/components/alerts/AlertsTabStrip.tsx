import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { useMlFeatureFlags } from '../../hooks/useMlFeatureFlags';

const TABS = [
  { href: '/alerts', labelKey: 'alerts' },
  { href: '/alerts/correlations', labelKey: 'correlations' },
  { href: '/alerts/monitors', labelKey: 'monitors' },
  { href: '/alerts/delivery', labelKey: 'delivery' },
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
  const { t } = useTranslation('alerts');
  const mlFlags = useMlFeatureFlags();
  const alertCorrelationDisabled = mlFlags.isDisabled('ml.alert_correlation.enabled');
  const path = useCurrentPath(currentPath);
  const activeHref = useMemo(() => {
    if (path.startsWith('/alerts/correlations')) return '/alerts/correlations';
    // Legacy paths redirect permanently to Delivery.
    if (path.startsWith('/alerts/delivery') || path.startsWith('/alerts/channels') || path.startsWith('/alerts/routing-rules')) return '/alerts/delivery';
    if (path.startsWith('/alerts/monitors')) return '/alerts/monitors';
    return '/alerts';
  }, [path]);

  // These tabs are real `<a href>` navigation across separate Astro pages
  // (not client-side tab switching), so they can't move onto OverflowTabs
  // (its "More" menu is button/onTabChange-only and would turn page
  // navigation into a no-op). Instead let the row scroll horizontally so
  // every tab — including the last one, previously clipped off-screen at
  // 390px — stays reachable; `shrink-0` keeps each tab's own width, and
  // `overflow-x-auto` gives the row a native scrollbar/swipe instead of
  // clipping.
  return (
    <nav
      className="flex gap-1 overflow-x-auto border-b text-sm"
      aria-label={t('alertsTabStrip.alertsSections')}
    >
      {TABS.map((tab) => {
        const isActive = tab.href === activeHref;
        const isDisabled = tab.href === '/alerts/correlations' && alertCorrelationDisabled;
        if (isDisabled) {
          return (
            <span
              key={tab.href}
              className={
                'inline-flex h-10 shrink-0 cursor-not-allowed items-center whitespace-nowrap px-4 -mb-px border-b-2 text-muted-foreground opacity-70 ' +
                (isActive ? 'border-muted-foreground/40 font-semibold' : 'border-transparent')
              }
              aria-current={isActive ? 'page' : undefined}
              aria-disabled="true"
              title={t('alertsTabStrip.alertCorrelationIsDisabledForThisOrganization')}
            >
              {t('alertsTabStrip.correlationsDisabled')}
            </span>
          );
        }
        return (
          <a
            key={tab.href}
            href={tab.href}
            data-testid={`alerts-tab-${tab.labelKey}`}
            className={
              'inline-flex h-10 shrink-0 items-center whitespace-nowrap px-4 -mb-px border-b-2 transition ' +
              (isActive
                ? 'border-primary font-semibold text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/40')
            }
            aria-current={isActive ? 'page' : undefined}
          >
            {t(/* i18n-dynamic */ `alertsTabStrip.tabs.${tab.labelKey}`)}
          </a>
        );
      })}
    </nav>
  );
}
