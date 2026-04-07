import { useMemo, useState, useEffect, useRef } from 'react';
import { Search, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, ArrowUpDown, MoreHorizontal, MoreVertical, Filter, Terminal, FileCode, RotateCcw, Settings, Trash2 } from 'lucide-react';
import type { DesktopAccessState, FilterConditionGroup, RemoteAccessPolicy } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import ConnectDesktopButton from '../remote/ConnectDesktopButton';
import { widthPercentClass } from '@/lib/utils';
import { formatLastSeen } from '@/lib/formatTime';
import { DEVICE_ROLES, getDeviceRoleLabel, getDeviceRoleIcon, type DeviceRole } from '@/lib/deviceRoles';

export type DeviceStatus = 'online' | 'offline' | 'maintenance' | 'decommissioned' | 'quarantined';
export type OSType = 'windows' | 'macos' | 'linux';

export type Device = {
  id: string;
  hostname: string;
  os: OSType;
  osVersion: string;
  status: DeviceStatus;
  cpuPercent: number;
  ramPercent: number;
  lastSeen: string;
  orgId: string;
  orgName: string;
  siteId: string;
  siteName: string;
  agentVersion: string;
  tags: string[];
  lastUser?: string;
  uptimeSeconds?: number;
  deviceRole?: DeviceRole;
  deviceRoleSource?: string;
  displayName?: string;
  isHeadless?: boolean;
  desktopAccess?: DesktopAccessState | null;
  remoteAccessPolicy?: RemoteAccessPolicy | null;
};

type DeviceListProps = {
  devices: Device[];
  orgs?: { id: string; name: string }[];
  sites?: { id: string; name: string }[];
  timezone?: string;
  onSelect?: (device: Device) => void;
  onAction?: (action: string, device: Device) => void;
  onBulkAction?: (action: string, devices: Device[]) => void;
  pageSize?: number;
  serverFilter?: FilterConditionGroup | null;
};

const statusColors: Record<DeviceStatus, string> = {
  online: 'bg-success/15 text-success border-success/30',
  offline: 'bg-destructive/15 text-destructive border-destructive/30',
  maintenance: 'bg-warning/15 text-warning border-warning/30',
  decommissioned: 'bg-muted text-muted-foreground border-border',
  quarantined: 'bg-warning/15 text-warning border-warning/30'
};

const statusLabels: Record<DeviceStatus, string> = {
  online: 'Online',
  offline: 'Offline',
  maintenance: 'Maintenance',
  decommissioned: 'Decommissioned',
  quarantined: 'Quarantined'
};

const osLabels: Record<OSType, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux'
};

type SortField = 'hostname' | 'status' | 'cpuPercent' | 'ramPercent' | 'lastSeen' | null;
type SortDirection = 'asc' | 'desc';

