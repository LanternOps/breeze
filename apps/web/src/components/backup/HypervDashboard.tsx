import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Database,
  Filter,
  HardDrive,
  Loader2,
  Monitor,
  Play,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { formatTime } from './backupDashboardHelpers';
import HypervVMActions from './HypervVMActions';
import AlphaBadge from '../shared/AlphaBadge';

// ── Types ──────────────────────────────────────────────────────────

type VmState = 'Running' | 'Off' | 'Saved' | 'Paused' | 'Starting' | 'Stopping' | 'Unknown';

type HypervCheckpoint = {
  id: string;
  name: string;
  createdAt: string;
  parentId?: string | null;
  children?: HypervCheckpoint[];
};

type HypervVm = {
  id: string;
  deviceId: string;
  vmId?: string | null;
  vmName?: string | null;
  name?: string | null;
  state: string;
  generation?: number | null;
  memoryMb?: number | null;
  processorCount?: number | null;
  cpuCount?: number | null;
  vhdPaths?: string[] | null;
  vhdCount?: number | null;
  rctEnabled?: boolean;
  hasPassthroughDisks?: boolean;
  hasPassthroughDisk?: boolean;
  checkpoints?: HypervCheckpoint[];
};

type DeviceSummary = {
  id: string;
  hostname?: string | null;
  displayName?: string | null;
  osType?: string | null;
};

const vmStateConfig: Record<VmState, { label: string; className: string }> = {
  Running: { label: 'Running', className: 'text-success bg-success/10' },
  Off: { label: 'Off', className: 'text-muted-foreground bg-muted' },
  Saved: { label: 'Saved', className: 'text-warning bg-warning/10' },
  Paused: { label: 'Paused', className: 'text-warning bg-warning/10' },
  Starting: { label: 'Starting', className: 'text-primary bg-primary/10' },
  Stopping: { label: 'Stopping', className: 'text-destructive bg-destructive/10' },
  Unknown: { label: 'Unknown', className: 'text-muted-foreground bg-muted' },
};

function normalizeVmState(state?: string): VmState {
  if (!state) return 'Unknown';
  const s = state.charAt(0).toUpperCase() + state.slice(1).toLowerCase();
  if (s in vmStateConfig) return s as VmState;
  return 'Unknown';
}

// ── Component ─────────────────────────────────────────────────────

