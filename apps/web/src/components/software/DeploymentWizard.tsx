import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle, ChevronRight, Loader2, Search, Server, CalendarClock, ClipboardList } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import ProgressBar from '../shared/ProgressBar';
import type { DeploymentTargetConfig } from '@breeze/shared';
import { DeviceTargetSelector } from '../filters/DeviceTargetSelector';

type WizardStep = 'software' | 'targets' | 'configure' | 'review';

type SoftwareVersionOption = {
  id: string;
  version: string;
  isLatest: boolean;
};

type SoftwareOption = {
  id: string;
  name: string;
  vendor: string;
  versions: SoftwareVersionOption[];
  category: string;
};

type TargetNode = {
  id: string;
  name: string;
  type: 'org' | 'site' | 'group' | 'device';
  children?: TargetNode[];
};

const steps: { id: WizardStep; label: string; icon: typeof CheckCircle }[] = [
  { id: 'software', label: 'Select Software', icon: CheckCircle },
  { id: 'targets', label: 'Select Targets', icon: CheckCircle },
  { id: 'configure', label: 'Configure', icon: CheckCircle },
  { id: 'review', label: 'Review', icon: CheckCircle },
];

const scheduleOptions = [
  { id: 'immediate', label: 'Deploy immediately', description: 'Start rollout as soon as approved.' },
  { id: 'scheduled', label: 'Schedule for later', description: 'Pick a specific date and time.' },
  { id: 'maintenance', label: 'Next maintenance window', description: 'Queue for the next maintenance window.' },
];

function collectDeviceIds(node: TargetNode): string[] {
  if (node.type === 'device') return [node.id];
  if (!node.children) return [];
  return node.children.flatMap((child) => collectDeviceIds(child));
}

function normalizeVersion(raw: Record<string, unknown>, index: number): SoftwareVersionOption {
  return {
    id: String(raw.id ?? `version-${index}`),
    version: String(raw.version ?? raw.name ?? ''),
    isLatest: Boolean(raw.isLatest ?? raw.is_latest ?? false),
  };
}

function normalizeSoftware(raw: Record<string, unknown>, versions: SoftwareVersionOption[], index: number): SoftwareOption {
  return {
    id: String(raw.id ?? `sw-${index}`),
    name: String(raw.name ?? raw.softwareName ?? 'Unknown'),
    vendor: String(raw.vendor ?? raw.publisher ?? ''),
    versions,
    category: String(raw.category ?? raw.type ?? 'Software'),
  };
}

function getSelectedTargetSummary(
  targetMode: 'tree' | 'advanced',
  selectedDevices: Set<string>,
  targetConfig: DeploymentTargetConfig,
): { headline: string; detail: string; progressTotal?: number } {
  if (targetMode === 'tree') {
    const count = selectedDevices.size;
    return {
      headline: `${count} device${count === 1 ? '' : 's'}`,
      detail: 'Selected directly from the hierarchy.',
      progressTotal: count,
    };
  }

  if (targetConfig.type === 'all') {
    return {
      headline: 'All devices',
      detail: 'Targets the full organization scope.',
    };
  }

  if (targetConfig.type === 'groups') {
    const count = targetConfig.groupIds?.length ?? 0;
    return {
      headline: `${count} group${count === 1 ? '' : 's'}`,
      detail: 'Device membership is resolved when the deployment is created.',
    };
  }

  if (targetConfig.type === 'filter') {
    return {
      headline: 'Dynamic filter',
      detail: 'Targets devices matching the selected filter.',
    };
  }

  const count = targetConfig.deviceIds?.length ?? 0;
  return {
    headline: `${count} device${count === 1 ? '' : 's'}`,
    detail: 'Selected directly in advanced targeting.',
    progressTotal: count,
  };
}

