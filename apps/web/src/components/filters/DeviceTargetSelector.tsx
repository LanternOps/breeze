import { useState, useEffect, useMemo, useCallback } from 'react';
import { Search, Monitor, Users, Filter as FilterIcon, Globe } from 'lucide-react';
import type { FilterConditionGroup, DeploymentTargetConfig, DeploymentTargetType } from '@breeze/shared';
import { FilterBuilder, DEFAULT_FILTER_FIELDS } from './FilterBuilder';
import { FilterPreview } from './FilterPreview';
import { useFilterPreview } from '../../hooks/useFilterPreview';
import { fetchWithAuth } from '../../stores/auth';

type TargetMode = 'all' | 'manual' | 'groups' | 'filter';

interface SiteOption {
  id: string;
  name: string;
}

interface GroupOption {
  id: string;
  name: string;
  deviceCount?: number;
}

interface DeviceOption {
  id: string;
  hostname: string;
  os?: string;
  status?: string;
  siteId?: string;
  siteName?: string;
}

interface DeviceTargetSelectorProps {
  value: DeploymentTargetConfig;
  onChange: (value: DeploymentTargetConfig) => void;
  modes?: TargetMode[];
  sites?: SiteOption[];
  groups?: GroupOption[];
  devices?: DeviceOption[];
  showPreview?: boolean;
  showSavedFilters?: boolean;
  className?: string;
}

const MODE_ICONS: Record<TargetMode, typeof Globe> = {
  all: Globe,
  manual: Monitor,
  groups: Users,
  filter: FilterIcon
};

const MODE_LABELS: Record<TargetMode, string> = {
  all: 'All Devices',
  manual: 'Select Devices',
  groups: 'Device Groups',
  filter: 'Advanced Filter'
};

const EMPTY_FILTER: FilterConditionGroup = {
  operator: 'AND',
  conditions: [{ field: 'hostname', operator: 'contains', value: '' }]
};

function modeFromTargetType(type: DeploymentTargetType): TargetMode {
  if (type === 'all') return 'all';
  if (type === 'devices') return 'manual';
  if (type === 'groups') return 'groups';
  if (type === 'filter') return 'filter';
  return 'all';
}

function targetTypeFromMode(mode: TargetMode): DeploymentTargetType {
  if (mode === 'all') return 'all';
  if (mode === 'manual') return 'devices';
  if (mode === 'groups') return 'groups';
  if (mode === 'filter') return 'filter';
  return 'all';
}

