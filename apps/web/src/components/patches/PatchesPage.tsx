import { useMemo, useState, useEffect, useCallback } from 'react';
import { Layers, FileCog, BarChart3, Plus, Loader2, RefreshCw } from 'lucide-react';
import type { FilterConditionGroup } from '@breeze/shared';
import { DeviceFilterBar } from '../filters/DeviceFilterBar';
import PatchList, {
  type Patch,
  type PatchApprovalStatus,
  type PatchSeverity
} from './PatchList';
import PatchApprovalModal, { type PatchApprovalAction } from './PatchApprovalModal';
import PatchComplianceDashboard from './PatchComplianceDashboard';
import UpdateRingList, { type UpdateRingItem } from './UpdateRingList';
import UpdateRingForm, { type UpdateRingFormValues } from './UpdateRingForm';
import RingSelector, { type UpdateRing } from './RingSelector';
import { fetchWithAuth } from '../../stores/auth';

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
  return severityMap[value.toLowerCase()] ?? 'low';
}

function normalizeApprovalStatus(value?: string): PatchApprovalStatus {
  if (!value) return 'pending';
  return approvalMap[value.toLowerCase()] ?? 'pending';
}

function normalizeOs(value?: string): string {
  if (!value) return 'Unknown';
  return osLabels[value.toLowerCase()] ?? value;
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

function normalizeRing(raw: Record<string, unknown>): UpdateRingItem {
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? 'Untitled'),
    description: raw.description ? String(raw.description) : null,
    enabled: raw.enabled !== false,
    ringOrder: Number(raw.ringOrder ?? 0),
    deferralDays: Number(raw.deferralDays ?? 0),
    deadlineDays: raw.deadlineDays != null ? Number(raw.deadlineDays) : null,
    gracePeriodHours: Number(raw.gracePeriodHours ?? 4),
    categoryRules: Array.isArray(raw.categoryRules) ? raw.categoryRules as UpdateRingItem['categoryRules'] : [],
    updatedAt: raw.updatedAt ? String(raw.updatedAt) : undefined,
  };
}

type TabKey = 'rings' | 'patches' | 'compliance';

