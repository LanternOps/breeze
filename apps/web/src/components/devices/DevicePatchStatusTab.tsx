import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle, AlertTriangle } from 'lucide-react';

type PatchItem = {
  id?: string;
  name?: string;
  title?: string;
  kb?: string;
  severity?: string;
  status?: string;
  releaseDate?: string;
  releasedAt?: string;
  installedAt?: string;
};

type PatchPayload = {
  compliancePercent?: number;
  compliance?: number;
  pending?: PatchItem[];
  pendingPatches?: PatchItem[];
  available?: PatchItem[];
  installed?: PatchItem[];
  installedPatches?: PatchItem[];
  applied?: PatchItem[];
  patches?: PatchItem[];
};

type DevicePatchStatusTabProps = {
  deviceId: string;
};

const severityStyles: Record<string, string> = {
  critical: 'text-red-600',
  important: 'text-orange-600',
  moderate: 'text-yellow-600',
  low: 'text-blue-600'
};

function formatDate(value?: string) {
  if (!value) return 'Not reported';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function normalizePatchName(patch: PatchItem) {
  return patch.title || patch.name || patch.kb || 'Unnamed patch';
}

export default function DevicePatchStatusTab({ deviceId }: DevicePatchStatusTabProps) {
  const [payload, setPayload] = useState<PatchPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchPatchStatus = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/devices/${deviceId}/patches`);
      if (!response.ok) throw new Error('Failed to fetch patch status');
      const json = await response.json();
      const data = json?.data ?? json;
      setPayload(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch patch status');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchPatchStatus();
  }, [fetchPatchStatus]);

  const { pending, installed, compliancePercent } = useMemo(() => {
    const data = payload ?? {};
    const pendingList = data.pending ?? data.pendingPatches ?? data.available ?? [];
    const installedList = data.installed ?? data.installedPatches ?? data.applied ?? [];
    const patches = data.patches ?? [];

    const inferredPending = pendingList.length > 0
      ? pendingList
      : patches.filter(patch => (patch.status || '').toLowerCase() === 'pending' || (patch.status || '').toLowerCase() === 'available');
    const inferredInstalled = installedList.length > 0
      ? installedList
      : patches.filter(patch => (patch.status || '').toLowerCase() === 'installed');

    const total = inferredPending.length + inferredInstalled.length;
    const compliance = data.compliancePercent ?? data.compliance ?? (total > 0 ? Math.round((inferredInstalled.length / total) * 100) : 100);

    return {
      pending: inferredPending,
      installed: inferredInstalled,
      compliancePercent: compliance
    };
  }, [payload]);

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-sm">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-3 text-sm text-muted-foreground">Loading patch status...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchPatchStatus}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-lg font-semibold">Patch Compliance</h3>
            <p className="text-sm text-muted-foreground">Pending vs installed updates</p>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle className="h-4 w-4 text-green-500" />
            {compliancePercent}% compliant
          </div>
        </div>
        <div className="mt-4">
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${compliancePercent}%` }} />
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>{pending.length} pending</span>
            <span>{installed.length} installed</span>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-yellow-500" />
            <h3 className="font-semibold">Pending Patches</h3>
          </div>
          <div className="mt-4 overflow-hidden rounded-md border">
            <table className="min-w-full divide-y">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">Patch</th>
                  <th className="px-4 py-3">Severity</th>
                  <th className="px-4 py-3">Released</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {pending.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-6 text-center text-sm text-muted-foreground">
                      No pending patches.
                    </td>
                  </tr>
                ) : (
                  pending.map((patch, index) => {
                    const severityKey = (patch.severity || '').toLowerCase();
                    return (
                      <tr key={patch.id ?? `${patch.name ?? patch.title ?? 'pending'}-${index}`} className="text-sm">
                        <td className="px-4 py-3 font-medium">{normalizePatchName(patch)}</td>
                        <td className={`px-4 py-3 text-xs font-medium ${severityStyles[severityKey] || 'text-muted-foreground'}`}>
                          {patch.severity || 'Not reported'}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {formatDate(patch.releaseDate ?? patch.releasedAt)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-green-500" />
            <h3 className="font-semibold">Installed Patches</h3>
          </div>
          <div className="mt-4 overflow-hidden rounded-md border">
            <table className="min-w-full divide-y">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">Patch</th>
                  <th className="px-4 py-3">Severity</th>
                  <th className="px-4 py-3">Installed</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {installed.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-6 text-center text-sm text-muted-foreground">
                      No installed patches reported.
                    </td>
                  </tr>
                ) : (
                  installed.map((patch, index) => {
                    const severityKey = (patch.severity || '').toLowerCase();
                    return (
                      <tr key={patch.id ?? `${patch.name ?? patch.title ?? 'installed'}-${index}`} className="text-sm">
                        <td className="px-4 py-3 font-medium">{normalizePatchName(patch)}</td>
                        <td className={`px-4 py-3 text-xs font-medium ${severityStyles[severityKey] || 'text-muted-foreground'}`}>
                          {patch.severity || 'Not reported'}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(patch.installedAt)}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
