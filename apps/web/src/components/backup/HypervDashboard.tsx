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
  name: string;
  state: string;
  generation?: number | null;
  memoryMb?: number | null;
  cpuCount?: number | null;
  vhdCount?: number | null;
  rctEnabled?: boolean;
  hasPassthroughDisk?: boolean;
  checkpoints?: HypervCheckpoint[];
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [expandedVmId, setExpandedVmId] = useState<string | null>(null);
  const [discoveringDeviceId, setDiscoveringDeviceId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState<VmState | 'all'>('all');
  const [hostFilter, setHostFilter] = useState('all');

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/backup/hyperv/vms');
      if (!response.ok) {
        throw new Error('Failed to fetch Hyper-V VMs');
      }
      const payload = await response.json();
      setVms(Array.isArray(payload?.data) ? payload.data : []);
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
      const response = await fetchWithAuth(`/backup/hyperv/discover/${deviceId}`, {
        method: 'POST',
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? 'Discovery failed');
      }
      await fetchData();
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

  const filteredVms = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return vms.filter((vm) => {
      const matchesQuery = normalizedQuery
        ? vm.name.toLowerCase().includes(normalizedQuery) ||
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
          Run discovery on a Hyper-V host to detect virtual machines.
        </p>
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
            Manage VMs, checkpoints, and backup operations.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hostDeviceIds.length > 0 && (
            <button
              type="button"
              onClick={() => handleDiscover(hostDeviceIds[0])}
              disabled={discoveringDeviceId !== null}
              className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              {discoveringDeviceId ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Search className="h-3.5 w-3.5" />
              )}
              Discover VMs
            </button>
          )}
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
                {id.slice(0, 8)}...
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
            {vm.name}
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
        <td className="px-4 py-3 text-muted-foreground">{vm.cpuCount ?? '--'}</td>
        <td className="px-4 py-3 text-muted-foreground">{vm.vhdCount ?? '--'}</td>
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
          {vm.hasPassthroughDisk ? (
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
                vmName={vm.name}
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
