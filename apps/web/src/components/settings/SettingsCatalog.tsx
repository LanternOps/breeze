import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import '@/lib/i18n';
import { useAuthStore } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { useToolSourcesGate } from '../../stores/featuresStore';
import { getJwtClaims } from '../../lib/authScope';
import { useAutopayEnabled } from '../../lib/autopayVisibility';
import { useWispEnabled } from '../../lib/wispVisibility';
import { isNavGateVisible } from '../../lib/navGates';
import { SETTINGS_CATALOG, SETTINGS_GROUPS, type SettingsGroup } from '../../lib/settingsCatalog';
import { useExtensionNavigation } from '../extensions/useExtensionNavigation';

/**
 * The /settings index (#6220): one card per settings screen, grouped, searchable,
 * gated by the same `isNavGateVisible` predicate the sidebar uses. With `group`
 * it is that group's hub page (Settings → AI, W04 #10135): only that group's
 * cards, no group heading (the page title names it). `sidebarOnly` hub entries
 * never render as cards.
 */
export default function SettingsCatalog({ group }: { group?: SettingsGroup } = {}) {
  const { t } = useTranslation(['common', 'pages', 'settings']);
  const isPlatformAdmin = useAuthStore((s) => s.user?.isPlatformAdmin === true);
  const permissions = useAuthStore((s) => s.user?.permissions);
  const serviceManagementMode = useOrgStore((s) => s.serviceManagementMode);
  const autopayEnabled = useAutopayEnabled();
  const wispEnabled = useWispEnabled();
  const { enabled: toolSourcesEnabled } = useToolSourcesGate();
  const extensionNav = useExtensionNavigation();
  // An extension is loaded when its registry entry contributes navigation; the
  // hook only yields hrefs it validated as `/extensions/<name>/...`.
  const loadedExtensions = useMemo(
    () => [...new Set(extensionNav.map((link) => link.href.split('/')[2]).filter(Boolean))],
    [extensionNav],
  );
  const [query, setQuery] = useState('');

  const entries = useMemo(() => {
    const ctx = {
      isPlatformAdmin,
      permissions,
      getScope: () => getJwtClaims().scope,
      autopayEnabled,
      toolSourcesEnabled,
      aiForOfficeEnabled: false,
      wispEnabled,
      serviceManagementMode,
      loadedExtensions,
    };
    const q = query.trim().toLowerCase();
    return SETTINGS_CATALOG.filter((e) => !e.sidebarOnly && (!group || e.group === group) && isNavGateVisible(e, ctx))
      .map((e) => ({
        ...e,
        title: t(/* i18n-dynamic */ e.labelKey, { defaultValue: e.name }),
        description: e.descriptionKey ? t(/* i18n-dynamic */ e.descriptionKey, { defaultValue: '' }) : '',
      }))
      .filter((e) => !q || `${e.title} ${e.description}`.toLowerCase().includes(q));
  }, [isPlatformAdmin, permissions, serviceManagementMode, toolSourcesEnabled, autopayEnabled, wispEnabled, loadedExtensions, group, query, t]);

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

      {(group ? [group] : SETTINGS_GROUPS).map((g) => {
        const items = entries.filter((e) => e.group === g);
        if (items.length === 0) return null;
        return (
          <section key={g} data-testid={`settings-group-${g}`} className="space-y-3">
            {!group && (
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {t(/* i18n-dynamic */ `pages:settingsIndex.groups.${g}`)}
              </h2>
            )}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {items.map((e) => {
                const Icon = e.icon;
                return (
                  <a
                    key={e.id}
                    href={e.href}
                    data-testid={e.id === 'billing-payments' ? 'autopay-settings-card-payments' : `settings-card-${e.id}`}
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
