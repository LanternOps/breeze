import { useState, useEffect, useRef } from 'react';
import {
  Building2,
  ChevronDown,
  Globe,
  Check,
  Loader2,
  Search
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useOrgStore, type Organization } from '@/stores/orgStore';
import { applyOrgSwitch, consumeSwitchToast, getOrgSwitchRedirect } from '@/lib/orgSwitch';
import { showToast } from '@/components/shared/Toast';
import { useTranslation } from 'react-i18next';

// Re-exported for callers/tests that import the redirect rule from here.
export { getOrgSwitchRedirect };

const statusColors: Record<string, string> = {
  active: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
  trial: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300',
  suspended: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300',
  inactive: 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300'
};

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation('common');
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize',
        statusColors[status] || statusColors.inactive
      )}
    >
      {t(/* i18n-dynamic */ `layout.org.status.${status}`, { defaultValue: status })}
    </span>
  );
}

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
  // True from the moment a switch is initiated until the page reloads — shows a
  // spinner on the trigger and disables it so the bar never silently freezes.
  const [switching, setSwitching] = useState(false);
  const [query, setQuery] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const {
    currentOrgId,
    allOrgs,
    organizations,
    isLoading,
    fetchOrganizations
  } = useOrgStore();

  // The explicit fleet-view intent flag distinguishes "user chose All
  // organizations" from the transient null of a fresh session (#1423).
  const isFleet = !currentOrgId && allOrgs;

  // Surface the "Switched to X" confirmation stashed before the last reload.
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
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = Array.from(
          panelRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []
        );
        if (items.length === 0) return;
        e.preventDefault();
        const active = document.activeElement;
        // From the search input, ArrowDown enters the list at the top and
        // ArrowUp at the bottom; within the list, wrap at both ends.
        if (active === searchRef.current) {
          (e.key === 'ArrowDown' ? items[0] : items[items.length - 1])?.focus();
          return;
        }
        const current = items.indexOf(active as HTMLButtonElement);
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        const next = (current + delta + items.length) % items.length;
        items[next]?.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen]);

  // Fresh query + focused search on every open, so the panel is always ready
  // to type into (the filter never carries over from the previous open).
  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
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

  const normalizedQuery = query.trim().toLowerCase();
  const visibleOrgs = normalizedQuery
    ? organizations.filter((org) => org.name.toLowerCase().includes(normalizedQuery))
    : organizations;
  const showSearch = organizations.length >= SEARCH_THRESHOLD;
  // A fleet view of one org is a no-op, and org-scoped users should not be
  // offered a scope their token can't broaden to.
  const showFleetOption = organizations.length > 1;

  // Apply a context change: a concrete org id, or null for fleet view. The
  // reload (inside applyOrgSwitch) propagates the new scope everywhere at once
  // (pages don't need to subscribe); registered detail routes (currently only
  // device detail — see getOrgSwitchRedirect) redirect up to their list first so
  // the new org doesn't 404 on the old org's record.
  const applyContext = async (orgId: string | null) => {
    setIsOpen(false);
    const changed = orgId ? orgId !== currentOrgId : !isFleet;
    if (!changed) return;
    setSwitching(true);
    const message = orgId
      ? t('layout.org.toast.switched', {
          name: organizations.find((o) => o.id === orgId)?.name ?? t('labels.organization')
        })
      : t('layout.org.toast.showingAll');
    await applyOrgSwitch(orgId, message);
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
          className="hidden min-w-0 truncate md:inline-block md:max-w-40 lg:max-w-[200px]"
        >
          {displayText}
        </span>
        {!isFleet && currentOrg && (
          <span className="hidden shrink-0 md:inline-flex">
            <StatusBadge status={currentOrg.status} />
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
          className="absolute left-0 top-full z-50 mt-1 w-80 rounded-md border bg-popover p-2 shadow-lg"
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
              {visibleOrgs.map((org: Organization) => {
                const isSelected = org.id === currentOrgId;
                return (
                  <button
                    key={org.id}
                    data-testid={`org-option-${org.id}`}
                    aria-current={isSelected ? 'true' : undefined}
                    onClick={() => void applyContext(org.id)}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted',
                      isSelected && 'bg-muted'
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate font-medium">{org.name}</span>
                      {isSelected && <Check className="h-4 w-4 shrink-0 text-primary" />}
                    </div>
                    <StatusBadge status={org.status} />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
