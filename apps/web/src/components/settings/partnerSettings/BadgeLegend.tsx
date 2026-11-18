import { useTranslation } from 'react-i18next';
import { catalogForTab, isCatalogTabKey, type FieldKind } from '@breeze/shared';
import '@/lib/i18n';
import { BADGE_PILL, BADGE_STYLE } from './SettingBadge';
import type { TabKey } from './tabRegistry';

const ORDER = ['locks', 'overridable', 'partnerOnly'] as const;
type BadgedKind = (typeof ORDER)[number];

/** The badge kinds a page tab uses, in a fixed order. Empty for tabs without badged fields. */
export function badgedKinds(tab: TabKey): BadgedKind[] {
  if (!isCatalogTabKey(tab)) return [];
  const kinds = new Set<FieldKind>(catalogForTab(tab).map(e => e.kind));
  return ORDER.filter(k => kinds.has(k));
}

const K = 'partnerSettingsPage.inheritance';

/** One line under the panel heading that says what each badge on this tab means. */
export default function BadgeLegend({ tab }: { tab: TabKey }) {
  const { t } = useTranslation('settings');
  const kinds = badgedKinds(tab);
  if (kinds.length === 0) return null;
  return (
    <div data-testid="partner-settings-badge-legend" className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">{t(/* i18n-dynamic */ `${K}.legend.title`)}</span>
      {kinds.map(kind => {
        const { icon: Icon, className } = BADGE_STYLE[kind];
        return (
          <span key={kind} className="inline-flex items-center gap-1.5">
            <span className={`${BADGE_PILL} ${className}`}>
              <Icon className="h-3 w-3" aria-hidden="true" />
              {t(/* i18n-dynamic */ `${K}.badge.${kind}`)}
            </span>
            {t(/* i18n-dynamic */ `${K}.legend.${kind}`)}
          </span>
        );
      })}
    </div>
  );
}
