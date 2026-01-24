import { useMemo, useState, useEffect, useCallback } from 'react';
import { FileCog, ShieldCheck, CalendarClock, BarChart3, Plus, Loader2, RefreshCw } from 'lucide-react';
import PatchList, {
  type Patch,
  type PatchApprovalStatus,
  type PatchSeverity
} from './PatchList';
import PatchApprovalModal, { type PatchApprovalAction } from './PatchApprovalModal';
import PatchComplianceDashboard from './PatchComplianceDashboard';
import PatchPolicyList, { type PatchPolicy, type PatchPolicyStatus } from './PatchPolicyList';
import PatchJobList from './PatchJobList';
import DevicePatchStatus, { type DevicePatch } from './DevicePatchStatus';

const severityMap: Record<string, PatchSeverity> = {
  critical: 'critical',
  high: 'important',
  important: 'important',
  medium: 'moderate',
  moderate: 'moderate',
  low: 'low',
  info: 'low'
};

const approvalMap: Record<string, PatchApprovalStatus> = {
  approved: 'approved',
  approve: 'approved',
  declined: 'declined',
  decline: 'declined',
  rejected: 'declined',
  reject: 'declined',
  deferred: 'deferred',
  defer: 'deferred',
  pending: 'pending'
};

const osLabels: Record<string, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux'
};

const policyStatusMap: Record<string, PatchPolicyStatus> = {
  active: 'active',
  paused: 'paused',
  draft: 'draft',
  disabled: 'paused'
};

