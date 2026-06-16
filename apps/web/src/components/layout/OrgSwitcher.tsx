import { useState, useEffect, useRef } from 'react';
import {
  Building2,
  ChevronDown,
  ChevronRight,
  Globe,
  MapPin,
  Check,
  Loader2
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useOrgStore, type Organization, type Site } from '@/stores/orgStore';
import { waitForPendingRefresh } from '@/stores/auth';
import { showToast } from '@/components/shared/Toast';
import { isGlobalScopeRoute } from '../../lib/routeScope';

// Switching org/site reloads the page. Stash a confirmation message so the
// destination page can surface "Switched to X" after the reload, landing the
// peak-end of every context switch on a clear success rather than a blank flash.
const SWITCH_TOAST_KEY = 'breeze.orgSwitch.toast';

function stashSwitchToast(message: string) {
  try {
    sessionStorage.setItem(SWITCH_TOAST_KEY, message);
  } catch {
    // sessionStorage can throw in private-mode/quota edge cases; the toast is a
    // nicety, never block the switch on it.
  }
}

/**
 * When switching organizations, certain detail-view routes show data scoped to
 * the previous org and would render blank or 404 under the new org. For those
 * routes we navigate up to the list view in the destination org instead of
 * reloading the now-inaccessible URL.
 *
 * Returns the destination URL when redirection is needed, otherwise null
 * (meaning the caller should keep the current path and just reload).
 */
export function getOrgSwitchRedirect(pathname: string): string | null {
  // /devices/:id -> /devices (but not /devices, /devices/compare, /devices/groups, etc.)
  const deviceDetail = pathname.match(/^\/devices\/([^/]+)\/?$/);
  if (deviceDetail) {
    const segment = deviceDetail[1];
    // Preserve sibling routes that share the prefix.
    if (segment !== 'compare' && segment !== 'groups') {
      return '/devices';
    }
  }
  return null;
}

function useCurrentPathname(): string {
  // Initialize to '/' on BOTH the server and the first client render so the
  // hydrated markup matches the SSR output (reading window.location.pathname
  // in the initializer diverges on global routes → React hydration mismatch
  // on every catalog page). The real pathname is read after mount, when the
  // org selector flips global routes to "All Organizations".
  const [pathname, setPathname] = useState('/');
  useEffect(() => {
    const update = () => setPathname(window.location.pathname);
    update();
    document.addEventListener('astro:after-swap', update);
    window.addEventListener('popstate', update);
    return () => {
      document.removeEventListener('astro:after-swap', update);
      window.removeEventListener('popstate', update);
    };
  }, []);
  return pathname;
}

const statusColors: Record<string, string> = {
  active: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
  trial: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300',
  suspended: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300',
  inactive: 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300'
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize',
        statusColors[status] || statusColors.inactive
      )}
    >
      {status}
    </span>
  );
}

