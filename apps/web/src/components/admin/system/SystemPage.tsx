import { useState } from 'react';
import { useTranslation } from 'react-i18next';
// Initializes the shared i18next singleton before any island renders translated text.
import '../../../lib/i18n';
import ConnectionsTab from './ConnectionsTab';
import DeprecationsTab from './DeprecationsTab';
import HealthTab from './HealthTab';

/**
 * /admin/system (spec 2026-09-23-system-connections-page-design.md §4, D7).
 * Platform-admin, read-only deployment status. Tabs: Connections (default),
 * Deprecations and Health (spec 2026-10-30-system-health-admin-design). The selected tab lives in `?tab=`; the Astro route parses
 * it server-side and passes `initialTab`, so SSR and hydration agree.
 */

export type SystemTab = 'connections' | 'deprecations' | 'health';

const TABS: readonly SystemTab[] = ['connections', 'deprecations', 'health'];

export function parseSystemTab(value: string | null | undefined): SystemTab {
  if (value === 'deprecations' || value === 'health') return value;
  return 'connections';
}

export default function SystemPage({ initialTab = 'connections' }: { initialTab?: SystemTab }) {
  const { t } = useTranslation('admin');
  const [tab, setTab] = useState<SystemTab>(initialTab);

  const select = (next: SystemTab) => {
    setTab(next);
    const params = new URLSearchParams(window.location.search);
    if (next === 'connections') params.delete('tab');
    else params.set('tab', next);
    const query = params.toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`,
    );
  };

  const tabLabel = (id: SystemTab) => {
    if (id === 'connections') return t('admin.systemPage.tabs.connections');
    if (id === 'deprecations') return t('admin.systemPage.tabs.deprecations');
    return t('admin.systemPage.tabs.health');
  };

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('admin.systemPage.title')}</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-3xl">{t('admin.systemPage.description')}</p>
      </div>

      <div role="tablist" aria-label={t('admin.systemPage.tabs.label')} className="flex gap-1 border-b">
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`system-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`system-panel-${id}`}
            data-testid={`system-tab-${id}`}
            onClick={() => select(id)}
            className={`px-4 py-2 text-sm -mb-px border-b-2 ${
              tab === id
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {tabLabel(id)}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`system-panel-${tab}`} aria-labelledby={`system-tab-${tab}`}>
        {tab === 'connections' ? <ConnectionsTab /> : tab === 'health' ? <HealthTab /> : <DeprecationsTab />}
      </div>
    </div>
  );
}