export function DeviceTargetSelector({
  value,
  onChange,
  modes = ['all', 'manual', 'groups', 'filter'],
  sites: propSites,
  groups: propGroups,
  devices: propDevices,
  showPreview = true,
  showSavedFilters = true,
  className = ''
}: DeviceTargetSelectorProps) {
  const [activeMode, setActiveMode] = useState<TargetMode>(modeFromTargetType(value.type));
  const [deviceSearch, setDeviceSearch] = useState('');
  const [sites, setSites] = useState<SiteOption[]>(propSites ?? []);
  const [groups, setGroups] = useState<GroupOption[]>(propGroups ?? []);
  const [devices, setDevices] = useState<DeviceOption[]>(propDevices ?? []);
  const [totalDeviceCount, setTotalDeviceCount] = useState<number>(0);
  const [savedFilters, setSavedFilters] = useState<Array<{ id: string; name: string; conditions: FilterConditionGroup }>>([]);
  const [selectedSavedFilterId, setSelectedSavedFilterId] = useState('');

  const filterConditions = value.filter ?? EMPTY_FILTER;
  const { preview, loading: previewLoading, error: previewError, refresh } = useFilterPreview(
    activeMode === 'filter' ? filterConditions : null,
    { enabled: showPreview && activeMode === 'filter' }
  );

  // Fetch data if not provided via props
  useEffect(() => {
    if (!propDevices) {
      fetchWithAuth('/devices').then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          const list = data.data ?? data.devices ?? data ?? [];
          setDevices(list.map((d: Record<string, unknown>) => ({
            id: d.id as string,
            hostname: (d.hostname ?? d.displayName ?? 'Unknown') as string,
            os: (d.osType ?? d.os ?? '') as string,
            status: (d.status ?? '') as string,
            siteId: (d.siteId ?? '') as string
          })));
          setTotalDeviceCount(list.length);
        }
      }).catch(() => {});
    } else {
      setTotalDeviceCount(propDevices.length);
    }
  }, [propDevices]);

  useEffect(() => {
    if (!propGroups) {
      fetchWithAuth('/device-groups').then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          setGroups(data.data ?? data.groups ?? data ?? []);
        }
      }).catch(() => {});
    }
  }, [propGroups]);

  useEffect(() => {
    if (!propSites) {
      fetchWithAuth('/orgs/sites').then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          setSites(data.data ?? data.sites ?? data ?? []);
        }
      }).catch(() => {});
    }
  }, [propSites]);

  useEffect(() => {
    if (showSavedFilters) {
      fetchWithAuth('/filters').then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          setSavedFilters(data.data ?? data.filters ?? []);
        }
      }).catch(() => {});
    }
  }, [showSavedFilters]);

  const handleModeChange = (mode: TargetMode) => {
    setActiveMode(mode);
    const type = targetTypeFromMode(mode);
    onChange({
      type,
      deviceIds: mode === 'manual' ? (value.deviceIds ?? []) : undefined,
      groupIds: mode === 'groups' ? (value.groupIds ?? []) : undefined,
      filter: mode === 'filter' ? (value.filter ?? EMPTY_FILTER) : undefined
    });
  };

  const handleDeviceToggle = (deviceId: string, checked: boolean) => {
    const current = new Set(value.deviceIds ?? []);
    if (checked) current.add(deviceId); else current.delete(deviceId);
    onChange({ ...value, type: 'devices', deviceIds: Array.from(current) });
  };

  const handleGroupToggle = (groupId: string, checked: boolean) => {
    const current = new Set(value.groupIds ?? []);
    if (checked) current.add(groupId); else current.delete(groupId);
    onChange({ ...value, type: 'groups', groupIds: Array.from(current) });
  };

  const handleFilterChange = (conditions: FilterConditionGroup) => {
    setSelectedSavedFilterId('');
    onChange({ ...value, type: 'filter', filter: conditions });
  };

  const handleSavedFilterSelect = (filterId: string) => {
    setSelectedSavedFilterId(filterId);
    if (!filterId) return;
    const filter = savedFilters.find(f => f.id === filterId);
    if (filter) {
      onChange({ ...value, type: 'filter', filter: filter.conditions });
    }
  };

  const filteredDevices = useMemo(() => {
    const q = deviceSearch.trim().toLowerCase();
    if (!q) return devices;
    return devices.filter(d => d.hostname.toLowerCase().includes(q));
  }, [devices, deviceSearch]);

  return (
    <div className={`rounded-lg border bg-card ${className}`}>
      {/* Mode tabs */}
      <div className="flex border-b">
        {modes.map(mode => {
          const Icon = MODE_ICONS[mode];
          const isActive = mode === activeMode;
          return (
            <button
              key={mode}
              type="button"
              onClick={() => handleModeChange(mode)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition border-b-2 -mb-px ${
                isActive
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30'
              }`}
            >
              <Icon className="h-4 w-4" />
              {MODE_LABELS[mode]}
            </button>
          );
        })}
      </div>

      {/* Mode content */}
      <div className="p-4">
        {activeMode === 'all' && (
          <div className="flex items-center gap-3 py-4">
            <Globe className="h-8 w-8 text-muted-foreground" />
            <div>
              <p className="font-medium">Targets all managed devices</p>
              <p className="text-sm text-muted-foreground">
                {totalDeviceCount} device{totalDeviceCount !== 1 ? 's' : ''} total
              </p>
            </div>
          </div>
        )}

        {activeMode === 'manual' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">
                {value.deviceIds?.length ?? 0} device{(value.deviceIds?.length ?? 0) !== 1 ? 's' : ''} selected
              </span>
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={deviceSearch}
                onChange={(e) => setDeviceSearch(e.target.value)}
                placeholder="Search devices..."
                className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="max-h-64 overflow-y-auto space-y-1">
              {filteredDevices.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">No devices found</p>
              ) : (
                filteredDevices.map(device => {
                  const checked = value.deviceIds?.includes(device.id) ?? false;
                  return (
                    <label
                      key={device.id}
                      className="flex items-center gap-3 rounded-md border bg-background px-3 py-2 text-sm transition hover:bg-muted/40 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => handleDeviceToggle(device.id, e.target.checked)}
                        className="h-4 w-4 rounded border-muted text-primary focus:ring-primary"
                      />
                      <div className="flex-1 min-w-0">
                        <span className="font-medium truncate block">{device.hostname}</span>
                        {device.os && (
                          <span className="text-xs text-muted-foreground">{device.os}</span>
                        )}
                      </div>
                      {device.status && (
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          device.status === 'online'
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                            : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400'
                        }`}>
                          {device.status}
                        </span>
                      )}
                    </label>
                  );
                })
              )}
            </div>
          </div>
        )}

        {activeMode === 'groups' && (
          <div className="space-y-3">
            <span className="text-sm font-medium">
              {value.groupIds?.length ?? 0} group{(value.groupIds?.length ?? 0) !== 1 ? 's' : ''} selected
            </span>
            <div className="max-h-64 overflow-y-auto space-y-1">
              {groups.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">No device groups available</p>
              ) : (
                groups.map(group => {
                  const checked = value.groupIds?.includes(group.id) ?? false;
                  return (
                    <label
                      key={group.id}
                      className="flex items-center gap-3 rounded-md border bg-background px-3 py-2 text-sm transition hover:bg-muted/40 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => handleGroupToggle(group.id, e.target.checked)}
                        className="h-4 w-4 rounded border-muted text-primary focus:ring-primary"
                      />
                      <div className="flex-1 min-w-0">
                        <span className="font-medium">{group.name}</span>
                        {typeof group.deviceCount === 'number' && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            ({group.deviceCount} device{group.deviceCount !== 1 ? 's' : ''})
                          </span>
                        )}
                      </div>
                    </label>
                  );
                })
              )}
            </div>
          </div>
        )}

        {activeMode === 'filter' && (
          <div className="space-y-4">
            {showSavedFilters && savedFilters.length > 0 && (
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-muted-foreground">Load saved filter:</label>
                <select
                  value={selectedSavedFilterId}
                  onChange={(e) => handleSavedFilterSelect(e.target.value)}
                  className="h-8 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">Select...</option>
                  {savedFilters.map(f => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </div>
            )}

            <FilterBuilder
              value={filterConditions}
              onChange={handleFilterChange}
              filterFields={DEFAULT_FILTER_FIELDS}
              showPreview={false}
            />

            {showPreview && (
              <FilterPreview
                preview={preview}
                loading={previewLoading}
                error={previewError}
                onRefresh={refresh}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default DeviceTargetSelector;
