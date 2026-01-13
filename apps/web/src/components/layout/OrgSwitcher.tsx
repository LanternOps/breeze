import { useState, useEffect, useRef } from 'react';
import {
  Building2,
  ChevronDown,
  ChevronRight,
  MapPin,
  Check,
  Loader2
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useOrgStore, type Organization, type Site } from '@/stores/orgStore';

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
  onSelectSite
}: {
  org: Organization;
  isSelected: boolean;
  onSelect: () => void;
  sites: Site[];
  currentSiteId: string | null;
  onSelectSite: (siteId: string | null) => void;
}) {
  const [showSites, setShowSites] = useState(false);
  const orgSites = sites.filter((site) => site.organizationId === org.id);
  const hasSites = orgSites.length > 0;

  return (
    <div className="relative">
      <button
        onClick={() => {
          onSelect();
          if (hasSites) {
            setShowSites(!showSites);
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
      {showSites && hasSites && (
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

export default function OrgSwitcher() {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

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

  // Get current selections
  const currentOrg = organizations.find((org) => org.id === currentOrgId);
  const currentSite = sites.find((site) => site.id === currentSiteId);

  // Build display text
  const displayText = currentOrg
    ? currentSite
      ? `${currentOrg.name} / ${currentSite.name}`
      : currentOrg.name
    : 'Select Organization';

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
        disabled={isLoading}
      >
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Building2 className="h-4 w-4" />
        )}
        <span className="max-w-[200px] truncate">{displayText}</span>
        {currentOrg && <StatusBadge status={currentOrg.status} />}
        <ChevronDown
          className={cn(
            'h-4 w-4 transition-transform',
            isOpen && 'rotate-180'
          )}
        />
      </button>

      {isOpen && (
        <div className="absolute left-0 top-full z-50 mt-1 w-80 rounded-md border bg-popover p-2 shadow-lg">
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
            Organizations
          </div>

          {organizations.length === 0 ? (
            <div className="px-2 py-4 text-center text-sm text-muted-foreground">
              {isLoading ? 'Loading...' : 'No organizations available'}
            </div>
          ) : (
            <div className="max-h-80 space-y-1 overflow-y-auto">
              {organizations.map((org) => (
                <OrgMenuItem
                  key={org.id}
                  org={org}
                  isSelected={org.id === currentOrgId}
                  onSelect={() => {
                    setOrganization(org.id);
                  }}
                  sites={sites}
                  currentSiteId={currentSiteId}
                  onSelectSite={(siteId) => {
                    setSite(siteId);
                    setIsOpen(false);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
