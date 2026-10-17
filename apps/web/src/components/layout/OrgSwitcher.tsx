import { useState, useEffect, useMemo, useRef } from 'react';
import {
  Building2,
  ChevronDown,
  Globe,
  Check,
  ChevronRight,
  Loader2,
  Search
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useOrgStore, type Organization } from '@/stores/orgStore';
import { applyOrgSwitch, consumeSwitchToast, getOrgSwitchRedirect } from '@/lib/orgSwitch';
import { OrgStatusBadge, OrgStatusDot } from './OrgStatusGlyphs';
import { showToast } from '@/components/shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { usePermissions } from '@/lib/permissions';
import { useMediaQuery } from '@/lib/useMediaQuery';
import OrgSwitcherPane from './OrgSwitcherPane';
import { recordStayDestination, visibleDestinations } from './orgSwitcherDestinations';
import { useOrgSummaryCache } from './useOrgSummaryCache';
import { useTranslation } from 'react-i18next';

// Re-exported for callers/tests that import the redirect rule from here.
export { getOrgSwitchRedirect };

// Show the filter input once the list is long enough that scanning beats
// scrolling. Below this the input is dead weight in the panel.
const SEARCH_THRESHOLD = 6;

/**
 * The single org-context control. One dropdown states and changes where the
 * user is working: a pinned, visually distinct "All organizations" (fleet
 * view) row on top, then a searchable org list. The trigger always shows the
 * user's context — including on catalog routes, where the page's scope line
 * (ContextScopeLine) explains that the page itself is context-independent.
 * The old Current/All-orgs pill (#985/#1426) and the per-org site submenu are
 * gone: scope lives here, site filtering lives on the pages that support it.
 */
