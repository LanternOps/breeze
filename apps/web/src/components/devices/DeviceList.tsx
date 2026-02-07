import { useMemo, useState, useEffect } from 'react';
import { Search, ChevronLeft, ChevronRight, MoreHorizontal, Filter } from 'lucide-react';
import type { FilterConditionGroup } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';

const REFERENCE_DATE = new Date('2024-01-15T12:00:00.000Z');

export type DeviceStatus = 'online' | 'offline' | 'maintenance';
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
};

type DeviceListProps = {
  devices: Device[];
  orgs?: { id: string; name: string }[];
  sites?: { id: string; name: string }[];
  timezone?: string;
  onSelect?: (device: Device) => void;
  onBulkAction?: (action: string, devices: Device[]) => void;
  pageSize?: number;
  serverFilter?: FilterConditionGroup | null;
};

const statusColors: Record<DeviceStatus, string> = {
  online: 'bg-green-500/20 text-green-700 border-green-500/40',
  offline: 'bg-red-500/20 text-red-700 border-red-500/40',
  maintenance: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40'
};

const statusLabels: Record<DeviceStatus, string> = {
  online: 'Online',
  offline: 'Offline',
  maintenance: 'Maintenance'
};

const osLabels: Record<OSType, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux'
};

function formatLastSeen(dateString: string, timezone?: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;

  const now = REFERENCE_DATE;
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString([], timezone ? { timeZone: timezone } : undefined);
}

export default function DeviceList({
  devices,
  orgs = [],
  sites = [],
  timezone,
  onSelect,
  onBulkAction,
  pageSize = 10,
  serverFilter = null
}: DeviceListProps) {
  // Use provided timezone or browser default
  const effectiveTimezone = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [osFilter, setOsFilter] = useState<string>('all');
  const [orgFilter, setOrgFilter] = useState<string>('all');
  const [siteFilter, setSiteFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false);
  const [serverFilterIds, setServerFilterIds] = useState<Set<string> | null>(null);
  const [serverFilterLoading, setServerFilterLoading] = useState(false);

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
        : device.hostname.toLowerCase().includes(normalizedQuery);
      const matchesStatus = statusFilter === 'all' ? true : device.status === statusFilter;
      const matchesOs = osFilter === 'all' ? true : device.os === osFilter;
      const matchesOrg = orgFilter === 'all' ? true : device.orgId === orgFilter;
      const matchesSite = siteFilter === 'all' ? true : device.siteId === siteFilter;

      return matchesQuery && matchesStatus && matchesOs && matchesOrg && matchesSite;
    });
  }, [devices, query, statusFilter, osFilter, orgFilter, siteFilter, serverFilterIds]);

  const totalPages = Math.ceil(filteredDevices.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedDevices = filteredDevices.slice(startIndex, startIndex + pageSize);

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
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Devices</h2>
          <div className="flex items-center gap-2">
            <p className="text-sm text-muted-foreground">
              {filteredDevices.length} of {devices.length} devices
            </p>
            {serverFilterIds !== null && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                <Filter className="h-3 w-3" />
                Advanced filter active
                {serverFilterLoading && <span className="ml-1 animate-pulse">...</span>}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
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
          </select>
          <select
            value={osFilter}
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
          {orgs.length > 0 && (
            <select
              value={orgFilter}
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

      <div className="mt-6 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={el => {
                    if (el) el.indeterminate = someSelected && !allSelected;
                  }}
                  onChange={e => handleSelectAll(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300"
                />
              </th>
              <th className="px-4 py-3">Hostname</th>
              <th className="px-4 py-3">Organization</th>
              <th className="px-4 py-3">Site</th>
              <th className="px-4 py-3">OS</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">CPU %</th>
              <th className="px-4 py-3">RAM %</th>
              <th className="px-4 py-3">Last Seen</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {paginatedDevices.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No devices found. Try adjusting your search or filters.
                </td>
              </tr>
            ) : (
              paginatedDevices.map(device => (
                <tr
                  key={device.id}
                  onClick={() => onSelect?.(device)}
                  className="cursor-pointer transition hover:bg-muted/40"
                >
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(device.id)}
                      onClick={e => e.stopPropagation()}
                      onChange={e => handleSelectOne(device.id, e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                  </td>
                  <td className="px-4 py-3 text-sm font-medium">{device.hostname}</td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{device.orgName}</td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{device.siteName}</td>
                  <td className="px-4 py-3 text-sm">{osLabels[device.os]}</td>
                  <td className="px-4 py-3 text-sm">
                    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${statusColors[device.status]}`}>
                      {statusLabels[device.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-16 overflow-hidden rounded-full bg-muted">
                        <div
                          className={`h-full rounded-full ${device.cpuPercent > 80 ? 'bg-red-500' : device.cpuPercent > 60 ? 'bg-yellow-500' : 'bg-green-500'}`}
                          style={{ width: `${device.cpuPercent}%` }}
                        />
                      </div>
                      <span className="w-10 text-right">{device.cpuPercent}%</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-16 overflow-hidden rounded-full bg-muted">
                        <div
                          className={`h-full rounded-full ${device.ramPercent > 80 ? 'bg-red-500' : device.ramPercent > 60 ? 'bg-yellow-500' : 'bg-green-500'}`}
                          style={{ width: `${device.ramPercent}%` }}
                        />
                      </div>
                      <span className="w-10 text-right">{device.ramPercent}%</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {formatLastSeen(device.lastSeen, effectiveTimezone)}
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
            Showing {startIndex + 1} to {Math.min(startIndex + pageSize, filteredDevices.length)} of {filteredDevices.length}
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
