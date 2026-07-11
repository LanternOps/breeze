import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type SettingsNavItem = {
  /** Stable key identifying the section (used as the select value). */
  key: string;
  /** Canonical URL fragment for deep-linking (kebab-case). */
  hash: string;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Section has unsaved changes — shows a dot and announces it to AT. */
  dirty?: boolean;
};

export type SettingsNavGroup = {
  label: string;
  items: SettingsNavItem[];
};

type SettingsSectionNavProps = {
  groups: SettingsNavGroup[];
  activeKey: string;
  /** Activate a section. The caller owns state + pushing the URL hash. */
  onNavigate: (key: string) => void;
  /** Unique id for the compact mobile select (label association). */
  selectId: string;
};

/**
 * Shared grouped sidebar for the big settings surfaces (Partner Settings,
 * Organization Settings). Renders a descriptive rail at lg+ (real anchors so
 * middle-click / copy-link work) and collapses to a compact select below lg —
 * the full rail would otherwise stack ~600px of nav above the content.
 */
export default function SettingsSectionNav({ groups, activeKey, onNavigate, selectId }: SettingsSectionNavProps) {
  const { t } = useTranslation('settings');
  return (
    <div>
      <div className="lg:hidden">
        <label htmlFor={selectId} className="sr-only">{t('settingsSectionNav.settingsSection')}</label>
        <select
          id={selectId}
          value={activeKey}
          onChange={e => onNavigate(e.target.value)}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
        >
          {groups.map(group => (
            <optgroup key={group.label} label={group.label}>
              {group.items.map(item => (
                <option key={item.key} value={item.key}>
                  {item.label}{item.dirty ? ' •' : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <nav aria-label={t('settingsSectionNav.settingsSections')} className="hidden lg:block lg:sticky lg:top-6 space-y-4">
        {groups.map(group => (
          <div key={group.label}>
            <p className="px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {group.label}
            </p>
            <ul className="mt-2 space-y-1">
              {group.items.map(item => {
                const Icon = item.icon;
                const isActive = activeKey === item.key;
                return (
                  <li key={item.key}>
                    <a
                      href={`#${item.hash}`}
                      aria-current={isActive ? 'page' : undefined}
                      aria-label={item.dirty ? t('settingsSectionNav.unsavedChanges', { label: item.label }) : item.label}
                      onClick={e => {
                        // Let modified clicks do their native thing (new tab, etc.).
                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                        e.preventDefault();
                        onNavigate(item.key);
                      }}
                      className={cn(
                        'flex items-start gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                        isActive
                          ? 'bg-muted font-semibold text-foreground'
                          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                      )}
                    >
                      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block">{item.label}</span>
                        <span className="block text-xs font-normal text-muted-foreground">
                          {item.description}
                        </span>
                      </span>
                      {item.dirty && (
                        <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                      )}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  );
}