export default function OrgSwitcher() {
  const { t } = useTranslation('common');
  const [isOpen, setIsOpen] = useState(false);
  // True from the moment a switch is initiated until the soft navigation
  // settles — shows a spinner on the trigger and disables it so the bar never
  // silently freezes. This island is `transition:persist`, so it survives the
  // switch and must clear the flag itself.
  const [switching, setSwitching] = useState(false);
  const [query, setQuery] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  // The org whose pane is showing. Follows hover and keyboard focus; the pane
  // is skipped below 1024px (the 36rem panel would overflow next to the sidebar below that), where the panel stays a single column.
  const isWide = useMediaQuery('(min-width: 1024px)');
  const [highlightedOrgId, setHighlightedOrgId] = useState<string | null>(null);

  const {
    currentOrgId,
    allOrgs,
    organizations,
    isLoading,
    fetchOrganizations,
    recentOrgIds,
    serviceManagementMode
  } = useOrgStore();
  const { permissions } = usePermissions();
  const destinations = useMemo(
    () => visibleDestinations(permissions, serviceManagementMode),
    [permissions, serviceManagementMode]
  );

  const normalizedQuery = query.trim().toLowerCase();
  const visibleOrgs = normalizedQuery
    ? organizations.filter((org) => org.name.toLowerCase().includes(normalizedQuery))
    : organizations;
  // The highlight falls back to the first visible row when the highlighted org
  // is filtered out by the search (or not set yet) — the pane never goes blank
  // or keeps a hidden org.
  const effectiveHighlightId = visibleOrgs.some((o) => o.id === highlightedOrgId)
    ? highlightedOrgId
    : (visibleOrgs[0]?.id ?? null);
  const highlightedOrg = organizations.find((o) => o.id === effectiveHighlightId);
  const lookup = useOrgSummaryCache(isOpen && isWide ? effectiveHighlightId : null, isOpen);

  // The explicit fleet-view intent flag distinguishes "user chose All
  // organizations" from the transient null of a fresh session (#1423).
  const isFleet = !currentOrgId && allOrgs;

  // Surface the "Switched to X" confirmation stashed before a switch that fell
  // back to a full reload (the soft path toasts inside applyOrgSwitch).
  useEffect(() => {
    const message = consumeSwitchToast();
    if (message) showToast({ type: 'success', message });
  }, []);

  // Fetch data on mount
  useEffect(() => {
    fetchOrganizations();
  }, [fetchOrganizations]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Keyboard shortcut: Cmd+O to toggle org switcher; Escape closes it and
  // returns focus to the trigger; Arrow keys rove focus across the fleet/org
  // rows so the bar's most-used control matches the command palette.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'o') {
        e.preventDefault();
        setIsOpen((prev) => !prev);
        return;
      }
      if (!isOpen) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        setIsOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (
        e.key === 'ArrowDown' ||
        e.key === 'ArrowUp' ||
        e.key === 'ArrowRight' ||
        e.key === 'ArrowLeft'
      ) {
        const all = Array.from(
          panelRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []
        );
        const paneEl = paneRef.current;
        // The list column and the pane are separate focus groups: the roving
        // query must not walk into the pane (rows precede it in DOM order).
        const items = all.filter((b) => !paneEl?.contains(b));
        const paneItems = all.filter((b) => paneEl?.contains(b));
        if (items.length === 0) return;
        const active = document.activeElement as HTMLButtonElement | null;
        const inPane = paneItems.includes(active as HTMLButtonElement);
        if (e.key === 'ArrowRight') {
          if (!inPane && items.includes(active as HTMLButtonElement) && paneItems.length > 0) {
            e.preventDefault();
            paneItems[0]?.focus();
          }
          return;
        }
        if (e.key === 'ArrowLeft') {
          if (inPane) {
            e.preventDefault();
            const row = items.find((b) => b.dataset.orgId === effectiveHighlightId);
            (row ?? items[0])?.focus();
          }
          return;
        }
        e.preventDefault();
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        if (inPane) {
          const next = (paneItems.indexOf(active as HTMLButtonElement) + delta + paneItems.length) % paneItems.length;
          paneItems[next]?.focus();
          return;
        }
        // From the search input, ArrowDown enters the list at the top and
        // ArrowUp at the bottom; within the list, wrap at both ends.
        if (active === searchRef.current) {
          (e.key === 'ArrowDown' ? items[0] : items[items.length - 1])?.focus();
          return;
        }
        const current = items.indexOf(active as HTMLButtonElement);
        const next = (current + delta + items.length) % items.length;
        items[next]?.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, effectiveHighlightId]);

  // Fresh query + focused search on every open, so the panel is always ready
  // to type into (the filter never carries over from the previous open).
  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setHighlightedOrgId(currentOrgId);
    const raf = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [isOpen]);

  const currentOrg = organizations.find((org) => org.id === currentOrgId);

  const displayText = switching
    ? t('layout.org.switching')
    : isFleet
      ? t('layout.org.allOrganizations')
      : currentOrg
        ? currentOrg.name
        : t('layout.org.noSelection');

  const recentOrgs = recentOrgIds
    .filter((id) => id !== currentOrgId)
    .map((id) => organizations.find((o) => o.id === id))
    .filter((o): o is Organization => Boolean(o));
  const showRecent = recentOrgs.length > 0 && !normalizedQuery;
  const showSearch = organizations.length >= SEARCH_THRESHOLD;
  // A fleet view of one org is a no-op, and org-scoped users should not be
  // offered a scope their token can't broaden to.
  const showFleetOption = organizations.length > 1;

  // Apply a context change: a concrete org id, or null for fleet view. The
  // soft re-navigation (inside applyOrgSwitch) remounts the page island and so
  // propagates the new scope everywhere at once (pages don't need to
  // subscribe); registered detail routes (see getOrgSwitchRedirect) redirect up
  // to their list first so the new org doesn't 404 on the old org's record.
  const applyContext = async (orgId: string | null, destination?: string) => {
    setIsOpen(false);
    const changed = orgId ? orgId !== currentOrgId : !isFleet;
    if (!changed) {
      // Already in that org: a destination is plain navigation — no switch, no
      // "Switched to" toast for a switch that did not happen.
      if (destination) {
        // A hash-only move on the page we are already on: Astro's router does
        // not fire `hashchange` for it, and the org record's tab strip listens
        // for exactly that — set the hash directly so the tab actually opens.
        const [path, hash] = destination.split('#');
        if (hash && path === window.location.pathname) window.location.hash = hash;
        else await navigateTo(destination);
      }
      return;
    }
    setSwitching(true);
    const message = orgId
      ? t('layout.org.toast.switched', {
          name: organizations.find((o) => o.id === orgId)?.name ?? t('labels.organization')
        })
      : t('layout.org.toast.showingAll');
    try {
      await applyOrgSwitch(orgId, message, destination);
    } finally {
      setSwitching(false);
    }
  };

  // One org row, used by both the Recent group and the main list. Hover and
  // keyboard focus both move the highlight, so the pane (and its lazy summary
  // fetch) follows either input the same way.
  const renderRow = (org: Organization, isRecent: boolean) => {
    const isSelected = org.id === currentOrgId;
    // Only the main-list row carries the highlight; the Recent copy of the same org stays plain.
    const highlighted = !isRecent && org.id === effectiveHighlightId;
    return (
      <button
        key={org.id}
        type="button"
        data-testid={isRecent ? `org-recent-${org.id}` : `org-option-${org.id}`}
        data-org-id={org.id}
        data-highlighted={highlighted ? 'true' : undefined}
        tabIndex={highlighted && !isRecent ? 0 : -1}
        aria-current={isSelected ? 'true' : undefined}
        // #9027: from a record page, a name click switches and stays put.
        onClick={() =>
          void applyContext(
            org.id,
            isSelected ? undefined : recordStayDestination(window.location.pathname, window.location.search),
          )
        }
        onMouseEnter={() => setHighlightedOrgId(org.id)}
        onFocus={() => setHighlightedOrgId(org.id)}
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted',
          (isSelected || highlighted) && 'bg-muted'
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <OrgStatusDot status={org.status} />
          <span className="truncate font-medium">{org.name}</span>
          {isSelected && <Check className="h-4 w-4 shrink-0 text-primary" />}
        </div>
        {highlighted && isWide && (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </button>
    );
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        ref={triggerRef}
        data-testid="org-switcher-trigger"
        data-scope={isFleet ? 'all' : 'org'}
        onClick={() => setIsOpen(!isOpen)}
        aria-haspopup="true"
        aria-expanded={isOpen}
        className={cn(
          'flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1.5 text-sm sm:gap-2 sm:px-3',
          // The ambient fleet-view signal: the trigger itself carries the mode,
          // Stripe-test-mode style, so "I'm looking at everything" is visible
          // from anywhere without a banner.
          isFleet
            ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15'
            : 'hover:bg-muted',
          'disabled:opacity-70'
        )}
        disabled={isLoading || switching}
        title={t('layout.org.selectTitle')}
      >
        {isLoading || switching ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
        ) : isFleet ? (
          <Globe className="h-4 w-4 shrink-0" />
        ) : (
          <Building2 className="h-4 w-4 shrink-0" />
        )}
        <span
          data-testid="org-switcher-label"
          className="inline-block min-w-0 max-w-[7.5rem] truncate sm:max-w-40 lg:max-w-[200px]"
        >
          {displayText}
        </span>
        {!isFleet && currentOrg && (
          <span className="hidden shrink-0 md:inline-flex">
            <OrgStatusBadge status={currentOrg.status} />
          </span>
        )}
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 transition-transform',
            isFleet ? 'text-primary/70' : 'text-muted-foreground',
            isOpen && 'rotate-180'
          )}
        />
      </button>

      {isOpen && (
        <div
          ref={panelRef}
          data-testid="org-switcher-panel"
          className="absolute left-0 top-full z-50 mt-1 w-80 lg:w-[36rem] rounded-md border bg-popover p-2 shadow-lg"
        >
          {showFleetOption && (
            <>
              <button
                type="button"
                data-testid="org-option-all"
                aria-current={isFleet ? 'true' : undefined}
                onClick={() => void applyContext(null)}
                className={cn(
                  'flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left',
                  isFleet ? 'bg-primary/10' : 'hover:bg-muted'
                )}
              >
                <Globe className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {t('layout.org.allOrganizations')}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t('layout.org.fleetView', { count: organizations.length })}
                  </span>
                </span>
                {isFleet && <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />}
              </button>
              <div className="my-2 border-t" />
            </>
          )}

          <div className={cn(isWide && 'grid grid-cols-[250px_1fr] gap-2')}>
            <div className="min-w-0">
              {showSearch && (
                <div className="relative mb-1 px-0.5">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <input
                    ref={searchRef}
                    data-testid="org-switcher-search"
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('layout.org.searchOrganizations')}
                    aria-label={t('layout.org.searchOrganizations')}
                    className="w-full rounded-md border bg-transparent py-1.5 pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground focus:border-primary"
                  />
                </div>
              )}

              {showRecent && (
                <div data-testid="org-switcher-recent" className="mb-1">
                  <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                    {t('layout.org.recent')}
                  </div>
                  <div className="space-y-1">
                    {recentOrgs.map((org) => renderRow(org, true))}
                  </div>
                </div>
              )}

              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                {t('layout.org.organizations')}
              </div>

              {organizations.length === 0 ? (
                <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                  {isLoading ? t('states.loading') : t('layout.org.noneAvailable')}
                </div>
              ) : visibleOrgs.length === 0 ? (
                <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                  {t('layout.org.noMatches')}
                </div>
              ) : (
                <div className="max-h-[calc(100vh-220px)] space-y-1 overflow-y-auto">
                  {visibleOrgs.map((org: Organization) => renderRow(org, false))}
                </div>
              )}
            </div>

            {isWide && highlightedOrg && (
              <div ref={paneRef} className="min-w-0 border-l pl-2">
                <OrgSwitcherPane
                  org={highlightedOrg}
                  summary={lookup.summary}
                  summaryStatus={lookup.status}
                  destinations={destinations}
                  onDestination={(id, target) => void applyContext(id, target)}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
