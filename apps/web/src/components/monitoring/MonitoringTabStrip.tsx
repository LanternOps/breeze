import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';

const TABS = [
  { href: '/monitoring', labelKey: 'network' },
  { href: '/monitoring/delivery', labelKey: 'delivery' },
] as const;

interface MonitoringTabStripProps {
  // SSR-correct current path so server and client agree on the active tab.
  currentPath?: string;
}

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

export default function MonitoringTabStrip({ currentPath = '/monitoring' }: MonitoringTabStripProps) {
  const { t } = useTranslation('common');
  const path = useCurrentPath(currentPath);
  const activeHref = useMemo(
    () => (path.startsWith('/monitoring/delivery') ? '/monitoring/delivery' : '/monitoring'),
    [path],
  );
  return (
    <nav className="flex gap-1 border-b" aria-label={t('monitoringTabs.ariaLabel')}>
      {TABS.map((tab) => (
        <a
          key={tab.href}
          href={tab.href}
          aria-current={activeHref === tab.href ? 'page' : undefined}
          className={`-mb-px border-b-2 px-3 py-2 text-sm ${activeHref === tab.href ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
        >
          {t(/* i18n-dynamic */ `monitoringTabs.${tab.labelKey}`)}
        </a>
      ))}
    </nav>
  );
}