export default function DeploymentWizard() {
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [deploying, setDeploying] = useState(false);
  const [deploymentComplete, setDeploymentComplete] = useState(false);
  const [deploymentId, setDeploymentId] = useState<string>('');

  const [query, setQuery] = useState('');
  const [softwareOptions, setSoftwareOptions] = useState<SoftwareOption[]>([]);
  const [targetTree, setTargetTree] = useState<TargetNode[]>([]);
  const [selectedSoftwareId, setSelectedSoftwareId] = useState<string>('');
  const [selectedVersionId, setSelectedVersionId] = useState<string>('');
  const [selectedDevices, setSelectedDevices] = useState<Set<string>>(new Set());
  const [scheduleType, setScheduleType] = useState<'immediate' | 'scheduled' | 'maintenance'>('immediate');
  const [scheduledAt, setScheduledAt] = useState('');
  const [targetMode, setTargetMode] = useState<'tree' | 'advanced'>('tree');
  const [targetConfig, setTargetConfig] = useState<DeploymentTargetConfig>({ type: 'devices', deviceIds: [] });

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);

      const [catalogResponse, devicesResponse, sitesResponse, groupsResponse] = await Promise.all([
        fetchWithAuth('/software/catalog'),
        fetchWithAuth('/devices'),
        fetchWithAuth('/orgs/sites'),
        fetchWithAuth('/device-groups'),
      ]);

      let normalizedCatalog: SoftwareOption[] = [];

      if (catalogResponse.ok) {
        const catalogPayload = await catalogResponse.json();
        const rawCatalog = catalogPayload.data ?? catalogPayload.catalog ?? catalogPayload ?? [];
        const catalogRows = Array.isArray(rawCatalog) ? rawCatalog : [];

        const versionResults = await Promise.allSettled(
          catalogRows.map(async (row) => {
            const catalogId = String((row as Record<string, unknown>).id ?? '');
            if (!catalogId) return [] as SoftwareVersionOption[];

            const response = await fetchWithAuth(`/software/catalog/${catalogId}/versions`);
            if (!response.ok) return [] as SoftwareVersionOption[];

            const payload = await response.json();
            const rawVersions = payload.data ?? payload.versions ?? payload ?? [];
            if (!Array.isArray(rawVersions)) return [] as SoftwareVersionOption[];

            return rawVersions
              .map((version: Record<string, unknown>, index: number) => normalizeVersion(version, index))
              .filter((version) => version.version);
          }),
        );

        normalizedCatalog = catalogRows.map((row, index) => normalizeSoftware(
          row as Record<string, unknown>,
          versionResults[index]?.status === 'fulfilled' ? versionResults[index].value : [],
          index,
        ));

        setSoftwareOptions(normalizedCatalog);
      }

      const tree: TargetNode[] = [];
      const sitesMap = new Map<string, TargetNode>();
      const groupsMap = new Map<string, TargetNode>();

      if (sitesResponse.ok) {
        const sitesPayload = await sitesResponse.json();
        const rawSites = sitesPayload.data ?? sitesPayload.sites ?? sitesPayload ?? [];
        if (Array.isArray(rawSites)) {
          for (const site of rawSites) {
            const siteRecord = site as Record<string, unknown>;
            const siteNode: TargetNode = {
              id: String(siteRecord.id),
              name: String(siteRecord.name ?? 'Unknown Site'),
              type: 'site',
              children: [],
            };
            sitesMap.set(String(siteRecord.id), siteNode);
            tree.push(siteNode);
          }
        }
      }

      if (groupsResponse.ok) {
        const groupsPayload = await groupsResponse.json();
        const rawGroups = groupsPayload.data ?? groupsPayload.groups ?? groupsPayload ?? [];
        if (Array.isArray(rawGroups)) {
          for (const group of rawGroups) {
            const groupRecord = group as Record<string, unknown>;
            const groupNode: TargetNode = {
              id: String(groupRecord.id),
              name: String(groupRecord.name ?? 'Unknown Group'),
              type: 'group',
              children: [],
            };
            groupsMap.set(String(groupRecord.id), groupNode);

            const siteId = String(groupRecord.siteId ?? '');
            const parentSite = sitesMap.get(siteId);
            if (parentSite) {
              parentSite.children?.push(groupNode);
            } else {
              tree.push(groupNode);
            }
          }
        }
      }

      let deviceRows: Array<Record<string, unknown>> = [];
      if (devicesResponse.ok) {
        const devicesPayload = await devicesResponse.json();
        const rawDevices = devicesPayload.data ?? devicesPayload.devices ?? devicesPayload ?? [];
        if (Array.isArray(rawDevices)) {
          deviceRows = rawDevices as Array<Record<string, unknown>>;
          for (const deviceRecord of deviceRows) {
            const deviceNode: TargetNode = {
              id: String(deviceRecord.id),
              name: String(deviceRecord.hostname ?? deviceRecord.displayName ?? deviceRecord.name ?? 'Unknown'),
              type: 'device',
            };

            const groupId = String(deviceRecord.groupId ?? deviceRecord.deviceGroupId ?? '');
            const siteId = String(deviceRecord.siteId ?? '');
            const parentGroup = groupsMap.get(groupId);
            const parentSite = sitesMap.get(siteId);

            if (parentGroup) {
              parentGroup.children?.push(deviceNode);
            } else if (parentSite) {
              parentSite.children?.push(deviceNode);
            } else {
              tree.push(deviceNode);
            }
          }
        }
      }

      if (tree.length === 0 && deviceRows.length > 0) {
        tree.push({
          id: 'all-devices',
          name: 'All Devices',
          type: 'org',
          children: deviceRows.map((device) => ({
            id: String(device.id),
            name: String(device.hostname ?? device.displayName ?? device.name ?? 'Unknown'),
            type: 'device' as const,
          })),
        });
      }

      setTargetTree(tree);

      if (normalizedCatalog.length > 0 && !selectedSoftwareId) {
        const firstDeployable = normalizedCatalog.find((item) => item.versions.length > 0);
        if (firstDeployable) {
          setSelectedSoftwareId(firstDeployable.id);
          setSelectedVersionId(firstDeployable.versions.find((version) => version.isLatest)?.id ?? firstDeployable.versions[0]?.id ?? '');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load deployment data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const activeStep = steps[activeStepIndex]?.id ?? 'software';

  const filteredSoftware = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return softwareOptions.filter((item) => {
      if (!normalized) return true;
      return item.name.toLowerCase().includes(normalized) || item.vendor.toLowerCase().includes(normalized);
    });
  }, [query, softwareOptions]);

  const selectedSoftware = useMemo(
    () => softwareOptions.find((item) => item.id === selectedSoftwareId),
    [selectedSoftwareId, softwareOptions],
  );

  const selectedVersion = useMemo(
    () => selectedSoftware?.versions.find((item) => item.id === selectedVersionId) ?? null,
    [selectedSoftware, selectedVersionId],
  );

  useEffect(() => {
    if (!selectedSoftware) return;

    if (selectedSoftware.versions.length === 0) {
      if (selectedVersionId) setSelectedVersionId('');
      return;
    }

    const hasSelectedVersion = selectedSoftware.versions.some((item) => item.id === selectedVersionId);
    if (!hasSelectedVersion) {
      setSelectedVersionId(selectedSoftware.versions.find((item) => item.isLatest)?.id ?? selectedSoftware.versions[0]?.id ?? '');
    }
  }, [selectedSoftware, selectedVersionId]);

  const targetSummary = useMemo(
    () => getSelectedTargetSummary(targetMode, selectedDevices, targetConfig),
    [targetMode, selectedDevices, targetConfig],
  );

  const handleTargetConfigChange = useCallback((config: DeploymentTargetConfig) => {
    setTargetConfig(config);
    if (config.type === 'devices' && config.deviceIds) {
      setSelectedDevices(new Set(config.deviceIds));
    }
  }, []);

  const canProceed = useMemo(() => {
    if (activeStep === 'software') return Boolean(selectedSoftwareId && selectedVersionId);
    if (activeStep === 'targets') {
      if (targetMode === 'advanced') {
        if (targetConfig.type === 'all') return true;
        if (targetConfig.type === 'devices') return (targetConfig.deviceIds?.length ?? 0) > 0;
        if (targetConfig.type === 'groups') return (targetConfig.groupIds?.length ?? 0) > 0;
        if (targetConfig.type === 'filter') return Boolean(targetConfig.filter);
        return false;
      }
      return selectedDevices.size > 0;
    }
    if (activeStep === 'configure') return scheduleType !== 'scheduled' || Boolean(scheduledAt);
    return true;
  }, [activeStep, scheduleType, scheduledAt, selectedDevices.size, selectedSoftwareId, selectedVersionId, targetConfig, targetMode]);

  const toggleDevices = (deviceIds: string[], select: boolean) => {
    setSelectedDevices((prev) => {
      const next = new Set(prev);
      deviceIds.forEach((id) => {
        if (select) {
          next.add(id);
        } else {
          next.delete(id);
        }
      });
      return next;
    });
  };

  const handleDeploy = async () => {
    try {
      if (!selectedVersionId) {
        throw new Error('Select a software version before deploying');
      }

      setDeploying(true);
      setError(undefined);

      const payload =
        targetMode === 'advanced'
          ? {
              name: `${selectedSoftware?.name ?? 'Software'} ${selectedVersion?.version ?? ''}`.trim(),
              softwareVersionId: selectedVersionId,
              deploymentType: 'install',
              targetType: targetConfig.type,
              targetIds: targetConfig.type === 'devices'
                ? targetConfig.deviceIds
                : targetConfig.type === 'groups'
                  ? targetConfig.groupIds
                  : undefined,
              targetFilter: targetConfig.type === 'filter' ? targetConfig.filter : undefined,
              scheduleType,
              scheduledAt: scheduleType === 'scheduled' ? new Date(scheduledAt).toISOString() : undefined,
            }
          : {
              name: `${selectedSoftware?.name ?? 'Software'} ${selectedVersion?.version ?? ''}`.trim(),
              softwareVersionId: selectedVersionId,
              deploymentType: 'install',
              targetType: 'devices' as const,
              targetIds: Array.from(selectedDevices),
              scheduleType,
              scheduledAt: scheduleType === 'scheduled' ? new Date(scheduledAt).toISOString() : undefined,
            };

      const response = await fetchWithAuth('/software/deployments', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error ?? errorData.message ?? 'Deployment failed');
      }

      const result = await response.json();
      setDeploymentId(result.data?.id ?? result.id ?? 'deployment-created');
      setDeploymentComplete(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deployment failed');
    } finally {
      setDeploying(false);
    }
  };

  const resetWizard = () => {
    const firstDeployable = softwareOptions.find((item) => item.versions.length > 0);
    setDeploymentComplete(false);
    setActiveStepIndex(0);
    setSelectedSoftwareId(firstDeployable?.id ?? '');
    setSelectedVersionId(firstDeployable?.versions.find((version) => version.isLatest)?.id ?? firstDeployable?.versions[0]?.id ?? '');
    setSelectedDevices(new Set());
    setScheduleType('immediate');
    setScheduledAt('');
    setTargetMode('tree');
    setTargetConfig({ type: 'devices', deviceIds: [] });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
          <p className="mt-4 text-sm text-muted-foreground">Loading deployment options...</p>
        </div>
      </div>
    );
  }

  if (error && softwareOptions.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchData}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  if (deploymentComplete) {
    return (
      <div className="rounded-lg border bg-card p-6 text-center shadow-sm space-y-4">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/20">
          <CheckCircle className="h-8 w-8 text-emerald-500" />
        </div>
        <h2 className="text-xl font-semibold">Deployment Created</h2>
        <p className="text-sm text-muted-foreground">
          Your deployment has been queued successfully.
        </p>
        {deploymentId && (
          <p className="text-xs text-muted-foreground">Deployment ID: {deploymentId}</p>
        )}
        <div className="pt-4">
          <button
            type="button"
            onClick={resetWizard}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Start New Deployment
          </button>
        </div>
      </div>
    );
  }

  const renderStepContent = () => {
    if (activeStep === 'software') {
      return (
        <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
          <div className="space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                placeholder="Search software..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="space-y-3">
              {filteredSoftware.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No software packages available.
                </p>
              ) : (
                filteredSoftware.map((item) => {
                  const isDeployable = item.versions.length > 0;
                  const defaultVersion = item.versions.find((version) => version.isLatest) ?? item.versions[0];

                  return (
                    <button
                      key={item.id}
                      type="button"
                      disabled={!isDeployable}
                      onClick={() => {
                        if (!isDeployable) return;
                        setSelectedSoftwareId(item.id);
                        setSelectedVersionId(defaultVersion?.id ?? '');
                      }}
                      className={cn(
                        'flex w-full items-center justify-between rounded-lg border px-4 py-3 text-left transition',
                        isDeployable ? 'hover:border-primary/50' : 'cursor-not-allowed opacity-60',
                        selectedSoftwareId === item.id ? 'border-primary bg-primary/5' : 'bg-card',
                      )}
                    >
                      <div>
                        <p className="text-sm font-semibold">{item.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {item.vendor} · {item.category}
                        </p>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {isDeployable ? defaultVersion?.version : 'No versions'}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div className="rounded-lg border bg-card p-5 shadow-sm">
            <div className="flex items-center gap-2">
              <Server className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold">Selected software</h3>
            </div>
            {selectedSoftware ? (
              <div className="mt-4 space-y-4">
                <div>
                  <p className="text-base font-semibold">{selectedSoftware.name}</p>
                  <p className="text-xs text-muted-foreground">{selectedSoftware.vendor}</p>
                </div>
                {selectedSoftware.versions.length > 0 ? (
                  <>
                    <div>
                      <label className="text-xs font-semibold uppercase text-muted-foreground">Version</label>
                      <select
                        value={selectedVersionId}
                        onChange={(event) => setSelectedVersionId(event.target.value)}
                        className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      >
                        {selectedSoftware.versions.map((version) => (
                          <option key={version.id} value={version.id}>
                            {version.version}{version.isLatest ? ' (latest)' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                      Latest build is pre-selected. You can change to an older release for rollback testing.
                    </div>
                  </>
                ) : (
                  <div className="rounded-md border border-amber-400/40 bg-amber-500/10 p-3 text-xs text-amber-700">
                    This package cannot be deployed until at least one version is added.
                  </div>
                )}
              </div>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">Select a software package to continue.</p>
            )}
          </div>
        </div>
      );
    }

    if (activeStep === 'targets') {
      const targetModeToggle = (
        <div className="mb-4 flex items-center gap-2">
          <span className="text-sm font-medium text-muted-foreground">Target by:</span>
          <div className="flex rounded-md border">
            <button
              type="button"
              onClick={() => setTargetMode('tree')}
              className={cn(
                'rounded-l-md px-3 py-1.5 text-xs font-medium transition',
                targetMode === 'tree' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
              )}
            >
              Hierarchy
            </button>
            <button
              type="button"
              onClick={() => setTargetMode('advanced')}
              className={cn(
                'rounded-r-md px-3 py-1.5 text-xs font-medium transition',
                targetMode === 'advanced' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
              )}
            >
              Advanced
            </button>
          </div>
        </div>
      );

      if (targetMode === 'advanced') {
        return (
          <div>
            {targetModeToggle}
            <DeviceTargetSelector
              value={targetConfig}
              onChange={handleTargetConfigChange}
              modes={['all', 'manual', 'groups', 'filter']}
              showPreview={true}
              showSavedFilters={true}
            />
          </div>
        );
      }

      const TreeItem = ({ node, level }: { node: TargetNode; level: number }) => {
        const checkboxRef = useRef<HTMLInputElement | null>(null);
        const deviceIds = collectDeviceIds(node);
        const allSelected = deviceIds.length > 0 && deviceIds.every((id) => selectedDevices.has(id));
        const someSelected = deviceIds.some((id) => selectedDevices.has(id));

        useEffect(() => {
          if (checkboxRef.current) {
            checkboxRef.current.indeterminate = !allSelected && someSelected;
          }
        }, [allSelected, someSelected]);

        return (
          <div className={cn('space-y-2', level > 0 && 'ml-6')}>
            <label className="flex items-center gap-2 text-sm">
              <input
                ref={checkboxRef}
                type="checkbox"
                checked={node.type === 'device' ? selectedDevices.has(node.id) : allSelected}
                onChange={() => {
                  if (node.type === 'device') {
                    toggleDevices([node.id], !selectedDevices.has(node.id));
                  } else {
                    toggleDevices(deviceIds, !allSelected);
                  }
                }}
                className="h-4 w-4 rounded border"
              />
              <span className="font-medium">{node.name}</span>
              <span className="text-xs text-muted-foreground">{node.type}</span>
            </label>
            {node.children?.map((child) => (
              <TreeItem key={child.id} node={child} level={level + 1} />
            ))}
          </div>
        );
      };

      return (
        <div>
          {targetModeToggle}
          <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
            <div className="rounded-lg border bg-card p-5 shadow-sm">
              <h3 className="text-sm font-semibold">Organization targets</h3>
              <p className="text-xs text-muted-foreground">Select groups or devices for deployment.</p>
              <div className="mt-4 space-y-4">
                {targetTree.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No targets available.
                  </p>
                ) : (
                  targetTree.map((node) => (
                    <TreeItem key={node.id} node={node} level={0} />
                  ))
                )}
              </div>
            </div>
            <div className="space-y-4">
              <div className="rounded-lg border bg-card p-5 shadow-sm">
                <h3 className="text-sm font-semibold">Selected targets</h3>
                <p className="mt-2 text-2xl font-semibold">{targetSummary.headline}</p>
                <p className="text-xs text-muted-foreground">{targetSummary.detail}</p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-4 text-xs text-muted-foreground">
                Tip: Selecting a group automatically includes all devices within it.
              </div>
            </div>
          </div>
        </div>
      );
    }

    if (activeStep === 'configure') {
      return (
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Deployment schedule</h3>
          </div>
          <div className="mt-4 space-y-4">
            {scheduleOptions.map((option) => (
              <label key={option.id} className="flex items-start gap-3 rounded-md border p-4 text-sm">
                <input
                  type="radio"
                  name="schedule"
                  value={option.id}
                  checked={scheduleType === option.id}
                  onChange={() => setScheduleType(option.id as typeof scheduleType)}
                  className="mt-1 h-4 w-4"
                />
                <div>
                  <p className="font-medium">{option.label}</p>
                  <p className="text-xs text-muted-foreground">{option.description}</p>
                </div>
              </label>
            ))}
          </div>
          {scheduleType === 'scheduled' && (
            <div className="mt-4">
              <label className="text-xs font-semibold uppercase text-muted-foreground">Scheduled date/time</label>
              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={(event) => setScheduledAt(event.target.value)}
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          )}
          {scheduleType === 'maintenance' && (
            <div className="mt-4 rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
              Devices will be queued for the next available maintenance window.
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Review deployment</h3>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="rounded-md border bg-muted/30 p-4">
              <p className="text-xs uppercase text-muted-foreground">Software</p>
              <p className="mt-2 text-sm font-semibold">{selectedSoftware?.name ?? '—'}</p>
              <p className="text-xs text-muted-foreground">Version {selectedVersion?.version ?? '—'}</p>
            </div>
            <div className="rounded-md border bg-muted/30 p-4">
              <p className="text-xs uppercase text-muted-foreground">Targets</p>
              <p className="mt-2 text-sm font-semibold">{targetSummary.headline}</p>
              <p className="text-xs text-muted-foreground">{targetSummary.detail}</p>
            </div>
            <div className="rounded-md border bg-muted/30 p-4">
              <p className="text-xs uppercase text-muted-foreground">Schedule</p>
              <p className="mt-2 text-sm font-semibold">
                {scheduleType === 'immediate' && 'Immediate'}
                {scheduleType === 'scheduled' && 'Scheduled'}
                {scheduleType === 'maintenance' && 'Maintenance window'}
              </p>
              <p className="text-xs text-muted-foreground">
                {scheduleType === 'scheduled' && scheduledAt ? scheduledAt : ''}
                {scheduleType === 'maintenance' ? 'Next available maintenance window' : ''}
                {scheduleType === 'immediate' ? 'Starts after approval.' : ''}
              </p>
            </div>
            <div className="rounded-md border bg-muted/30 p-4">
              <p className="text-xs uppercase text-muted-foreground">Change window</p>
              <p className="mt-2 text-sm font-semibold">Standard</p>
              <p className="text-xs text-muted-foreground">Notifications enabled</p>
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="space-y-4">
          {deploying && (
            <ProgressBar
              current={0}
              total={targetSummary.progressTotal ?? 1}
              label="Creating deployment..."
              showCount={false}
            />
          )}
          <button
            type="button"
            onClick={handleDeploy}
            disabled={deploying}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-6 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {deploying ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Creating Deployment...
              </>
            ) : (
              'Create Deployment'
            )}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Deployment Wizard</h1>
        <p className="text-sm text-muted-foreground">Guide a deployment through selection, targeting, and review.</p>
      </div>

      {error && activeStep !== 'review' && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {steps.map((step, index) => {
            const isActive = index === activeStepIndex;
            const isCompleted = index < activeStepIndex;

            return (
              <div key={step.id} className="flex items-center gap-3">
                <div
                  className={cn(
                    'flex h-9 w-9 items-center justify-center rounded-full border text-sm font-semibold',
                    isCompleted && 'border-emerald-500 bg-emerald-500 text-white',
                    isActive && !isCompleted && 'border-primary text-primary',
                    !isActive && !isCompleted && 'text-muted-foreground',
                  )}
                >
                  {isCompleted ? <CheckCircle className="h-4 w-4" /> : index + 1}
                </div>
                <div>
                  <p className={cn('text-sm font-medium', isActive ? 'text-foreground' : 'text-muted-foreground')}>
                    {step.label}
                  </p>
                </div>
                {index < steps.length - 1 && <ChevronRight className="h-4 w-4 text-muted-foreground" />}
              </div>
            );
          })}
        </div>
      </div>

      <div>{renderStepContent()}</div>

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setActiveStepIndex((prev) => Math.max(prev - 1, 0))}
          disabled={activeStepIndex === 0}
          className="inline-flex h-10 items-center justify-center rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          Back
        </button>
        {activeStepIndex < steps.length - 1 && (
          <button
            type="button"
            onClick={() => setActiveStepIndex((prev) => Math.min(prev + 1, steps.length - 1))}
            disabled={!canProceed}
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Next
          </button>
        )}
      </div>
    </div>
  );
}
