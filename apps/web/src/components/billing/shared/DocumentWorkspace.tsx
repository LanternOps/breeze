import { useCallback, useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import '../../../lib/i18n';

export interface DocumentTab {
  id: string;
  label: string;
  /** Hidden tabs are dropped from the tablist (e.g. Editor once a doc is issued). */
  hidden?: boolean;
}

export interface DocumentWorkspaceProps {
  /** Prefix for every id / data-testid (`quote`, `invoice`) so the two surfaces
   *  keep their existing, stable testids while sharing one implementation. */
  idPrefix: string;
  backHref: string;
  backLabel: string;
  title: string;
  statusPill?: ReactNode;
  actions?: ReactNode;
  tabs: DocumentTab[];
  activeTab: string;
  onTabChange: (id: string) => void;
  children: ReactNode;
}

/**
 * The shared quote/invoice workspace chrome: a back link + truncating title (+
 * optional status pill and right-aligned actions cluster) over a WAI-ARIA
 * tablist. Extracted from the near-verbatim QuoteWorkspace/InvoiceWorkspace so
 * the tablist keyboard model (roving tabindex, Arrow/Home/End, aria-selected)
 * lives in exactly one place. Tab STATE (which tab, hash persistence, hide rules)
 * stays with the caller — this component is presentational and reports intent via
 * `onTabChange`.
 *
 * The actions slot is a right-aligned flex cluster; a disabled-primary-action's
 * reason hint must be rendered by the caller BELOW the buttons (a full-basis,
 * right-aligned `<p>`), never inline between them — an inline hint drags the whole
 * cluster into the page centre.
 */
export function DocumentWorkspace({
  idPrefix,
  backHref,
  backLabel,
  title,
  statusPill,
  actions,
  tabs,
  activeTab,
  onTabChange,
  children,
}: DocumentWorkspaceProps) {
  const { t } = useTranslation('billing');
  const visibleTabs = tabs.filter((t) => !t.hidden);

  // A tab switch always lands at the top of the new panel: without the reset,
  // the scroll offset from a long previous tab carries over and drops the user
  // mid-document with the (sticky) chrome as their only orientation.
  const rootRef = useRef<HTMLDivElement>(null);
  const prevTab = useRef(activeTab);
  useEffect(() => {
    if (prevTab.current === activeTab) return;
    prevTab.current = activeTab;
    try {
      const scroller = rootRef.current?.closest('main');
      if (scroller) scroller.scrollTo({ top: 0 });
      else if (typeof window !== 'undefined') window.scrollTo({ top: 0 });
    } catch { /* jsdom: scrollTo not implemented — a no-op reset is fine */ }
  }, [activeTab]);

  // Roving keyboard navigation across the tablist (WAI-ARIA tabs pattern):
  // Left/Right (and Up/Down) move between tabs, Home/End jump to the ends, and the
  // moved-to tab is both activated and focused.
  const onTabKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    const idx = visibleTabs.findIndex((t) => t.id === activeTab);
    if (idx < 0) return;
    let nextIdx: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextIdx = (idx + 1) % visibleTabs.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') nextIdx = (idx - 1 + visibleTabs.length) % visibleTabs.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = visibleTabs.length - 1;
    if (nextIdx === null) return;
    e.preventDefault();
    const next = visibleTabs[nextIdx].id;
    onTabChange(next);
    if (typeof document !== 'undefined') document.getElementById(`${idPrefix}-tab-${next}`)?.focus();
  }, [visibleTabs, activeTab, onTabChange, idPrefix]);

  return (
    <div className="space-y-4" ref={rootRef} data-testid={`${idPrefix}-workspace`}>
      {/* Header + tabs stay pinned while the document scrolls: on a real-length
          quote/invoice, Send and the tab switcher must never require a scroll
          hunt. Negative margins bleed over <main>'s p-4/md:p-6 so scrolled
          content passes fully behind the bar instead of peeking through the
          padding gap; z-20 sits above panel content, below fixed menus (z-50).
          The NEGATIVE top insets are load-bearing: sticky offsets resolve
          against the scrollport (the scroll container's padding box), so a
          plain top-0 would pin the bar BELOW main's top padding and let a band
          of scrolled content show through above it. -top-4/-top-6 pin the bar
          flush with main's true top edge; its own pt re-covers the zone. */}
      <div className="sticky -top-4 z-20 -mx-4 -mt-4 bg-background px-4 pt-4 md:-top-6 md:-mx-6 md:-mt-6 md:px-6 md:pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <a
              href={backHref}
              aria-label={t('shared.documentWorkspace.backAria', { label: backLabel.toLowerCase() })}
              className="text-xs text-muted-foreground hover:underline"
            >
              <span aria-hidden="true">←</span> {backLabel}
            </a>
            <div className="flex items-center gap-2 min-w-0">
              <h1 className="truncate text-xl font-semibold" data-testid={`${idPrefix}-workspace-title`}>
                {title}
              </h1>
              {statusPill}
            </div>
          </div>
          {actions && (
            // Right-aligned cluster; the caller renders any disabled-reason hint on
            // its own full-basis line below the buttons (never inline between them).
            <div className="flex items-center gap-2 flex-wrap justify-end">{actions}</div>
          )}
        </div>

        {/* Tabs */}
        <div
          className="mt-4 flex gap-1 border-b"
          role="tablist"
          data-testid={`${idPrefix}-workspace-tabs`}
          onKeyDown={onTabKeyDown}
        >
          {visibleTabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`${idPrefix}-tab-${t.id}`}
              aria-selected={activeTab === t.id}
              aria-controls={`${idPrefix}-tabpanel-${t.id}`}
              tabIndex={activeTab === t.id ? 0 : -1}
              onClick={() => onTabChange(t.id)}
              data-testid={`${idPrefix}-tab-${t.id}`}
              className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition ${
                activeTab === t.id
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div
        role="tabpanel"
        id={`${idPrefix}-tabpanel-${activeTab}`}
        aria-labelledby={`${idPrefix}-tab-${activeTab}`}
        tabIndex={0}
      >
        {children}
      </div>
    </div>
  );
}

export default DocumentWorkspace;
