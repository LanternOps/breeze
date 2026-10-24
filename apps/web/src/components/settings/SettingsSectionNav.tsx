import '@/lib/i18n';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, type LucideIcon } from 'lucide-react';
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
  /**
   * Link-out item: renders a real `<a href>` that navigates normally (Astro
   * router) instead of activating an in-page section. Never current, never dirty.
   */
  href?: string;
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
  /**
   * Optional prefix for a per-item `data-testid="<prefix>-tab-<key>"` on the
   * desktop rail links, so callers (e.g. PartnerSettingsPage) can target a
   * specific nav item without relying on its translated accessible name.
   */
  testIdPrefix?: string;
};

/**
 * Shared grouped sidebar for the big settings surfaces (Partner Settings,
 * Organization Settings). Renders a descriptive rail at lg+ (real anchors so
 * middle-click / copy-link work) and collapses to a compact select below lg —
 * the full rail would otherwise stack ~600px of nav above the content.
 */
export default function SettingsSectionNav({ groups, activeKey, onNavigate, selectId, testIdPrefix }: SettingsSectionNavProps) {
  const { t } = useTranslation('settings');
  const railRef = useRef<HTMLElement>(null);

  // Keep the active item visible in the (scrollable) rail when the tab changes
  // by hash, keyboard or deep link. `nearest` moves nothing when it is already
  // in view, so the form beside the rail does not jump.
  useEffect(() => {
    const active = railRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    if (active && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest' });
    }
  }, [activeKey]);

  // The CSS max-height below only fits once the rail is stuck at top-6. Before
  // that it sits under the page title, and its bottom ran past the viewport,
  // hiding the last sections. Bound it from its real top instead, keeping the
  // same 1.5rem gap as <main>'s bottom padding. The class stays as the
  // pre-hydration fallback. A banner that mounts above the rail pushes it down
  // without a scroll or resize; it also grows one of the rail's ancestors,
  // which is what the ResizeObserver watches.
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const main = rail.closest('main');
    const scroller: HTMLElement | Window = main ?? window;
    const fit = () => {
      rail.style.maxHeight = `${Math.max(0, window.innerHeight - rail.getBoundingClientRect().top - 24)}px`;
    };
    fit();
    scroller.addEventListener('scroll', fit, { passive: true });
    window.addEventListener('resize', fit);
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(fit);
      for (let el = rail.parentElement; el && el !== main && el !== document.body; el = el.parentElement) observer.observe(el);
    }
    return () => {
      scroller.removeEventListener('scroll', fit);
      window.removeEventListener('resize', fit);
      observer?.disconnect();
    };
  }, []);

  return (
    <div>
      <div className="lg:hidden">
        <label htmlFor={selectId} className="sr-only">{t('settingsSectionNav.settingsSection')}</label>
        <select
          id={selectId}
          value={activeKey}
          onChange={e => {
            const picked = groups.flatMap(g => g.items).find(i => i.key === e.target.value);
            if (picked?.href) {
              // Controlled select: leave the value alone and navigate away.
              window.location.assign(picked.href);
              return;
            }
            onNavigate(e.target.value);
          }}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
        >
          {groups.map(group => (
            <optgroup key={group.label} label={group.label}>
              {group.items.map(item => (
                <option key={item.key} value={item.key}>
                  {/* Words, not a bullet: an option's text is all a screen
                      reader announces, and a bare "•" reads as nothing. */}
                  {item.dirty && !item.href ? t('settingsSectionNav.unsavedChanges', { label: item.label }) : item.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <nav
        ref={railRef}
        aria-label={t('settingsSectionNav.settingsSections')}
        // Bounded to the visible scrollport: 100vh minus the app header (h-16,
        // 4rem), the sticky offset (top-6) and <main>'s bottom padding (md:p-6),
        // so a long rail scrolls itself instead of running off-screen.
        className="hidden lg:block lg:sticky lg:top-6 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto space-y-4"
      >
        {groups.map(group => (
          <div key={group.label}>
            <p className="px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {group.label}
            </p>
            <ul className="mt-2 space-y-1">
              {group.items.map(item => {
                const Icon = item.icon;
                const isLink = !!item.href;
                const isActive = !isLink && activeKey === item.key;
                const isDirty = !isLink && !!item.dirty;
                return (
                  <li key={item.key}>
                    <a
                      href={item.href ?? `#${item.hash}`}
                      data-testid={testIdPrefix ? `${testIdPrefix}-tab-${item.key}` : undefined}
                      aria-current={isActive ? 'page' : undefined}
                      aria-label={isDirty ? t('settingsSectionNav.unsavedChanges', { label: item.label }) : item.label}
                      onClick={e => {
                        // Let modified clicks do their native thing (new tab, etc.).
                        if (isLink) return; // real navigation, no preventDefault
                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                        e.preventDefault();
                        onNavigate(item.key);
                      }}
                      // Active carries a primary left accent that hover never
                      // shows, so the two read differently even at a glance —
                      // not just by font weight. Inactive items reserve the same
                      // border width (transparent) so labels do not shift.
                      className={cn(
                        'flex items-start gap-3 rounded-md border-l-2 px-3 py-2 text-sm transition-colors',
                        isActive
                          ? 'border-primary bg-muted font-semibold text-foreground'
                          : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                      )}
                    >
                      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block">{item.label}</span>
                        <span className="block text-xs font-normal text-muted-foreground">
                          {item.description}
                        </span>
                      </span>
                      {isLink && <ExternalLink aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                      {isDirty && (
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