export default function HypervDashboard() {
  const [vms, setVms] = useState<HypervVm[]>([]);
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [expandedVmId, setExpandedVmId] = useState<string | null>(null);
  const [discoveringDeviceId, setDiscoveringDeviceId] = useState<string | null>(null);
  const [discoverTargetDeviceId, setDiscoverTargetDeviceId] = useState('');
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState<VmState | 'all'>('all');
  const [hostFilter, setHostFilter] = useState('all');

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const [vmResponse, deviceResponse] = await Promise.all([
        fetchWithAuth('/backup/hyperv/vms'),
        fetchWithAuth('/devices?limit=200'),
      ]);

      if (!vmResponse.ok) {
        throw new Error('Failed to fetch Hyper-V VMs');
      }

      const vmPayload = await vmResponse.json();
      const vmData = Array.isArray(vmPayload?.data)
        ? vmPayload.data
        : Array.isArray(vmPayload?.vms)
          ? vmPayload.vms
          : [];
      setVms(vmData);

      if (deviceResponse.ok) {
        const devicePayload = await deviceResponse.json();
        const rawDevices = devicePayload?.data ?? devicePayload ?? [];
        const allDevices = Array.isArray(rawDevices) ? rawDevices as DeviceSummary[] : [];
        const windowsDevices = allDevices.filter((device) => `${device.osType ?? ''}`.toLowerCase().includes('windows'));
        setDevices(windowsDevices);
        setDiscoverTargetDeviceId((current) => current || windowsDevices[0]?.id || '');
      } else {
        console.warn('[HypervDashboard] Failed to load device list:', deviceResponse.status);
        setError('Loaded VMs but could not load device list for discovery.');
      }
    } catch (err) {
      console.error('[HypervDashboard] fetchData:', err);
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleDiscover = useCallback(async (deviceId: string) => {
    try {
      setDiscoveringDeviceId(deviceId);
      setError(undefined);
      setMessage(undefined);
      const response = await fetchWithAuth(`/backup/hyperv/discover/${deviceId}`, {
        method: 'POST',
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? 'Discovery failed');
      }
      await fetchData();
      setMessage('Hyper-V discovery completed.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Discovery failed');
    } finally {
      setDiscoveringDeviceId(null);
    }
  }, [fetchData]);

  const hostDeviceIds = useMemo(() => {
    const unique = new Set(vms.map((vm) => vm.deviceId));
    return Array.from(unique);
  }, [vms]);

  const deviceNameById = useMemo(() => {
    return new Map(
      devices.map((device) => [device.id, device.displayName ?? device.hostname ?? device.id] as const)
    );
  }, [devices]);

  const filteredVms = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return vms.filter((vm) => {
      const displayName = (vm.vmName ?? vm.name ?? '').toLowerCase();
      const matchesQuery = normalizedQuery
        ? displayName.includes(normalizedQuery) ||
          vm.deviceId.toLowerCase().includes(normalizedQuery)
        : true;
      const matchesState =
        stateFilter === 'all' ? true : normalizeVmState(vm.state) === stateFilter;
      const matchesHost = hostFilter === 'all' ? true : vm.deviceId === hostFilter;
      return matchesQuery && matchesState && matchesHost;
    });
  }, [vms, query, stateFilter, hostFilter]);

  const toggleExpand = (id: string) => {
    setExpandedVmId((prev) => (prev === id ? null : id));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading Hyper-V VMs...</p>
        </div>
      </div>
    );
  }

  if (error && vms.length === 0) {
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

  // Empty state
  if (!error && vms.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <Monitor className="h-12 w-12 text-muted-foreground/40" />
        <h3 className="mt-4 text-base font-semibold text-foreground">No Hyper-V VMs found</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Select a Windows host and run discovery to detect virtual machines.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <select
            className="min-w-64 rounded-md border bg-background px-3 py-2 text-sm"
            value={discoverTargetDeviceId}
            onChange={(event) => setDiscoverTargetDeviceId(event.target.value)}
          >
            <option value="">Select a Windows host</option>
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.displayName ?? device.hostname ?? device.id}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void handleDiscover(discoverTargetDeviceId)}
            disabled={!discoverTargetDeviceId || discoveringDeviceId === discoverTargetDeviceId}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {discoveringDeviceId === discoverTargetDeviceId ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Search className="h-4 w-4" />
            )}
            Run discovery
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <AlphaBadge variant="banner" disclaimer="Hyper-V VM backup and restore is in early access. VM export, import, and checkpoint management are functional but may not cover all VM configurations." />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-foreground">Hyper-V Backup</h2>
          <p className="text-sm text-muted-foreground">
            Manage VMs, checkpoints, restore-as-VM, and instant boot operations.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            aria-label="Discover Hyper-V host"
            className="h-9 min-w-56 rounded-md border bg-background px-3 text-xs"
            value={discoverTargetDeviceId}
            onChange={(event) => setDiscoverTargetDeviceId(event.target.value)}
          >
            <option value="">Select host</option>
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.displayName ?? device.hostname ?? device.id}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void handleDiscover(discoverTargetDeviceId)}
            disabled={!discoverTargetDeviceId || discoveringDeviceId !== null}
            className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            {discoveringDeviceId ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Search className="h-3.5 w-3.5" />
            )}
            Discover VMs
          </button>
          <button
            type="button"
            onClick={fetchData}
            className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {message && (
        <div className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
          {message}
        </div>
      )}

      {/* Filters */}
      <div className="grid gap-3 rounded-lg border bg-card p-4 shadow-sm md:grid-cols-3">
        <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
          <Search className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <label htmlFor="hyperv-search" className="sr-only">Search VMs</label>
          <input
            id="hyperv-search"
            className="w-full bg-transparent text-sm outline-none"
            placeholder="Search VM name..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
          <Filter className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <label htmlFor="hyperv-state-filter" className="sr-only">Filter by state</label>
          <select
            id="hyperv-state-filter"
            className="w-full appearance-none bg-transparent text-sm outline-none"
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value as VmState | 'all')}
          >
            <option value="all">All states</option>
            <option value="Running">Running</option>
            <option value="Off">Off</option>
            <option value="Saved">Saved</option>
            <option value="Paused">Paused</option>
          </select>
        </div>
        <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
          <Server className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <label htmlFor="hyperv-host-filter" className="sr-only">Filter by host</label>
          <select
            id="hyperv-host-filter"
            className="w-full appearance-none bg-transparent text-sm outline-none"
            value={hostFilter}
            onChange={(e) => setHostFilter(e.target.value)}
          >
            <option value="all">All hosts</option>
            {hostDeviceIds.map((id) => (
              <option key={id} value={id}>
                {deviceNameById.get(id) ?? `${id.slice(0, 8)}...`}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* VM Table */}
      <div className="overflow-x-auto rounded-lg border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 w-8" />
              <th className="px-4 py-3">VM Name</th>
              <th className="px-4 py-3">State</th>
              <th className="px-4 py-3">Gen</th>
              <th className="px-4 py-3">Memory</th>
              <th className="px-4 py-3">CPU</th>
              <th className="px-4 py-3">VHDs</th>
              <th className="px-4 py-3">RCT</th>
              <th className="px-4 py-3">Warnings</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filteredVms.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No VMs match your filters.
                </td>
              </tr>
            ) : (
              filteredVms.map((vm) => {
                const vmState = normalizeVmState(vm.state);
                const stateCfg = vmStateConfig[vmState];
                const isExpanded = expandedVmId === vm.id;
                return (
                  <VmRow
                    key={vm.id}
                    vm={vm}
                    vmState={vmState}
                    stateCfg={stateCfg}
                    isExpanded={isExpanded}
                    onToggle={() => toggleExpand(vm.id)}
                    onRefresh={fetchData}
                  />
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── VM Row Sub-component ──────────────────────────────────────────

type VmRowProps = {
  vm: HypervVm;
  vmState: VmState;
  stateCfg: { label: string; className: string };
  isExpanded: boolean;
  onToggle: () => void;
  onRefresh: () => void;
};

function VmRow({ vm, vmState, stateCfg, isExpanded, onToggle, onRefresh }: VmRowProps) {
  const displayName = vm.vmName ?? vm.name ?? 'Unnamed VM';
  const cpuCount = vm.processorCount ?? vm.cpuCount ?? null;
  const vhdCount = Array.isArray(vm.vhdPaths) ? vm.vhdPaths.length : (vm.vhdCount ?? null);
  const hasPassthroughDisk = vm.hasPassthroughDisks ?? vm.hasPassthroughDisk ?? false;

  return (
    <>
      <tr className="text-sm text-foreground">
        <td className="px-4 py-3">
          <button
            type="button"
            onClick={onToggle}
            className="text-muted-foreground hover:text-foreground"
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        </td>
        <td className="px-4 py-3 font-medium">
          <div className="flex items-center gap-2">
            <Monitor className="h-4 w-4 text-muted-foreground" />
            {displayName}
          </div>
        </td>
        <td className="px-4 py-3">
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium',
              stateCfg.className
            )}
          >
            {stateCfg.label}
          </span>
        </td>
        <td className="px-4 py-3 text-muted-foreground">{vm.generation ?? '--'}</td>
        <td className="px-4 py-3 text-muted-foreground">
          {vm.memoryMb != null ? `${vm.memoryMb} MB` : '--'}
        </td>
        <td className="px-4 py-3 text-muted-foreground">{cpuCount ?? '--'}</td>
        <td className="px-4 py-3 text-muted-foreground">{vhdCount ?? '--'}</td>
        <td className="px-4 py-3">
          {vm.rctEnabled ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
              <ShieldCheck className="h-3 w-3" />
              On
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">Off</span>
          )}
        </td>
        <td className="px-4 py-3">
          {hasPassthroughDisk ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
              <AlertTriangle className="h-3 w-3" />
              Pass-through
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">-</span>
          )}
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onToggle}
              className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-primary/10"
            >
              <HardDrive className="h-3.5 w-3.5" />
              Manage
            </button>
          </div>
        </td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={10} className="bg-muted/20 px-8 py-4">
            <div className="space-y-4">
              {/* VM Actions */}
              <HypervVMActions
                vmName={displayName}
                vmId={vm.id}
                deviceId={vm.deviceId}
                currentState={vmState}
                onStateChange={onRefresh}
              />

              {/* Checkpoints */}
              {vm.checkpoints && vm.checkpoints.length > 0 && (
                <div>
                  <h4 className="mb-2 text-sm font-semibold text-foreground">Checkpoints</h4>
                  <CheckpointTree checkpoints={vm.checkpoints} depth={0} />
                </div>
              )}

              {(!vm.checkpoints || vm.checkpoints.length === 0) && (
                <p className="text-xs text-muted-foreground">No checkpoints for this VM.</p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Checkpoint Tree ───────────────────────────────────────────────

type CheckpointTreeProps = {
  checkpoints: HypervCheckpoint[];
  depth: number;
};

function CheckpointTree({ checkpoints, depth }: CheckpointTreeProps) {
  return (
    <div className={cn('space-y-1', depth > 0 && 'ml-6 border-l border-border pl-3')}>
      {checkpoints.map((cp) => (
        <div key={cp.id}>
          <div className="flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-muted/40">
            <Database className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="font-medium text-foreground">{cp.name}</span>
            <span className="text-muted-foreground">{formatTime(cp.createdAt)}</span>
          </div>
          {cp.children && cp.children.length > 0 && (
            <CheckpointTree checkpoints={cp.children} depth={depth + 1} />
          )}
        </div>
      ))}
    </div>
  );
}