function formatSourceLabel(value: unknown): string {
  if (typeof value !== 'string') {
    return value ? String(value) : 'Unknown';
  }

  if (!value.trim()) return 'Unknown';

  return value
    .replace(/_/g, ' ')
    .split(' ')
    .map(part => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ');
}

function normalizeSeverity(value?: string): PatchSeverity {
  if (!value) return 'low';
  const normalized = value.toLowerCase();
  return severityMap[normalized] ?? 'low';
}

function normalizeApprovalStatus(value?: string): PatchApprovalStatus {
  if (!value) return 'pending';
  const normalized = value.toLowerCase();
  return approvalMap[normalized] ?? 'pending';
}

function normalizeOs(value?: string): string {
  if (!value) return 'Unknown';
  const normalized = value.toLowerCase();
  return osLabels[normalized] ?? value;
}

function normalizePatch(raw: Record<string, unknown>, index: number): Patch {
  const id = raw.id ?? raw.patchId ?? raw.patch_id ?? `patch-${index}`;
  const title = raw.title ?? raw.name ?? raw.patchTitle ?? 'Untitled patch';
  const source = raw.sourceName ?? raw.source_label ?? raw.source;
  const os = raw.os ?? raw.osType ?? raw.os_type ?? raw.platform;
  const releaseDate = raw.releaseDate ?? raw.releasedAt ?? raw.release_date ?? raw.createdAt ?? '';
  const approvalStatus = raw.approvalStatus ?? raw.approval_status ?? raw.status;

  return {
    id: String(id),
    title: String(title),
    severity: normalizeSeverity(raw.severity ? String(raw.severity) : undefined),
    source: formatSourceLabel(source),
    os: normalizeOs(os ? String(os) : undefined),
    releaseDate: String(releaseDate),
    approvalStatus: normalizeApprovalStatus(approvalStatus ? String(approvalStatus) : undefined),
    description: raw.description ? String(raw.description) : undefined
  };
}

function normalizePolicyStatus(raw: Record<string, unknown>): PatchPolicyStatus {
  if (typeof raw.status === 'string') {
    const normalized = raw.status.toLowerCase();
    if (policyStatusMap[normalized]) return policyStatusMap[normalized];
  }

  if (typeof raw.enabled === 'boolean') {
    return raw.enabled ? 'active' : 'paused';
  }

  return 'draft';
}

function normalizeTargets(targets: unknown): string[] {
  if (Array.isArray(targets)) {
    return targets.map(value => String(value));
  }

  if (targets && typeof targets === 'object') {
    const entries = Object.values(targets).filter(Array.isArray) as unknown[][];
    if (entries.length > 0) {
      return entries.flat().map(value => String(value));
    }
  }

  return [];
}

function formatSchedule(schedule: unknown): string {
  if (typeof schedule === 'string') return schedule;

  if (schedule && typeof schedule === 'object') {
    const scheduleRecord = schedule as Record<string, unknown>;
    if (typeof scheduleRecord.label === 'string') return scheduleRecord.label;
    if (scheduleRecord.cadence && scheduleRecord.time) {
      const cadence = String(scheduleRecord.cadence);
      const time = String(scheduleRecord.time);
      const timezone = scheduleRecord.timezone ? ` ${scheduleRecord.timezone}` : '';
      return `${cadence} at ${time}${timezone}`;
    }
    if (scheduleRecord.cron) {
      return `Cron: ${scheduleRecord.cron}`;
    }
  }

  return 'Scheduled';
}

function normalizePolicy(raw: Record<string, unknown>, index: number): PatchPolicy {
  const id = raw.id ?? raw.policyId ?? raw.policy_id ?? `policy-${index}`;
  const name = raw.name ?? raw.title ?? 'Untitled policy';

  return {
    id: String(id),
    name: String(name),
    targets: normalizeTargets(raw.targets),
    schedule: formatSchedule(raw.schedule),
    status: normalizePolicyStatus(raw),
    updatedAt: raw.updatedAt ? String(raw.updatedAt) : raw.updated_at ? String(raw.updated_at) : undefined
  };
}

function formatDeviceOs(device: Record<string, unknown>): string {
  const osValue = device.osType ?? device.os ?? device.platform ?? '';
  const label = normalizeOs(osValue ? String(osValue) : undefined);
  const version = device.osVersion ?? device.os_version ?? device.osBuild ?? device.os_build;
  if (version) {
    return `${label} ${version}`;
  }
  return label;
}

type TabKey = 'patches' | 'policies' | 'jobs' | 'compliance';

type DeviceSnapshot = {
  id: string;
  name: string;
  os: string;
};

export default function PatchesPage() {
  const [activeTab, setActiveTab] = useState<TabKey>('patches');
  const [selectedPatch, setSelectedPatch] = useState<Patch | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [patches, setPatches] = useState<Patch[]>([]);
  const [patchesLoading, setPatchesLoading] = useState(true);
  const [patchesError, setPatchesError] = useState<string>();
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState<string>();
  const [policies, setPolicies] = useState<PatchPolicy[]>([]);
  const [policiesLoading, setPoliciesLoading] = useState(true);
  const [policiesError, setPoliciesError] = useState<string>();
  const [deviceSnapshot, setDeviceSnapshot] = useState<DeviceSnapshot | null>(null);
  const [deviceLoading, setDeviceLoading] = useState(true);
  const [deviceError, setDeviceError] = useState<string>();

  const tabs = useMemo(
    () => [
      { id: 'patches' as TabKey, label: 'Patches', icon: <FileCog className="h-4 w-4" /> },
      { id: 'policies' as TabKey, label: 'Policies', icon: <ShieldCheck className="h-4 w-4" /> },
      { id: 'jobs' as TabKey, label: 'Jobs', icon: <CalendarClock className="h-4 w-4" /> },
      { id: 'compliance' as TabKey, label: 'Compliance', icon: <BarChart3 className="h-4 w-4" /> }
    ],
    []
  );

  const fetchPatches = useCallback(async () => {
    try {
      setPatchesLoading(true);
      setPatchesError(undefined);
      const response = await fetch('/api/patches');
      if (!response.ok) {
        throw new Error('Failed to fetch patches');
      }
      const data = await response.json();
      const patchData = data.data ?? data.patches ?? data.items ?? data ?? [];
      const normalized = Array.isArray(patchData)
        ? patchData.map((patch: Record<string, unknown>, index: number) => normalizePatch(patch, index))
        : [];
      setPatches(normalized);
    } catch (err) {
      setPatchesError(err instanceof Error ? err.message : 'Failed to fetch patches');
    } finally {
      setPatchesLoading(false);
    }
  }, []);

  const fetchPolicies = useCallback(async () => {
    try {
      setPoliciesLoading(true);
      setPoliciesError(undefined);
      const response = await fetch('/api/patch-policies');
      if (!response.ok) {
        throw new Error('Failed to fetch patch policies');
      }
      const data = await response.json();
      const policyData = data.data ?? data.policies ?? data.items ?? data ?? [];
      const normalized = Array.isArray(policyData)
        ? policyData.map((policy: Record<string, unknown>, index: number) => normalizePolicy(policy, index))
        : [];
      setPolicies(normalized);
    } catch (err) {
      setPoliciesError(err instanceof Error ? err.message : 'Failed to fetch patch policies');
    } finally {
      setPoliciesLoading(false);
    }
  }, []);

  const fetchDeviceSnapshot = useCallback(async () => {
    try {
      setDeviceLoading(true);
      setDeviceError(undefined);
      const response = await fetch('/api/devices?limit=1');
      if (!response.ok) {
        throw new Error('Failed to fetch device data');
      }
      const data = await response.json();
      const devices = data.devices ?? data.data ?? data.items ?? data ?? [];
      if (Array.isArray(devices) && devices.length > 0) {
        const device = devices[0] as Record<string, unknown>;
        const name = device.displayName ?? device.hostname ?? device.name ?? 'Unknown device';
        setDeviceSnapshot({
          id: String(device.id ?? device.deviceId ?? 'device-0'),
          name: String(name),
          os: formatDeviceOs(device)
        });
      } else {
        setDeviceSnapshot(null);
      }
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : 'Failed to load device status');
    } finally {
      setDeviceLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPatches();
    fetchPolicies();
    fetchDeviceSnapshot();
  }, [fetchPatches, fetchPolicies, fetchDeviceSnapshot]);

  const handleReview = (patch: Patch) => {
    setSelectedPatch(patch);
    setModalOpen(true);
  };

  const handleApprovalSubmit = async (patchId: string, action: PatchApprovalAction, _notes: string) => {
    const nextStatus: PatchApprovalStatus =
      action === 'approve' ? 'approved' : action === 'decline' ? 'declined' : 'deferred';

    setPatches(prev => prev.map(patch => (patch.id === patchId ? { ...patch, approvalStatus: nextStatus } : patch)));
    setModalOpen(false);
    setSelectedPatch(null);
  };

  const getScanDeviceIds = async (): Promise<string[]> => {
    const response = await fetch('/api/devices?limit=100');
    if (!response.ok) {
      throw new Error('Failed to load devices for scan');
    }
    const data = await response.json();
    const devices = data.devices ?? data.data ?? data.items ?? data ?? [];
    if (!Array.isArray(devices) || devices.length === 0) {
      throw new Error('No devices available for scanning');
    }
    const ids = devices
      .map((device: Record<string, unknown>) => device.id ?? device.deviceId)
      .map(id => (id ? String(id) : ''))
      .filter(id => id.length > 0);
    if (ids.length === 0) {
      throw new Error('No devices available for scanning');
    }
    return ids;
  };

  const handleScan = async () => {
    try {
      setScanLoading(true);
      setScanError(undefined);
      const deviceIds = await getScanDeviceIds();
      const response = await fetch('/api/patches/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds })
      });
      if (!response.ok) {
        throw new Error('Failed to start patch scan');
      }
      await fetchPatches();
    } catch (err) {
      setScanError(err instanceof Error ? err.message : 'Failed to start patch scan');
    } finally {
      setScanLoading(false);
    }
  };

  const devicePatchItems: DevicePatch[] = useMemo(
    () =>
      patches.slice(0, 4).map(patch => ({
        id: patch.id,
        title: patch.title,
        severity: patch.severity,
        status: 'available'
      })),
    [patches]
  );
  const installedCount = useMemo(
    () => patches.filter(patch => patch.approvalStatus === 'approved').length,
    [patches]
  );
  const failedCount = useMemo(
    () => patches.filter(patch => patch.approvalStatus === 'declined').length,
    [patches]
  );
  const availableCount = useMemo(
    () => Math.max(patches.length - installedCount - failedCount, 0),
    [patches, installedCount, failedCount]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Patch Management</h1>
          <p className="text-muted-foreground">Track approvals, compliance, and patch deployments.</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleScan}
            disabled={scanLoading}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {scanLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {scanLoading ? 'Scanning...' : 'Run Scan'}
          </button>
          <button
            type="button"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
          >
            <Plus className="h-4 w-4" />
            New Policy
          </button>
        </div>
      </div>

      {scanError && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span>{scanError}</span>
            <button
              type="button"
              onClick={handleScan}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
            >
              Retry scan
            </button>
          </div>
        </div>
      )}

      <div className="border-b">
        <nav className="-mb-px flex gap-4 overflow-x-auto">
          {tabs.map(tab => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition ${
                activeTab === tab.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:border-muted-foreground hover:text-foreground'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === 'patches' && (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <PatchList
              patches={patches}
              loading={patchesLoading}
              error={patchesError}
              onRetry={fetchPatches}
              onReview={handleReview}
            />
          </div>
          <div className="space-y-6">
            {deviceLoading ? (
              <div className="flex items-center justify-center rounded-lg border bg-card p-6 shadow-sm">
                <div className="text-center">
                  <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
                  <p className="mt-3 text-sm text-muted-foreground">Loading device status...</p>
                </div>
              </div>
            ) : deviceError ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
                <p className="text-sm text-destructive">{deviceError}</p>
                <button
                  type="button"
                  onClick={fetchDeviceSnapshot}
                  className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                >
                  Try again
                </button>
              </div>
            ) : deviceSnapshot ? (
              <DevicePatchStatus
                deviceName={deviceSnapshot.name}
                os={deviceSnapshot.os}
                availableCount={availableCount}
                installedCount={installedCount}
                failedCount={failedCount}
                patches={devicePatchItems}
              />
            ) : (
              <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
                No device patch status available.
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'policies' && (
        <div>
          {policiesLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="text-center">
                <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
                <p className="mt-4 text-sm text-muted-foreground">Loading policies...</p>
              </div>
            </div>
          ) : policiesError && policies.length === 0 ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
              <p className="text-sm text-destructive">{policiesError}</p>
              <button
                type="button"
                onClick={fetchPolicies}
                className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                Try again
              </button>
            </div>
          ) : (
            <PatchPolicyList policies={policies} />
          )}
        </div>
      )}

      {activeTab === 'jobs' && <PatchJobList />}

      {activeTab === 'compliance' && <PatchComplianceDashboard />}

      <PatchApprovalModal
        open={modalOpen}
        patch={selectedPatch}
        onClose={() => {
          setModalOpen(false);
          setSelectedPatch(null);
        }}
        onSubmit={handleApprovalSubmit}
      />
    </div>
  );
}