export default function DeviceList({
  devices,
  orgs = [],
  sites = [],
  timezone,
  onSelect,
  onAction,
  onBulkAction,
  pageSize = 10,
  serverFilter = null
}: DeviceListProps) {
  // Use provided timezone or browser default
  const effectiveTimezone = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [osFilter, setOsFilter] = useState<string>('all');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [orgFilter, setOrgFilter] = useState<string>('all');
  const [siteFilter, setSiteFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false);
  const [rowMenuOpenId, setRowMenuOpenId] = useState<string | null>(null);
  const rowMenuRef = useRef<HTMLDivElement>(null);
  const [serverFilterIds, setServerFilterIds] = useState<Set<string> | null>(null);
  const [serverFilterLoading, setServerFilterLoading] = useState(false);
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [sortField, setSortField] = useState<SortField>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  // Close row action menu on outside click
  useEffect(() => {
    if (!rowMenuOpenId) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (rowMenuRef.current && !rowMenuRef.current.contains(e.target as Node)) {
        setRowMenuOpenId(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [rowMenuOpenId]);

  // Fetch matching device IDs from server when advanced filter changes
  useEffect(() => {
    if (!serverFilter) {
      setServerFilterIds(null);
      return;
    }

    const hasValidConditions = serverFilter.conditions.some(c => {
      if ('conditions' in c) return true;
      return c.value !== '' && c.value !== null && c.value !== undefined;
    });

    if (!hasValidConditions) {
      setServerFilterIds(null);
      return;
    }

    setServerFilterLoading(true);
    const controller = new AbortController();

    fetchWithAuth('/filters/preview', {
      method: 'POST',
      body: JSON.stringify({ conditions: serverFilter, limit: 100 }),
      signal: controller.signal
    })
      .then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          const result = data.data ?? data;
          const ids = new Set<string>((result.devices ?? []).map((d: { id: string }) => d.id));
          setServerFilterIds(ids);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          console.error('Filter preview failed:', err);
          setServerFilterIds(null);
        }
      })
      .finally(() => setServerFilterLoading(false));

    return () => controller.abort();
  }, [serverFilter]);

  const filteredDevices = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return devices.filter(device => {
      // Apply server-side advanced filter
      if (serverFilterIds !== null && !serverFilterIds.has(device.id)) {
        return false;
      }

      const matchesQuery = normalizedQuery.length === 0
        ? true
        : device.hostname.toLowerCase().includes(normalizedQuery) ||
          (device.displayName?.toLowerCase().includes(normalizedQuery) ?? false);
      const matchesStatus = statusFilter === 'all' ? true : device.status === statusFilter;
      const matchesOs = osFilter === 'all' ? true : device.os === osFilter;
      const matchesRole = roleFilter === 'all' ? true : device.deviceRole === roleFilter;
      const matchesOrg = orgFilter === 'all' ? true : device.orgId === orgFilter;
      const matchesSite = siteFilter === 'all' ? true : device.siteId === siteFilter;

      return matchesQuery && matchesStatus && matchesOs && matchesRole && matchesOrg && matchesSite;
    });
  }, [devices, query, statusFilter, osFilter, roleFilter, orgFilter, siteFilter, serverFilterIds]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const sortedDevices = useMemo(() => {
    if (!sortField) return filteredDevices;

    return [...filteredDevices].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'hostname':
          cmp = a.hostname.localeCompare(b.hostname);
          break;
        case 'status':
          cmp = a.status.localeCompare(b.status);
          break;
        case 'cpuPercent':
          cmp = a.cpuPercent - b.cpuPercent;
          break;
        case 'ramPercent':
          cmp = a.ramPercent - b.ramPercent;
          break;
        case 'lastSeen': {
          const aTime = new Date(a.lastSeen).getTime() || 0;
          const bTime = new Date(b.lastSeen).getTime() || 0;
          cmp = aTime - bTime;
          break;
        }
      }
      return sortDirection === 'desc' ? -cmp : cmp;
    });
  }, [filteredDevices, sortField, sortDirection]);

  const moreFiltersCount = [roleFilter, orgFilter, siteFilter].filter(f => f !== 'all').length;

  const totalPages = Math.ceil(sortedDevices.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedDevices = sortedDevices.slice(startIndex, startIndex + pageSize);

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds(new Set(paginatedDevices.map(d => d.id)));
    } else {
      setSelectedIds(new Set());
    }
  };

  const handleSelectOne = (id: string, checked: boolean) => {
    const newSet = new Set(selectedIds);
    if (checked) {
      newSet.add(id);
    } else {
      newSet.delete(id);
    }
    setSelectedIds(newSet);
  };

  const handleBulkAction = (action: string) => {
    const selectedDevices = devices.filter(d => selectedIds.has(d.id));
    onBulkAction?.(action, selectedDevices);
    setBulkMenuOpen(false);
    setSelectedIds(new Set());
  };

  const allSelected = paginatedDevices.length > 0 && paginatedDevices.every(d => selectedIds.has(d.id));
  const someSelected = paginatedDevices.some(d => selectedIds.has(d.id));

  return (
    <div>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            {filteredDevices.length} of {devices.length} devices
            {serverFilterIds !== null && (
              <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                <Filter className="h-3 w-3" />
                Advanced filter active
                {serverFilterLoading && <span className="ml-1 animate-pulse">...</span>}
              </span>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                placeholder="Search by hostname"
                value={query}
                onChange={event => {
                  setQuery(event.target.value);
                  setCurrentPage(1);
                }}
                className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-56"
              />
            </div>
            <select
              value={statusFilter}
              aria-label="Filter by status"
              onChange={event => {
                setStatusFilter(event.target.value);
                setCurrentPage(1);
              }}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-32"
            >
              <option value="all">All Status</option>
              <option value="online">Online</option>
              <option value="offline">Offline</option>
              <option value="maintenance">Maintenance</option>
              <option value="decommissioned">Decommissioned</option>
            </select>
            <select
              value={osFilter}
              aria-label="Filter by operating system"
              onChange={event => {
                setOsFilter(event.target.value);
                setCurrentPage(1);
              }}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-32"
            >
              <option value="all">All OS</option>
              <option value="windows">Windows</option>
              <option value="macos">macOS</option>
              <option value="linux">Linux</option>
            </select>
            <button
              type="button"
              onClick={() => setShowMoreFilters(!showMoreFilters)}
              className="h-10 whitespace-nowrap rounded-md border px-3 text-sm font-medium hover:bg-muted flex items-center gap-1.5"
            >
              <Filter className="h-3.5 w-3.5" />
              More
              {moreFiltersCount > 0 && (
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
                  {moreFiltersCount}
                </span>
              )}
            </button>
            {(query || statusFilter !== 'all' || osFilter !== 'all' || roleFilter !== 'all' || orgFilter !== 'all' || siteFilter !== 'all') && (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  setStatusFilter('all');
                  setOsFilter('all');
                  setRoleFilter('all');
                  setOrgFilter('all');
                  setSiteFilter('all');
                  setCurrentPage(1);
                }}
                className="h-10 whitespace-nowrap rounded-md px-3 text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                Clear filters
              </button>
            )}
          </div>
        </div>
        <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${showMoreFilters ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
          <div className="overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <select
                value={roleFilter}
                aria-label="Filter by device role"
                onChange={event => {
                  setRoleFilter(event.target.value);
                  setCurrentPage(1);
                }}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-36"
              >
                <option value="all">All Roles</option>
                {DEVICE_ROLES.map(role => (
                  <option key={role} value={role}>
                    {getDeviceRoleLabel(role)}
                  </option>
                ))}
              </select>
              {orgs.length > 0 && (
                <select
                  value={orgFilter}
                  aria-label="Filter by organization"
                  onChange={event => {
                    setOrgFilter(event.target.value);
                    setCurrentPage(1);
                  }}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-40"
                >
                  <option value="all">All Orgs</option>
                  {orgs.map(org => (
                    <option key={org.id} value={org.id}>
                      {org.name}
                    </option>
                  ))}
                </select>
              )}
              {sites.length > 0 && (
                <select
                  value={siteFilter}
                  aria-label="Filter by site"
                  onChange={event => {
                    setSiteFilter(event.target.value);
                    setCurrentPage(1);
                  }}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-40"
                >
                  <option value="all">All Sites</option>
                  {sites.map(site => (
                    <option key={site.id} value={site.id}>
                      {site.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
        </div>
      </div>

      {selectedIds.size > 0 && (
        <div className="mt-4 flex items-center gap-3 rounded-md border bg-muted/40 px-4 py-2">
          <span className="text-sm font-medium">{selectedIds.size} selected</span>
          <div className="relative">
            <button
              type="button"
              onClick={() => setBulkMenuOpen(!bulkMenuOpen)}
              className="flex items-center gap-1 rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              Bulk Actions
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {bulkMenuOpen && (
              <div className="absolute left-0 top-full z-10 mt-1 w-48 rounded-md border bg-card shadow-lg">
                <button
                  type="button"
                  onClick={() => handleBulkAction('reboot')}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  Reboot Selected
                </button>
                <button
                  type="button"
                  onClick={() => handleBulkAction('run-script')}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  Run Script
                </button>
                <button
                  type="button"
                  onClick={() => handleBulkAction('deploy-software')}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  Deploy Software
                </button>
                <button
                  type="button"
                  onClick={() => handleBulkAction('maintenance-on')}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  Enable Maintenance
                </button>
                <button
                  type="button"
                  onClick={() => handleBulkAction('maintenance-off')}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  Disable Maintenance
                </button>
                <hr className="my-1" />
                <button
                  type="button"
                  onClick={() => handleBulkAction('decommission')}
                  className="w-full px-4 py-2 text-left text-sm text-destructive hover:bg-destructive/10"
                >
                  Decommission Selected
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Clear selection
          </button>
        </div>
      )}

      <div className="mt-6 overflow-x-auto overflow-y-visible rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-3">
                <input
                  type="checkbox"
                  checked={allSelected}
                  aria-label="Select all devices on this page"
                  ref={el => {
                    if (el) el.indeterminate = someSelected && !allSelected;
                  }}
                  onChange={e => handleSelectAll(e.target.checked)}
                  className="h-4 w-4 rounded border-border"
                />
              </th>
              <th
                className="px-3 py-3 cursor-pointer select-none hover:text-foreground"
                title="Sort by hostname"
                onClick={() => handleSort('hostname')}
              >
                <span className="inline-flex items-center gap-1">
                  Hostname
                  {sortField === 'hostname' ? (
                    sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ArrowUpDown className="h-3 w-3 opacity-30" />
                  )}
                </span>
              </th>
              <th className="px-3 py-3">Organization</th>
              <th className="px-3 py-3">Site</th>
              <th className="px-3 py-3">OS</th>
              <th className="px-3 py-3">Role</th>
              <th
                className="px-3 py-3 cursor-pointer select-none hover:text-foreground"
                title="Sort by status"
                onClick={() => handleSort('status')}
              >
                <span className="inline-flex items-center gap-1">
                  Status
                  {sortField === 'status' ? (
                    sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ArrowUpDown className="h-3 w-3 opacity-30" />
                  )}
                </span>
              </th>
              <th
                className="px-3 py-3 cursor-pointer select-none hover:text-foreground"
                title="Sort by CPU usage"
                onClick={() => handleSort('cpuPercent')}
              >
                <span className="inline-flex items-center gap-1">
                  CPU %
                  {sortField === 'cpuPercent' ? (
                    sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ArrowUpDown className="h-3 w-3 opacity-30" />
                  )}
                </span>
              </th>
              <th
                className="px-3 py-3 cursor-pointer select-none hover:text-foreground"
                title="Sort by RAM usage"
                onClick={() => handleSort('ramPercent')}
              >
                <span className="inline-flex items-center gap-1">
                  RAM %
                  {sortField === 'ramPercent' ? (
                    sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ArrowUpDown className="h-3 w-3 opacity-30" />
                  )}
                </span>
              </th>
              <th
                className="px-3 py-3 cursor-pointer select-none hover:text-foreground"
                title="Sort by last seen time"
                onClick={() => handleSort('lastSeen')}
              >
                <span className="inline-flex items-center gap-1">
                  Last Seen
                  {sortField === 'lastSeen' ? (
                    sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ArrowUpDown className="h-3 w-3 opacity-30" />
                  )}
                </span>
              </th>
              <th className="px-3 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {paginatedDevices.length === 0 ? (
              <tr>
                <td colSpan={11} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No devices found. Try adjusting your search or filters.
                </td>
              </tr>
            ) : (
              paginatedDevices.map(device => (
                <tr
                  key={device.id}
                  onClick={() => onSelect?.(device)}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect?.(device);
                    }
                  }}
                  className="cursor-pointer transition hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
                >
                  <td className="px-3 py-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(device.id)}
                      aria-label={`Select ${device.hostname}`}
                      onClick={e => e.stopPropagation()}
                      onChange={e => handleSelectOne(device.id, e.target.checked)}
                      className="h-4 w-4 rounded border-border"
                    />
                  </td>
                  <td className="max-w-[200px] px-3 py-3 text-sm font-medium">
                    <span className="block truncate" title={device.displayName || device.hostname}>{device.displayName || device.hostname}</span>
                  </td>
                  <td className="max-w-[160px] px-3 py-3 text-sm text-muted-foreground">
                    <span className="block truncate" title={device.orgName}>{device.orgName}</span>
                  </td>
                  <td className="max-w-[160px] px-3 py-3 text-sm text-muted-foreground">
                    <span className="block truncate" title={device.siteName}>{device.siteName}</span>
                  </td>
                  <td className="px-3 py-3 text-sm">{osLabels[device.os]}</td>
                  <td className="px-3 py-3 text-sm">
                    {(() => {
                      const role = device.deviceRole ?? 'unknown';
                      const RoleIcon = getDeviceRoleIcon(role);
                      return (
                        <span className="inline-flex items-center gap-1.5 rounded-full border bg-muted/50 px-2.5 py-1 text-xs font-medium">
                          <RoleIcon className="h-3 w-3" />
                          {getDeviceRoleLabel(role)}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="px-3 py-3 text-sm">
                    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${statusColors[device.status]}`}>
                      {statusLabels[device.status]}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-sm">
                    {device.status === 'online' ? (
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-16 overflow-hidden rounded-full bg-muted">
                          <div
                            className={`h-full rounded-full ${device.cpuPercent > 80 ? 'bg-destructive' : device.cpuPercent > 60 ? 'bg-warning' : 'bg-success'} ${widthPercentClass(device.cpuPercent)}`}
                          />
                        </div>
                        <span className="w-10 text-right tabular-nums">{device.cpuPercent}%</span>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">&mdash;</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-sm">
                    {device.status === 'online' ? (
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-16 overflow-hidden rounded-full bg-muted">
                          <div
                            className={`h-full rounded-full ${device.ramPercent > 80 ? 'bg-destructive' : device.ramPercent > 60 ? 'bg-warning' : 'bg-success'} ${widthPercentClass(device.ramPercent)}`}
                          />
                        </div>
                        <span className="w-10 text-right tabular-nums">{device.ramPercent}%</span>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">&mdash;</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-sm text-muted-foreground whitespace-nowrap">
                    {formatLastSeen(device.lastSeen, effectiveTimezone)}
                  </td>
                  <td className="px-3 py-3 text-sm" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1">
                      <ConnectDesktopButton
                        deviceId={device.id}
                        iconOnly
                        disabled={device.status !== 'online'}
                        isHeadless={device.isHeadless}
                        desktopAccess={device.desktopAccess}
                        remoteAccessPolicy={device.remoteAccessPolicy}
                      />
                      <div className="relative" ref={rowMenuOpenId === device.id ? rowMenuRef : undefined}>
                        <button
                          type="button"
                          onClick={() => setRowMenuOpenId(rowMenuOpenId === device.id ? null : device.id)}
                          className="flex h-8 w-8 items-center justify-center rounded-md transition hover:bg-muted"
                        >
                          <MoreVertical className="h-4 w-4" />
                        </button>
                        {rowMenuOpenId === device.id && (
                          <div className="absolute right-0 top-full z-50 mt-1 w-48 rounded-md border bg-card shadow-lg">
                            <button
                              type="button"
                              disabled={device.status !== 'online'}
                              onClick={() => {
                                onAction?.('terminal', device);
                                setRowMenuOpenId(null);
                              }}
                              className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <Terminal className="h-4 w-4" />
                              Remote Terminal
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                onAction?.('run-script', device);
                                setRowMenuOpenId(null);
                              }}
                              className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
                            >
                              <FileCode className="h-4 w-4" />
                              Run Script
                            </button>
                            <button
                              type="button"
                              disabled={device.status !== 'online'}
                              onClick={() => {
                                onAction?.('reboot', device);
                                setRowMenuOpenId(null);
                              }}
                              className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <RotateCcw className="h-4 w-4" />
                              Reboot
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                onAction?.('settings', device);
                                setRowMenuOpenId(null);
                              }}
                              className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
                            >
                              <Settings className="h-4 w-4" />
                              Settings
                            </button>
                            <hr className="my-1" />
                            {device.status === 'decommissioned' ? (
                              <button
                                type="button"
                                onClick={() => {
                                  onAction?.('restore', device);
                                  setRowMenuOpenId(null);
                                }}
                                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-success hover:bg-success/10"
                              >
                                <RotateCcw className="h-4 w-4" />
                                Restore
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => {
                                  onAction?.('decommission', device);
                                  setRowMenuOpenId(null);
                                }}
                                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-destructive hover:bg-destructive/10"
                              >
                                <Trash2 className="h-4 w-4" />
                                Decommission
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {startIndex + 1} to {Math.min(startIndex + pageSize, sortedDevices.length)} of {sortedDevices.length}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm">
              Page {currentPage} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
