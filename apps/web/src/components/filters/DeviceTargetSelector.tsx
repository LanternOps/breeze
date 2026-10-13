import { useEffect, useMemo, useState } from 'react';
import { Monitor, Users, Filter as FilterIcon, Globe } from 'lucide-react';
import type { FilterConditionGroup, DeploymentTargetConfig, DeploymentTargetType } from '@breeze/shared';
import { FilterBuilder, DEFAULT_FILTER_FIELDS } from './FilterBuilder';
import { FilterPreview } from './FilterPreview';
import { useFilterPreview } from '../../hooks/useFilterPreview';
import { fetchWithAuth } from '../../stores/auth';
import { useTranslation } from 'react-i18next';
import { asList } from '@/lib/asList';
import { useDeviceOptions, type UseDeviceOptionsResult } from '../../hooks/useDeviceOptions';
import { DeviceOptionPicker } from './DeviceOptionPicker';
import { executionRefusedFieldsUsed } from '@/lib/executionRefusedFields';

type TargetMode = 'all' | 'manual' | 'groups' | 'filter';

interface SiteOption {
  id: string;
  name: string;
}

interface GroupOption {
  id: string;
  name: string;
  deviceCount?: number;
  type?: 'static' | 'dynamic';
  filterFieldsUsed?: string[];
}

interface ProvidedDeviceOption {
  id: string;
  hostname: string;
  os?: string;
  status?: string;
  siteId?: string;
  siteName?: string;
}

