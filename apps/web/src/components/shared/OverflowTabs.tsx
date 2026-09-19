import { useState, useEffect, useCallback, useRef, useLayoutEffect, type KeyboardEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export type OverflowTab = {
  id: string;
  label: string;
  icon: React.ReactNode;
  dot?: boolean;
  /** Render a vertical separator before this tab */
  separator?: boolean;
  /** Tooltip text for non-obvious labels */
  title?: string;
  /** Always lives inside the "More" menu, regardless of available width.
   *  Primary (non-secondary) tabs still collapse into "More" width-first. */
  secondary?: boolean;
  /** Section header shown above this tab inside "More" (consecutive tabs
   *  sharing a group render under one header). */
  group?: string;
  /** "Needs attention" count rendered as a badge; 0/undefined renders nothing.
   *  Hidden tabs' counts are summed onto the "More" trigger. */
  count?: number;
};

// "Needs attention" count. Deliberately the warning token, not `primary`:
// primary is the selection colour on this strip (active underline, active
// menu item), and a count that shares it reads as "selected", not "look here".
function CountBadge({ count, testId }: { count?: number; testId?: string }) {
  if (!count || count <= 0) return null;
  return (
    <span
      data-testid={testId}
      className="ml-0.5 inline-flex min-w-5 items-center justify-center rounded-full bg-warning/15 px-1.5 py-0.5 text-xs font-semibold leading-none tabular-nums text-warning-strong"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

// Dot on the "More" trigger: something hidden inside needs attention. A dot,
// not a number — a sum of tickets + failing monitors + compliance rules is
// not a quantity anyone can act on; the real counts sit on the items inside.
function HiddenDot({ show, testId }: { show: boolean; testId: string }) {
  if (!show) return null;
  return <span data-testid={testId} aria-hidden="true" className="ml-0.5 h-1.5 w-1.5 rounded-full bg-warning-strong" />;
}

// Stable id for a visible tab button, also used as the tab panel's
// `aria-labelledby` target by consumers that render `role="tabpanel"`
// sections (e.g. NetworkDeviceDetailPage). Matches the `data-testid` scheme
// below exactly so the two never drift apart; falls back to `tab-<id>` when
// the consumer doesn't pass a `testIdPrefix`.
export function overflowTabId(id: string, testIdPrefix?: string): string {
  return testIdPrefix ? `${testIdPrefix}${id}` : `tab-${id}`;
}

// Stable id for a tab's panel, mirroring `overflowTabId`'s scheme — used as
// the tab button's `aria-controls` target and the panel element's own `id`
// (see NetworkDeviceDetailPage's `role="tabpanel"` sections). Kept distinct
// from `overflowTabId` (rather than reusing the tab's own id) since a tab
// element and its panel are two different DOM nodes that both need an id.
export function overflowPanelId(id: string, testIdPrefix?: string): string {
  return testIdPrefix ? `${testIdPrefix}${id}-panel` : `tab-${id}-panel`;
}

export function OverflowTabs({ tabs, activeTab, onTabChange, testIdPrefix }: {
  tabs: OverflowTab[];
  activeTab: string;
  onTabChange: (id: string) => void;
  /** When set, each tab button (visible or inside "More") gets
   *  `data-testid={testIdPrefix + tab.id}`. Omitted by default so existing
   *  consumers are unaffected. */
  testIdPrefix?: string;
}) {
  const { t } = useTranslation('common');
  const containerRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const tabWidths = useRef<number[]>([]);
  const tabButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const primaryTabs = tabs.filter(t => !t.secondary);
  const secondaryTabs = tabs.filter(t => t.secondary);
  const [visibleCount, setVisibleCount] = useState(primaryTabs.length);
  const [measured, setMeasured] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuItemRefs = useRef<HTMLButtonElement[]>([]);
  // Real width of the "More" trigger once it has rendered; the fallback is
  // only used on the very first measure before it exists. The old fixed
  // 120px reserve cost a whole tab of row width against a ~65px trigger.
  const moreWidthRef = useRef<number>(0);
  const [menuMaxHeight, setMenuMaxHeight] = useState<number | undefined>(undefined);

  // Re-measure whenever the primary set changes (a tab promoted out of
  // "More", a count badge appearing) — the cached widths would otherwise be
  // stale and the visible slice could drop or duplicate a tab.
  const primaryKey = primaryTabs.map(t => `${t.id}:${t.count ?? 0}`).join('|');
  const lastPrimaryKey = useRef(primaryKey);
  useLayoutEffect(() => {
    if (lastPrimaryKey.current === primaryKey) return;
    lastPrimaryKey.current = primaryKey;
    setMeasured(false);
  }, [primaryKey]);

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav || measured) return;
    const buttons = nav.querySelectorAll<HTMLButtonElement>(':scope > span > button, :scope > button');
    // Measure each tab's total width including any preceding separator
    tabWidths.current = Array.from(buttons).map(b => {
      const wrapper = b.parentElement;
      if (wrapper && wrapper.tagName === 'SPAN') {
        // Wrapper with display:contents — measure the separator too if present
        const sep = wrapper.querySelector(':scope > span[aria-hidden]');
        return b.offsetWidth + (sep ? (sep as HTMLElement).offsetWidth + 8 : 0);
      }
      return b.offsetWidth;
    });
    setMeasured(true);
  }, [measured]);

  const computeVisible = useCallback(() => {
    const container = containerRef.current;
    if (!container || tabWidths.current.length === 0) return;
    const availableWidth = container.clientWidth;
    const gap = 12;
    const moreButtonWidth = moreWidthRef.current || 80;

    let totalAll = 0;
    for (let i = 0; i < tabWidths.current.length; i++) {
      totalAll += tabWidths.current[i] + (i > 0 ? gap : 0);
    }
    if (totalAll <= availableWidth && secondaryTabs.length === 0) {
      setVisibleCount(primaryTabs.length);
      return;
    }

    let total = 0;
    let fits = 0;
    for (let i = 0; i < tabWidths.current.length; i++) {
      total += tabWidths.current[i] + (i > 0 ? gap : 0);
      if (total + gap + moreButtonWidth <= availableWidth) {
        fits = i + 1;
      } else {
        break;
      }
    }
    setVisibleCount(Math.max(1, fits));
  }, [primaryTabs.length, secondaryTabs.length]);

  useLayoutEffect(() => {
    if (!measured) return;
    computeVisible();
  }, [measured, computeVisible]);

  useEffect(() => {
    if (!measured) return;
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => computeVisible());
    ro.observe(container);
    return () => ro.disconnect();
  }, [measured, computeVisible]);

  const closeMenu = useCallback((returnFocus: boolean) => {
    setMoreOpen(false);
    if (returnFocus) moreButtonRef.current?.focus();
  }, []);

  const openMenu = useCallback(() => {
    const trigger = moreButtonRef.current;
    if (trigger) {
      moreWidthRef.current = trigger.offsetWidth || moreWidthRef.current;
      // Constrain to the space actually below the trigger; `70vh` measured
      // from the viewport top left the panel's box hanging off the bottom.
      const bottom = trigger.getBoundingClientRect().bottom;
      setMenuMaxHeight(Math.max(160, window.innerHeight - bottom - 16));
    }
    setMoreOpen(true);
  }, []);

  useEffect(() => {
    if (!moreOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        closeMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [moreOpen, closeMenu]);

  // Secondary tabs are pinned into "More"; primaries spill in after them
  // when the row is too narrow. Before measurement every primary is rendered
  // (invisibly) so its width can be read.
  const visibleTabs = measured ? primaryTabs.slice(0, visibleCount) : primaryTabs;
  // Overflow is ordered group-first (groups in the order they first appear in
  // `tabs`, ungrouped first), so a primary that spilled for width lands in
  // its own section of "More" instead of forming a stray run at the top that
  // repeats the group headers below it.
  const overflowIds = new Set([...primaryTabs.slice(measured ? visibleCount : primaryTabs.length), ...secondaryTabs].map(t => t.id));
  const groupOrder = new Map<string, number>();
  for (const tab of tabs) {
    if (tab.group && !groupOrder.has(tab.group)) groupOrder.set(tab.group, groupOrder.size);
  }
  const overflowTabs = tabs
    .filter(t => overflowIds.has(t.id))
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const ga = a.t.group ? groupOrder.get(a.t.group)! : -1;
      const gb = b.t.group ? groupOrder.get(b.t.group)! : -1;
      return ga - gb || a.i - b.i;
    })
    .map(({ t }) => t);
  const hiddenNeedsAttention = overflowTabs.some(t => t.id !== activeTab && (t.count ?? 0) > 0);
  const activeInOverflow = overflowTabs.some(t => t.id === activeTab);
  const activeOverflowTab = overflowTabs.find(t => t.id === activeTab);
  // Roving tabindex normally lands on whichever visible tab is active. When
  // the active tab has been pushed into the "More" overflow instead, none of
  // the visible tabs would get tabIndex 0 — a keyboard user tabbing to the
  // tablist would land nowhere reachable. Fall back to the first visible tab
  // in that case so the tablist always has exactly one stop in the Tab order.
  const rovingTabId = visibleTabs.some(t => t.id === activeTab) ? activeTab : visibleTabs[0]?.id;

  // APG menu pattern: opening moves focus to the active item (or the first),
  // arrows wrap, Home/End jump, Escape closes and hands focus back.
  useEffect(() => {
    if (!moreOpen) return;
    const items = menuItemRefs.current.filter(Boolean);
    const activeIndex = overflowTabs.findIndex(t => t.id === activeTab);
    (items[activeIndex >= 0 ? activeIndex : 0] ?? items[0])?.focus();
  }, [moreOpen]); // run on open only — the item list is stable while open

  const handleMenuKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const items = menuItemRefs.current.filter(Boolean);
      if (items.length === 0) return;
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      let next: number | null = null;
      switch (event.key) {
        case 'ArrowDown': next = (current + 1) % items.length; break;
        case 'ArrowUp': next = (current - 1 + items.length) % items.length; break;
        case 'Home': next = 0; break;
        case 'End': next = items.length - 1; break;
        case 'Escape':
          event.preventDefault();
          closeMenu(true);
          return;
        case 'Tab':
          closeMenu(false);
          return;
        default:
          return;
      }
      event.preventDefault();
      items[next]?.focus();
    },
    [closeMenu],
  );

  // Measure the trigger whenever it is on screen so the next width pass uses
  // its real size rather than the bootstrap fallback.
  useLayoutEffect(() => {
    const w = moreButtonRef.current?.offsetWidth;
    if (w && w !== moreWidthRef.current) {
      moreWidthRef.current = w;
      computeVisible();
    }
  });

  // Roving tabindex across the VISIBLE tabs only (ARIA tabs pattern, "automatic
  // activation" variant): arrowing changes both focus and selection, matching
  // the click behavior the hash-driven pages already have. Overflow tabs sit
  // behind the "More" menu and aren't part of this roving sequence — they're
  // reached like any other menu, via Tab to the trigger then into its items.
  const handleTabKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const count = visibleTabs.length;
      let nextIndex = index;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % count;
      else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + count) % count;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = count - 1;
      const nextTab = visibleTabs[nextIndex];
      if (!nextTab) return;
      onTabChange(nextTab.id);
      tabButtonRefs.current[nextTab.id]?.focus();
    },
    [visibleTabs, onTabChange],
  );

  const tabClass = (isActive: boolean) =>
    `flex items-center gap-2 whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition ${
      isActive
        ? 'border-primary text-primary'
        : 'border-transparent text-muted-foreground hover:border-muted-foreground hover:text-foreground'
    }`;

  return (
    <div ref={containerRef} className="border-b">
      <nav
        ref={navRef as React.RefObject<HTMLElement>}
        role="tablist"
        className={`-mb-px flex items-center gap-3 ${measured ? '' : 'invisible'}`}
      >
        {visibleTabs.map((tab, index) => {
          const isActive = activeTab === tab.id;
          const tabId = overflowTabId(tab.id, testIdPrefix);
          return (
            <span key={tab.id} className="contents">
              {tab.separator && <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />}
              <button
                type="button"
                id={tabId}
                role="tab"
                aria-selected={isActive}
                aria-controls={overflowPanelId(tab.id, testIdPrefix)}
                tabIndex={tab.id === rovingTabId ? 0 : -1}
                title={tab.title}
                data-testid={testIdPrefix ? `${testIdPrefix}${tab.id}` : undefined}
                ref={(el) => { tabButtonRefs.current[tab.id] = el; }}
                onClick={() => onTabChange(tab.id)}
                onKeyDown={(e) => handleTabKeyDown(e, index)}
                className={`${tabClass(isActive)} focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring`}
              >
                {tab.icon}
                {tab.label}
                <CountBadge count={tab.count} testId={testIdPrefix ? `${testIdPrefix}${tab.id}-count` : undefined} />
                {tab.dot && <span className="h-2 w-2 rounded-full bg-green-500" />}
              </button>
            </span>
          );
        })}
        {overflowTabs.length > 0 && (
          <div ref={moreRef} className="relative">
            <button
              ref={moreButtonRef}
              type="button"
              // The closed menu unmounts its items. Its trigger displays the
              // active tab's label, so it owns that label id until reopened.
              id={!moreOpen && activeOverflowTab ? overflowTabId(activeOverflowTab.id, testIdPrefix) : undefined}
              data-testid={testIdPrefix ? `${testIdPrefix}more` : undefined}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              onClick={() => (moreOpen ? closeMenu(false) : openMenu())}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' && !moreOpen) { e.preventDefault(); openMenu(); }
                if (e.key === 'Escape' && moreOpen) { e.preventDefault(); closeMenu(true); }
              }}
              className={`${tabClass(activeInOverflow)} focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring`}
            >
              {activeInOverflow && activeOverflowTab ? (
                <>{activeOverflowTab.icon} {activeOverflowTab.label}<CountBadge count={activeOverflowTab.count} /></>
              ) : (
                <>{t('shared.more')}</>
              )}
              <HiddenDot show={hiddenNeedsAttention} testId={`${testIdPrefix ?? ''}overflow-tabs-hidden-dot`} />
              <ChevronDown aria-hidden="true" className={`h-3.5 w-3.5 transition ${moreOpen ? 'rotate-180' : ''}`} />
            </button>
            {moreOpen && (
              <div
                ref={menuRef}
                role="menu"
                aria-label={t('shared.more')}
                onKeyDown={handleMenuKeyDown}
                style={menuMaxHeight ? { maxHeight: `${menuMaxHeight}px` } : undefined}
                className="absolute right-0 top-full z-20 mt-1 min-w-[240px] overflow-y-auto rounded-md border bg-card py-1 shadow-lg"
              >
                {overflowTabs.map((tab, index) => (
                  <span key={tab.id} className="contents">
                  {tab.group && tab.group !== overflowTabs[index - 1]?.group && (
                    <div
                      data-overflow-group={tab.group}
                      className={`px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground ${index > 0 ? 'mt-1 border-t' : ''}`}
                    >
                      {tab.group}
                    </div>
                  )}
                  <button
                    id={overflowTabId(tab.id, testIdPrefix)}
                    ref={(el) => { if (el) menuItemRefs.current[index] = el; else delete menuItemRefs.current[index]; }}
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    title={tab.title}
                    data-testid={testIdPrefix ? `${testIdPrefix}${tab.id}` : undefined}
                    onClick={() => { onTabChange(tab.id); closeMenu(true); }}
                    className={`flex w-full items-center gap-2 px-4 py-2 text-left text-sm transition focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                      activeTab === tab.id
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    }`}
                  >
                    {tab.icon}
                    {tab.label}
                    <CountBadge count={tab.count} testId={testIdPrefix ? `${testIdPrefix}${tab.id}-count` : undefined} />
                    {tab.dot && <span className="h-2 w-2 rounded-full bg-green-500" />}
                  </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </nav>
    </div>
  );
}