export default function PatchesPage() {
  const [activeTab, setActiveTab] = useState<TabKey>('rings');
  const [selectedRingId, setSelectedRingId] = useState<string | null>(null);
  const [selectedPatch, setSelectedPatch] = useState<Patch | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [ringModalOpen, setRingModalOpen] = useState(false);
  const [ringSubmitting, setRingSubmitting] = useState(false);
  const [editingRing, setEditingRing] = useState<UpdateRingItem | null>(null);

  // Data
  const [rings, setRings] = useState<UpdateRingItem[]>([]);
  const [ringsLoading, setRingsLoading] = useState(true);
  const [ringsError, setRingsError] = useState<string>();
  const [patches, setPatches] = useState<Patch[]>([]);
  const [patchesLoading, setPatchesLoading] = useState(true);
  const [patchesError, setPatchesError] = useState<string>();
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState<string>();
  const [deviceFilter, setDeviceFilter] = useState<FilterConditionGroup | null>(null);

  const tabs = useMemo(
    () => [
      { id: 'rings' as TabKey, label: 'Update Rings', icon: <Layers className="h-4 w-4" /> },
      { id: 'patches' as TabKey, label: 'Patches', icon: <FileCog className="h-4 w-4" /> },
      { id: 'compliance' as TabKey, label: 'Compliance', icon: <BarChart3 className="h-4 w-4" /> }
    ],
    []
  );

  // Ring selector data (simplified for dropdown)
  const ringSelectorItems: UpdateRing[] = useMemo(
    () =>
      rings.map((r) => ({
        id: r.id,
        name: r.name,
        ringOrder: r.ringOrder,
        deferralDays: r.deferralDays,
        enabled: r.enabled,
      })),
    [rings]
  );

  // ---- Data Fetching ----

  const fetchRings = useCallback(async () => {
    try {
      setRingsLoading(true);
      setRingsError(undefined);
      const response = await fetchWithAuth('/update-rings');
      if (!response.ok) {
        if (response.status === 401) { window.location.href = '/login'; return; }
        throw new Error('Failed to fetch update rings');
      }
      const data = await response.json();
      const ringData = data.data ?? data ?? [];
      const normalized = Array.isArray(ringData)
        ? ringData.map((r: Record<string, unknown>) => normalizeRing(r))
        : [];
      setRings(normalized);
    } catch (err) {
      setRingsError(err instanceof Error ? err.message : 'Failed to fetch update rings');
    } finally {
      setRingsLoading(false);
    }
  }, []);

  const fetchPatches = useCallback(async () => {
    try {
      setPatchesLoading(true);
      setPatchesError(undefined);
      const params = new URLSearchParams();
      if (selectedRingId) params.set('ringId', selectedRingId);
      const url = selectedRingId
        ? `/update-rings/${selectedRingId}/patches`
        : '/patches';
      const response = await fetchWithAuth(url);
      if (!response.ok) {
        if (response.status === 401) { window.location.href = '/login'; return; }
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
  }, [selectedRingId]);

  useEffect(() => {
    fetchRings();
  }, [fetchRings]);

  useEffect(() => {
    fetchPatches();
  }, [fetchPatches]);

  // ---- Handlers ----

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

  const handleScan = async () => {
    try {
      setScanLoading(true);
      setScanError(undefined);
      const devResponse = await fetchWithAuth('/devices?limit=100');
      if (!devResponse.ok) {
        if (devResponse.status === 401) { window.location.href = '/login'; return; }
        throw new Error('Failed to load devices for scan');
      }
      const devData = await devResponse.json();
      const devices = devData.devices ?? devData.data ?? devData.items ?? devData ?? [];
      const ids = (Array.isArray(devices) ? devices : [])
        .map((d: Record<string, unknown>) => d.id ?? d.deviceId)
        .map((id: unknown) => (id ? String(id) : ''))
        .filter((id: string) => id.length > 0);
      if (ids.length === 0) throw new Error('No devices available for scanning');

      const response = await fetchWithAuth('/patches/scan', {
        method: 'POST',
        body: JSON.stringify({ deviceIds: ids })
      });
      if (!response.ok) {
        if (response.status === 401) { window.location.href = '/login'; return; }
        throw new Error('Failed to start patch scan');
      }
      await fetchPatches();
    } catch (err) {
      setScanError(err instanceof Error ? err.message : 'Failed to start patch scan');
    } finally {
      setScanLoading(false);
    }
  };

  const handleRingSubmit = async (values: UpdateRingFormValues) => {
    setRingSubmitting(true);
    const isEditing = !!editingRing;
    try {
      const url = isEditing ? `/update-rings/${editingRing.id}` : '/update-rings';
      const response = await fetchWithAuth(url, {
        method: isEditing ? 'PATCH' : 'POST',
        body: JSON.stringify({
          name: values.name,
          description: values.description,
          ringOrder: values.ringOrder,
          deferralDays: values.deferralDays,
          deadlineDays: values.deadlineDays,
          gracePeriodHours: values.gracePeriodHours,
          categoryRules: values.categoryRules,
        })
      });
      if (!response.ok) {
        if (response.status === 401) { window.location.href = '/login'; return; }
        throw new Error(isEditing ? 'Failed to update ring' : 'Failed to create update ring');
      }
      await fetchRings();
      setRingModalOpen(false);
      setEditingRing(null);
    } catch (err) {
      setRingsError(err instanceof Error ? err.message : (isEditing ? 'Failed to update ring' : 'Failed to create update ring'));
    } finally {
      setRingSubmitting(false);
    }
  };

  const handleRingDelete = async (ring: UpdateRingItem) => {
    try {
      const response = await fetchWithAuth(`/update-rings/${ring.id}`, { method: 'DELETE' });
      if (!response.ok) {
        if (response.status === 401) { window.location.href = '/login'; return; }
        throw new Error('Failed to delete ring');
      }
      await fetchRings();
    } catch (err) {
      setRingsError(err instanceof Error ? err.message : 'Failed to delete ring');
    }
  };

  // ---- Derived ----

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Patch Management</h1>
          <p className="text-muted-foreground">Manage update rings, approvals, compliance, and patch deployments.</p>
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
            onClick={() => {
              setEditingRing(null);
              setRingsError(undefined);
              setRingModalOpen(true);
            }}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            New Ring
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

      {/* Tabs */}
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

      {/* Ring selector — visible on Patches & Compliance tabs */}
      {(activeTab === 'patches' || activeTab === 'compliance') && (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <RingSelector
            rings={ringSelectorItems}
            selectedRingId={selectedRingId}
            onChange={setSelectedRingId}
            loading={ringsLoading}
          />
          <DeviceFilterBar
            value={deviceFilter}
            onChange={setDeviceFilter}
            collapsible
            defaultExpanded={false}
            showPreview
          />
        </div>
      )}

      {/* Update Rings tab */}
      {activeTab === 'rings' && (
        <div>
          {ringsLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="text-center">
                <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
                <p className="mt-4 text-sm text-muted-foreground">Loading update rings...</p>
              </div>
            </div>
          ) : ringsError && rings.length === 0 ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
              <p className="text-sm text-destructive">{ringsError}</p>
              <button
                type="button"
                onClick={fetchRings}
                className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                Try again
              </button>
            </div>
          ) : (
            <UpdateRingList
              rings={rings}
              onEdit={(ring) => {
                setEditingRing(ring);
                setRingsError(undefined);
                setRingModalOpen(true);
              }}
              onDelete={handleRingDelete}
              onSelect={(ring) => {
                setSelectedRingId(ring.id);
                setActiveTab('patches');
              }}
            />
          )}
        </div>
      )}

      {/* Patches tab */}
      {activeTab === 'patches' && (
        <PatchList
          patches={patches}
          loading={patchesLoading}
          error={patchesError}
          onRetry={fetchPatches}
          onReview={handleReview}
        />
      )}

      {/* Compliance tab */}
      {activeTab === 'compliance' && <PatchComplianceDashboard ringId={selectedRingId} />}

      {/* Approval modal — passes ringId */}
      <PatchApprovalModal
        open={modalOpen}
        patch={selectedPatch}
        ringId={selectedRingId}
        onClose={() => {
          setModalOpen(false);
          setSelectedPatch(null);
        }}
        onSubmit={handleApprovalSubmit}
      />

      {/* Create / Edit Ring modal */}
      {ringModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8 overflow-y-auto">
          <div className="w-full max-w-3xl rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">{editingRing ? 'Edit Update Ring' : 'Create Update Ring'}</h2>
              <button
                type="button"
                onClick={() => { setRingModalOpen(false); setEditingRing(null); }}
                className="h-8 w-8 rounded-md hover:bg-muted flex items-center justify-center"
              >
                &times;
              </button>
            </div>
            <UpdateRingForm
              key={editingRing?.id ?? 'new'}
              onSubmit={handleRingSubmit}
              onCancel={() => { setRingModalOpen(false); setEditingRing(null); }}
              submitLabel={ringSubmitting ? (editingRing ? 'Saving...' : 'Creating...') : (editingRing ? 'Save Changes' : 'Create Ring')}
              loading={ringSubmitting}
              defaultValues={editingRing ? {
                name: editingRing.name,
                description: editingRing.description ?? undefined,
                ringOrder: editingRing.ringOrder,
                deferralDays: editingRing.deferralDays,
                deadlineDays: editingRing.deadlineDays,
                gracePeriodHours: editingRing.gracePeriodHours,
                categoryRules: editingRing.categoryRules,
              } : undefined}
            />
          </div>
        </div>
      )}
    </div>
  );
}