export interface DeviceTargetSelectorProps {
  value: DeploymentTargetConfig;
  onChange: (value: DeploymentTargetConfig) => void;
  modes?: TargetMode[];
  sites?: SiteOption[];
  groups?: GroupOption[];
  devices?: ProvidedDeviceOption[];
  showPreview?: boolean;
  showSavedFilters?: boolean;
  requireCompleteSet?: boolean;
  /** Scopes the device options AND the self-fetched group list to one org. */
  orgId?: string;
  siteId?: string;
  status?: string;
  osType?: string;
  /**
   * Disable (and explain) groups the server refuses as an execution target
   * because their rules match on device-reported fields. Opt-in: only
   * surfaces that execute against the selected groups should set it.
   */
  flagRefusedGroups?: boolean;
  onCanSubmitChange?: (canSubmit: boolean) => void;
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
  groups: propGroups,
  devices: propDevices,
  showPreview = true,
  showSavedFilters = true,
  requireCompleteSet = false,
  orgId,
  siteId,
  status,
  osType,
  flagRefusedGroups = false,
  onCanSubmitChange,
  className = ''
}: DeviceTargetSelectorProps) {
  const { t } = useTranslation('common');
  const [activeMode, setActiveMode] = useState<TargetMode>(modeFromTargetType(value.type));
  const [deviceSearch, setDeviceSearch] = useState('');
  const [groups, setGroups] = useState<GroupOption[]>(propGroups ?? []);
  const [savedFilters, setSavedFilters] = useState<Array<{ id: string; name: string; conditions: FilterConditionGroup }>>([]);
  const [selectedSavedFilterId, setSelectedSavedFilterId] = useState('');

  const filterConditions = value.filter ?? EMPTY_FILTER;
  const { preview, loading: previewLoading, error: previewError, refresh } = useFilterPreview(
    activeMode === 'filter' ? filterConditions : null,
    { enabled: showPreview && activeMode === 'filter' }
  );

  const fetchedDeviceOptions = useDeviceOptions({
    search: deviceSearch,
    includeIds: value.deviceIds,
    enabled: !propDevices,
    requireCompleteSet,
    orgId,
    siteId,
    status,
    osType,
  });

  const providedDeviceOptions = useMemo<UseDeviceOptionsResult | null>(() => {
    if (!propDevices) return null;
    const options = propDevices.map((device) => ({
      id: device.id,
      hostname: device.hostname,
      displayName: null,
      osType: device.os ?? '',
      status: device.status ?? '',
      siteId: device.siteId || null,
      siteName: device.siteName || null,
    }));
    const ids = new Set(options.map((device) => device.id));
    const unresolved = (value.deviceIds ?? []).some((id) => !ids.has(id));
    const state = unresolved ? 'truncated' : options.length > 0 ? 'ready' : 'empty';
    return {
      options,
      page: {
        nextCursor: null,
        returned: options.length,
        total: options.length,
        hasMore: false,
        observedAt: '',
      },
      state,
      error: null,
      canSubmit: !unresolved,
      loadMore: async () => {},
      retry: () => {},
    };
  }, [propDevices, value.deviceIds]);

  const deviceOptions = providedDeviceOptions ?? fetchedDeviceOptions;
  const totalDeviceCount = deviceOptions.page?.total ?? 0;

  useEffect(() => {
    if (!propGroups) {
      // Scoped to the org when the caller pins one: an org-owned automation can
      // only target its own org's groups, so other orgs' groups are noise (and
      // would be rejected on save).
      const url = orgId ? `/device-groups?orgId=${encodeURIComponent(orgId)}` : '/device-groups';
      fetchWithAuth(url).then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          setGroups(asList(data, 'groups'));
        }
      }).catch(() => {});
    }
  }, [propGroups, orgId]);

  useEffect(() => {
    if (activeMode !== 'manual') onCanSubmitChange?.(true);
  }, [activeMode, onCanSubmitChange]);

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

  const handleGroupToggle = (groupId: string, checked: boolean) => {
    if (checked && flagRefusedGroups) {
      const group = groups.find((g) => g.id === groupId);
      if (group && executionRefusedFieldsUsed(group.filterFieldsUsed).length > 0) return;
    }
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
              {t(/* i18n-dynamic */ `filters.targets.modes.${mode}`, { defaultValue: MODE_LABELS[mode] })}
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
              <p className="font-medium">{t('filters.targets.allManaged')}</p>
              <p className="text-sm text-muted-foreground">
                {t('filters.targets.totalDevices', { count: totalDeviceCount })}
              </p>
            </div>
          </div>
        )}

        {activeMode === 'manual' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">
                {t('filters.targets.selectedDevices', { count: value.deviceIds?.length ?? 0 })}
              </span>
            </div>
            <DeviceOptionPicker
              result={deviceOptions}
              selectedIds={value.deviceIds ?? []}
              onSelectedIdsChange={(deviceIds) => onChange({ ...value, type: 'devices', deviceIds })}
              search={deviceSearch}
              onSearchChange={setDeviceSearch}
              showSelectAll={requireCompleteSet}
              onCanSubmitChange={onCanSubmitChange}
            />
          </div>
        )}

        {activeMode === 'groups' && (
          <div className="space-y-3">
            <span className="text-sm font-medium">
              {t('filters.targets.selectedGroups', { count: value.groupIds?.length ?? 0 })}
            </span>
            <div className="max-h-64 overflow-y-auto space-y-1">
              {groups.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">{t('filters.targets.noGroups')}</p>
              ) : (
                groups.map(group => {
                  const checked = value.groupIds?.includes(group.id) ?? false;
                  const refusedFields = flagRefusedGroups ? executionRefusedFieldsUsed(group.filterFieldsUsed) : [];
                  // A group that is already selected stays toggleable so it can be removed.
                  const disabled = refusedFields.length > 0 && !checked;
                  return (
                    <label
                      key={group.id}
                      className={`flex items-center gap-3 rounded-md border bg-background px-3 py-2 text-sm transition ${
                        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-muted/40'
                      }`}
                    >
                      <input
                        type="checkbox"
                        data-testid={`group-checkbox-${group.id}`}
                        checked={checked}
                        disabled={disabled}
                        onChange={(e) => handleGroupToggle(group.id, e.target.checked)}
                        className="h-4 w-4 rounded border-muted text-primary focus:ring-primary"
                      />
                      <div className="flex-1 min-w-0">
                        <span className="font-medium">{group.name}</span>
                        {group.type === 'dynamic' && (
                          <span
                            data-testid={`group-dynamic-${group.id}`}
                            className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary"
                          >
                            {t('filters.targets.dynamic', { defaultValue: 'Dynamic' })}
                          </span>
                        )}
                        {typeof group.deviceCount === 'number' && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            ({t('filters.targets.deviceCount', { count: group.deviceCount })})
                          </span>
                        )}
                        {refusedFields.length > 0 && (
                          <p data-testid={`group-refused-${group.id}`} className="mt-1 text-xs text-amber-700 dark:text-amber-500">
                            {t('filters.targets.refusedGroup', { fields: refusedFields.join(', ') })}
                          </p>
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
                <label className="text-sm font-medium text-muted-foreground">{t('filters.targets.loadSaved')}</label>
                <select
                  value={selectedSavedFilterId}
                  onChange={(e) => handleSavedFilterSelect(e.target.value)}
                  className="h-8 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                >
                  <option value="">{t('filters.targets.select')}…</option>
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
