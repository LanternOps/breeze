import { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { ChevronDown } from 'lucide-react';

export type OverflowTab = {
  id: string;
  label: string;
  icon: React.ReactNode;
  dot?: boolean;
  /** Render a vertical separator before this tab */
  separator?: boolean;
  /** Tooltip text for non-obvious labels */
  title?: string;
};

export function OverflowTabs({ tabs, activeTab, onTabChange }: {
  tabs: OverflowTab[];
  activeTab: string;
  onTabChange: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const tabWidths = useRef<number[]>([]);
  const [visibleCount, setVisibleCount] = useState(tabs.length);
  const [measured, setMeasured] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

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
    const gap = 16;
    const moreButtonWidth = 120;

    let totalAll = 0;
    for (let i = 0; i < tabWidths.current.length; i++) {
      totalAll += tabWidths.current[i] + (i > 0 ? gap : 0);
    }
    if (totalAll <= availableWidth) {
      setVisibleCount(tabs.length);
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
  }, [tabs.length]);

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

  useEffect(() => {
    if (!moreOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [moreOpen]);

  const visibleTabs = measured ? tabs.slice(0, visibleCount) : tabs;
  const overflowTabs = measured ? tabs.slice(visibleCount) : [];
  const activeInOverflow = overflowTabs.some(t => t.id === activeTab);
  const activeOverflowTab = overflowTabs.find(t => t.id === activeTab);

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
        className={`-mb-px flex items-center gap-4 ${measured ? '' : 'invisible'}`}
      >
        {visibleTabs.map(tab => (
          <span key={tab.id} className="contents">
            {tab.separator && <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />}
            <button
              type="button"
              title={tab.title}
              onClick={() => onTabChange(tab.id)}
              className={tabClass(activeTab === tab.id)}
            >
              {tab.icon}
              {tab.label}
              {tab.dot && <span className="h-2 w-2 rounded-full bg-green-500" />}
            </button>
          </span>
        ))}
        {overflowTabs.length > 0 && (
          <div ref={moreRef} className="relative">
            <button
              type="button"
              onClick={() => setMoreOpen(!moreOpen)}
              className={tabClass(activeInOverflow)}
            >
              {activeInOverflow && activeOverflowTab ? (
                <>{activeOverflowTab.icon} {activeOverflowTab.label}</>
              ) : (
                <>More</>
              )}
              <ChevronDown className={`h-3.5 w-3.5 transition ${moreOpen ? 'rotate-180' : ''}`} />
            </button>
            {moreOpen && (
              <div className="absolute right-0 top-full z-20 mt-1 min-w-[200px] rounded-md border bg-card py-1 shadow-lg">
                {overflowTabs.map(tab => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => { onTabChange(tab.id); setMoreOpen(false); }}
                    className={`flex w-full items-center gap-2 px-4 py-2 text-left text-sm transition ${
                      activeTab === tab.id
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    }`}
                  >
                    {tab.icon}
                    {tab.label}
                    {tab.dot && <span className="h-2 w-2 rounded-full bg-green-500" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </nav>
    </div>
  );
}