function OrgMenuItem({
  org,
  isSelected,
  onSelect,
  sites,
  currentSiteId,
  onSelectSite,
  isExpanded,
  onToggleSites,
  selectedSiteRef
}: {
  org: Organization;
  isSelected: boolean;
  onSelect: () => void;
  sites: Site[];
  currentSiteId: string | null;
  onSelectSite: (siteId: string | null) => void;
  // Expansion state is owned by the parent OrgSwitcher so it can be seeded
  // from the current selection when the dropdown opens (#1319). This item is
  // purely presentational for expansion.
  isExpanded: boolean;
  onToggleSites: () => void;
  // The parent passes a ref it attaches to whichever org's currently-selected
  // site row is rendered, so it can scrollIntoView after the submenu mounts.
  selectedSiteRef: (el: HTMLButtonElement | null) => void;
}) {
  const orgSites = sites.filter((site) => site.orgId === org.id);
  const hasSites = orgSites.length > 0;
  const showSites = isExpanded && hasSites;

  return (
    <div className="relative">
      <button
        onClick={() => {
          onSelect();
          if (hasSites) {
            onToggleSites();
          }
        }}
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted',
          isSelected && 'bg-muted'
        )}
      >
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">{org.name}</span>
          {isSelected && <Check className="h-4 w-4 text-primary" />}
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={org.status} />
          {hasSites && (
            <ChevronRight
              className={cn(
                'h-4 w-4 text-muted-foreground transition-transform',
                showSites && 'rotate-90'
              )}
            />
          )}
        </div>
      </button>

      {/* Sites submenu */}
      {showSites && (
        <div className="ml-6 mt-1 border-l pl-2">
          <button
            onClick={() => onSelectSite(null)}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted',
              currentSiteId === null && isSelected && 'bg-muted'
            )}
          >
            <span className="text-muted-foreground">All Sites</span>
            {currentSiteId === null && isSelected && (
              <Check className="h-3 w-3 text-primary" />
            )}
          </button>
          {orgSites.map((site) => (
            <button
              key={site.id}
              ref={currentSiteId === site.id ? selectedSiteRef : undefined}
              onClick={() => onSelectSite(site.id)}
              className={cn(
                'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted',
                currentSiteId === site.id && 'bg-muted'
              )}
            >
              <div className="flex items-center gap-2">
                <MapPin className="h-3 w-3 text-muted-foreground" />
                <span>{site.name}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {site.deviceCount} devices
                </span>
                {currentSiteId === site.id && (
                  <Check className="h-3 w-3 text-primary" />
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Pill toggle that flips the global org scope, sitting to the LEFT of the org
 * picker. It drives the same `currentOrgId === null` model the rest of the app
 * reads: "All orgs" clears the selection (partner-wide), "Current" returns to
 * the last concrete org. The picker dropdown remains for choosing *which* org.
 *
 * Hidden when the user has access to a single org (toggle would be a no-op) and
 * on global/catalog routes (those are partner-wide regardless of selection, so
 * a toggle there would be misleading — see routeScope).
 */
function OrgScopePill({ isGlobalRoute }: { isGlobalRoute: boolean }) {
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const lastOrgId = useOrgStore((s) => s.lastOrgId);
  const organizations = useOrgStore((s) => s.organizations);
  const setOrganization = useOrgStore((s) => s.setOrganization);
  // Which scope is being applied, so the button shows a spinner and the pair is
  // disabled while the reload that propagates the new scope is prepared.
  const [applying, setApplying] = useState<'current' | 'all' | null>(null);

  if (organizations.length <= 1 || isGlobalRoute) return null;

  const isAll = currentOrgId === null;

  // Flipping scope changes the orgId-injection chokepoint in orgStore, but only
  // pages with the selection in their fetch deps refetch live. Rather than rely
  // on every list page opting in, reload after the flip so the new scope takes
  // effect everywhere immediately — mirroring the org-switch path. Re-clicking
  // the active scope is a no-op (no needless reload).
  const apply = async (next: 'current' | 'all') => {
    if (applying) return;
    if ((next === 'all') === isAll) return;
    setApplying(next);
    if (next === 'all') {
      setOrganization('');
      stashSwitchToast('Showing all organizations');
    } else {
      const target =
        lastOrgId && organizations.some((o) => o.id === lastOrgId)
          ? lastOrgId
          : organizations[0]?.id;
      if (!target) {
        setApplying(null);
        return;
      }
      setOrganization(target);
      const name = organizations.find((o) => o.id === target)?.name ?? 'organization';
      stashSwitchToast(`Showing ${name}`);
    }
    await waitForPendingRefresh();
    const redirect = getOrgSwitchRedirect(window.location.pathname);
    if (redirect) window.location.href = redirect;
    else window.location.reload();
  };

  return (
    <div
      role="group"
      aria-label="Organization scope"
      data-testid="org-scope-pill"
      className="inline-flex shrink-0 overflow-hidden rounded-md border text-xs"
    >
      <button
        type="button"
        data-testid="org-scope-current"
        onClick={() => void apply('current')}
        aria-pressed={!isAll}
        disabled={applying !== null}
        className={cn(
          'flex items-center gap-1 px-2 py-1.5 transition-colors disabled:opacity-60',
          !isAll ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
        )}
        title="Show data for the selected organization only"
      >
        {applying === 'current' ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Building2 className="h-3 w-3" />
        )}
        <span className="hidden sm:inline">Current</span>
      </button>
      <button
        type="button"
        data-testid="org-scope-all"
        onClick={() => void apply('all')}
        aria-pressed={isAll}
        disabled={applying !== null}
        className={cn(
          'flex items-center gap-1 px-2 py-1.5 transition-colors disabled:opacity-60',
          isAll ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
        )}
        title="Show data across every accessible organization"
      >
        {applying === 'all' ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Globe className="h-3 w-3" />
        )}
        <span className="hidden sm:inline">All orgs</span>
      </button>
    </div>
  );
}

export default function OrgSwitcher() {
  const [isOpen, setIsOpen] = useState(false);
  // True from the moment a switch is initiated until the page reloads — shows a
  // spinner on the trigger and disables it so the bar never silently freezes.
  const [switching, setSwitching] = useState(false);
  // Which org rows have their sites submenu expanded. Owned here (not per-item)
  // so it can be seeded from the current selection when the dropdown opens
  // (#1319) — a user whose scope is a site lands on it pre-expanded.
  const [expandedOrgIds, setExpandedOrgIds] = useState<Set<string>>(new Set());
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Set by OrgMenuItem on whichever org renders the currently-selected site row,
  // so the open effect can scroll it into view once the submenu has mounted.
  const selectedSiteRef = useRef<HTMLButtonElement | null>(null);

  const {
    currentOrgId,
    currentSiteId,
    organizations,
    sites,
    isLoading,
    setOrganization,
    setSite,
    fetchOrganizations,
    fetchSites
  } = useOrgStore();

  const pathname = useCurrentPathname();
  const isGlobalRoute = isGlobalScopeRoute(pathname);

  // Surface the "Switched to X" confirmation stashed before the last reload.
  useEffect(() => {
    let message: string | null = null;
    try {
      message = sessionStorage.getItem(SWITCH_TOAST_KEY);
      if (message) sessionStorage.removeItem(SWITCH_TOAST_KEY);
    } catch {
      message = null;
    }
    if (message) showToast({ type: 'success', message });
  }, []);

  // Fetch data on mount
  useEffect(() => {
    fetchOrganizations();
  }, [fetchOrganizations]);

  // Fetch sites when org changes
  useEffect(() => {
    if (currentOrgId) {
      fetchSites();
    }
  }, [currentOrgId, fetchSites]);

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
  // returns focus to the trigger; Arrow keys rove focus across the org/site
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
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = Array.from(
          panelRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []
        );
        if (items.length === 0) return;
        e.preventDefault();
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        // -1 (nothing focused yet) + down → 0; wrap at both ends.
        const next = (current + delta + items.length) % items.length;
        items[next]?.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen]);

  // Seed expansion + scroll-to-selection when the dropdown opens (#1319).
  // When the active scope is a site, pre-expand its ancestor org (which is
  // simply `currentOrgId` — sites are only fetched for the current org) so the
  // user lands on their current context instead of a flat list of collapsed
  // orgs. Re-seed on every open so re-opening reflects the live selection
  // rather than stale manual toggles. With no org selected (partner-wide /
  // page-aware All-orgs view) there is no single "current" site, so don't
  // auto-expand anything.
  useEffect(() => {
    if (!isOpen) return;
    if (currentSiteId && currentOrgId) {
      setExpandedOrgIds(new Set([currentOrgId]));
    } else {
      setExpandedOrgIds(new Set());
    }
  }, [isOpen, currentOrgId, currentSiteId]);

  // After the submenu has mounted (next frame), scroll the selected site row
  // into view so it's visible even on a long org list. jsdom stubs
  // scrollIntoView as a no-op, so the guard keeps tests from throwing.
  useEffect(() => {
    if (!isOpen) return;
    const raf = requestAnimationFrame(() => {
      selectedSiteRef.current?.scrollIntoView?.({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(raf);
  }, [isOpen, expandedOrgIds, currentSiteId]);

  // Get current selections
  const currentOrg = organizations.find((org) => org.id === currentOrgId);
  const currentSite = sites.find((site) => site.id === currentSiteId);

  // Build display text. On a global route (catalog) always show "All Organizations"
  // so the user can see they're in partner-wide scope. On a scoped route, show
  // the selected org (and site), or "All Organizations" if nothing is selected.
  const displayText = isGlobalRoute
    ? 'All Organizations'
    : currentOrg
      ? currentSite
        ? `${currentOrg.name} / ${currentSite.name}`
        : currentOrg.name
      : 'All Organizations';

  return (
    <div className="flex min-w-0 items-center gap-1 sm:gap-2">
      <OrgScopePill isGlobalRoute={isGlobalRoute} />
      <div className="relative" ref={dropdownRef}>
        <button
          ref={triggerRef}
          data-testid="org-switcher-trigger"
          onClick={() => setIsOpen(!isOpen)}
          aria-haspopup="true"
          aria-expanded={isOpen}
          className={cn(
            'flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1.5 text-sm hover:bg-muted disabled:opacity-70 sm:gap-2 sm:px-3',
            isGlobalRoute && 'opacity-70'
          )}
          disabled={isLoading || switching}
          title={isGlobalRoute
            ? 'This page shows all organizations'
            : 'Select Organization (Cmd+O)'}
        >
          {isLoading || switching ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          ) : isGlobalRoute || !currentOrgId ? (
            <Globe className="h-4 w-4 shrink-0" />
          ) : (
            <Building2 className="h-4 w-4 shrink-0" />
          )}
          <span
            data-testid="org-switcher-label"
            className="hidden min-w-0 truncate md:inline-block md:max-w-[10rem] lg:max-w-[200px]"
          >
            {switching ? 'Switching…' : displayText}
          </span>
          {!isGlobalRoute && currentOrg && (
            <span className="hidden shrink-0 md:inline-flex">
              <StatusBadge status={currentOrg.status} />
            </span>
          )}
          <ChevronDown
            className={cn(
              'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
              isOpen && 'rotate-180'
            )}
          />
        </button>

      {isOpen && (
        <div ref={panelRef} data-testid="org-switcher-panel" className="absolute left-0 top-full z-50 mt-1 w-80 rounded-md border bg-popover p-2 shadow-lg">
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
            Organizations
          </div>

          {organizations.length === 0 ? (
            <div className="px-2 py-4 text-center text-sm text-muted-foreground">
              {isLoading ? 'Loading...' : 'No organizations available'}
            </div>
          ) : (
            <div className="max-h-[calc(100vh-160px)] space-y-1 overflow-y-auto">
              {/* All-orgs scope lives in the OrgScopePill toggle to the left of
                  the picker; the dropdown is for choosing which specific org. */}
              {organizations.map((org) => (
                <OrgMenuItem
                  key={org.id}
                  org={org}
                  isSelected={org.id === currentOrgId}
                  isExpanded={expandedOrgIds.has(org.id)}
                  onToggleSites={() =>
                    setExpandedOrgIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(org.id)) {
                        next.delete(org.id);
                      } else {
                        next.add(org.id);
                      }
                      return next;
                    })
                  }
                  selectedSiteRef={(el) => {
                    // Callback ref on the currently-selected site row. React
                    // calls it with the element on mount and null on unmount;
                    // tracking both keeps the parent from scrolling a detached
                    // node after the org is collapsed.
                    selectedSiteRef.current = el;
                  }}
                  onSelect={async () => {
                    if (org.id !== currentOrgId) {
                      setSwitching(true);
                      setOrganization(org.id);
                      stashSwitchToast(`Switched to ${org.name}`);
                      // Wait for any in-flight /auth/refresh to settle before
                      // navigating — leaving while a refresh is mid-flight
                      // clears the cookie jti and bounces to /login (#950,
                      // fixed in #953/#956/#958).
                      await waitForPendingRefresh();
                      const redirect = getOrgSwitchRedirect(window.location.pathname);
                      if (redirect) {
                        window.location.href = redirect;
                      } else {
                        window.location.reload();
                      }
                    }
                  }}
                  sites={sites}
                  currentSiteId={currentSiteId}
                  onSelectSite={async (siteId) => {
                    const changed = siteId !== currentSiteId;
                    setSite(siteId);
                    setIsOpen(false);
                    if (changed) {
                      setSwitching(true);
                      const siteName = siteId
                        ? sites.find((s) => s.id === siteId)?.name ?? 'site'
                        : null;
                      stashSwitchToast(
                        siteName ? `Switched to ${siteName}` : 'Showing all sites'
                      );
                      // Same #950 refresh-race guard before reloading.
                      await waitForPendingRefresh();
                      window.location.reload();
                    }
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}
