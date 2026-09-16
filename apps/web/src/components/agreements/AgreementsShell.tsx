import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

export interface AgreementsShellProps {
  tab: 'templates' | 'signed';
  children: ReactNode;
}

const TABS = [
  { id: 'templates', href: '/agreements/templates', labelKey: 'agreements.tabs.templates', testId: 'agreements-tab-templates' },
  { id: 'signed', href: '/agreements/signed', labelKey: 'agreements.tabs.signed', testId: 'agreements-tab-signed' },
] as const;

/**
 * The /agreements area chrome (spec §6).
 *
 * The two tabs are REAL LINKS, not hash state: spec §1's complaint is that a
 * template could not be linked to at all, and ContractsTabs.tsx's
 * `window.location.hash` idiom is what produced that. Active styling comes from
 * the `tab` prop, which the Astro page passes at SSR time — no hash read, so no
 * hydration mismatch and no flash of the wrong tab.
 *
 * The page description is the ONE place the UI states how agreement template,
 * signed agreement and contract relate. It deliberately reuses W01's
 * `contracts.templatesTab.description` rather than a copy under `agreements.*`:
 * one sentence, one catalog entry, no drift.
 */
export default function AgreementsShell({ tab, children }: AgreementsShellProps) {
  const { t } = useTranslation('billing');
  return (
    <div className="space-y-4" data-testid="agreements-shell">
      <p className="text-sm text-muted-foreground" data-testid="agreements-shell-description">
        {t('contracts.templatesTab.description')}
      </p>
      <nav className="flex gap-1 border-b" aria-label={t('agreements.tabs.templates')}>
        {TABS.map((item) => {
          const active = item.id === tab;
          return (
            <a
              key={item.id}
              href={item.href}
              data-testid={item.testId}
              aria-current={active ? 'page' : undefined}
              className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                active
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t(/* i18n-dynamic */ item.labelKey)}
            </a>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
