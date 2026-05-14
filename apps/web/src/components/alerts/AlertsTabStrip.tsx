import { useMemo } from 'react';

const TABS = [
  { href: '/alerts', label: 'Alerts' },
  { href: '/alerts/rules', label: 'Rules' },
  { href: '/alerts/channels', label: 'Channels' },
] as const;

export default function AlertsTabStrip() {
  const activeHref = useMemo(() => {
    if (typeof window === 'undefined') return '/alerts';
    const path = window.location.pathname;
    if (path.startsWith('/alerts/channels')) return '/alerts/channels';
    if (path.startsWith('/alerts/rules')) return '/alerts/rules';
    return '/alerts';
  }, []);

  return (
    <nav className="flex gap-1 border-b text-sm" aria-label="Alerts sections">
      {TABS.map((tab) => {
        const isActive = tab.href === activeHref;
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
