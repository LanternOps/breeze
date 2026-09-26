import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import '@/lib/i18n';
import { useAuthStore } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { useToolSourcesGate } from '../../stores/featuresStore';
import { getJwtClaims } from '../../lib/authScope';
import { isNavGateVisible } from '../../lib/navGates';
import { SETTINGS_CATALOG, SETTINGS_GROUPS } from '../../lib/settingsCatalog';

/**
 * The /settings index (#6220): one card per settings screen, grouped, searchable,
 * gated by the same `isNavGateVisible` predicate the sidebar uses.
 */
export default function SettingsCatalog() {
  const { t } = useTranslation(['common', 'pages', 'settings']);
  const isPlatformAdmin = useAuthStore((s) => s.user?.isPlatformAdmin === true);
  const permissions = useAuthStore((s) => s.user?.permissions);
  const serviceManagementMode = useOrgStore((s) => s.serviceManagementMode);
  const { enabled: toolSourcesEnabled } = useToolSourcesGate();
  const [query, setQuery] = useState('');

  const entries = useMemo(() => {
    const ctx = {
      isPlatformAdmin,
      permissions,
      getScope: () => getJwtClaims().scope,
      toolSourcesEnabled,
      aiForOfficeEnabled: false,
      serviceManagementMode,
    };
    const q = query.trim().toLowerCase();
    return SETTINGS_CATALOG.filter((e) => isNavGateVisible(e, ctx))
      .map((e) => ({
        ...e,
        title: t(/* i18n-dynamic */ e.labelKey, { defaultValue: e.name }),
        description: e.descriptionKey ? t(/* i18n-dynamic */ e.descriptionKey, { defaultValue: '' }) : '',
      }))
      .filter((e) => !q || `${e.title} ${e.description}`.toLowerCase().includes(q));
  }, [isPlatformAdmin, permissions, serviceManagementMode, toolSourcesEnabled, query, t]);

  return (
    <div className="space-y-6" data-testid="settings-catalog">
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          data-testid="settings-search"
          aria-label={t('pages:settingsIndex.search.label')}
          placeholder={t('pages:settingsIndex.search.placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        />
      </div>

      {entries.length === 0 && (
        <p data-testid="settings-no-results" className="text-sm text-muted-foreground">
          {t('pages:settingsIndex.noResults')}
        </p>
      )}

      {SETTINGS_GROUPS.map((group) => {
        const items = entries.filter((e) => e.group === group);
        if (items.length === 0) return null;
        return (
          <section key={group} data-testid={`settings-group-${group}`} className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {t(/* i18n-dynamic */ `pages:settingsIndex.groups.${group}`)}
            </h2>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {items.map((e) => {
                const Icon = e.icon;
                return (
                  <a
                    key={e.id}
                    href={e.href}
                    data-testid={`settings-card-${e.id}`}
                    className="flex items-start gap-3 rounded-lg border bg-card p-4 shadow-xs transition hover:border-primary hover:shadow-md"
                  >
                    <Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="space-y-1">
                      <span className="block font-medium">{e.title}</span>
                      {e.description && (
                        <span className="block text-sm text-muted-foreground">{e.description}</span>
                      )}
                    </span>
                  </a>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
