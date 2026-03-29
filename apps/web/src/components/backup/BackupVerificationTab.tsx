import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileCheck,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { friendlyFetchError } from '../../lib/utils';

type VerificationType = 'integrity' | 'test_restore' | 'full_recovery';
type VerificationStatus = 'pending' | 'running' | 'passed' | 'failed' | 'partial';

type Verification = {
  id: string;
  deviceId: string;
  verificationType: VerificationType;
  status: VerificationStatus;
  startedAt: string;
  completedAt?: string | null;
  restoreTimeSeconds?: number | null;
  filesVerified: number;
  filesFailed: number;
  sizeBytes?: number | null;
  details?: Record<string, unknown> | null;
};

type RiskFactor = {
  code: string;
  severity: 'low' | 'medium' | 'high';
  message: string;
};

type Readiness = {
  deviceId: string;
  readinessScore: number;
  estimatedRtoMinutes?: number | null;
  estimatedRpoMinutes?: number | null;
  riskFactors: RiskFactor[];
};

const statusConfig: Record<VerificationStatus, { icon: typeof CheckCircle2; color: string; label: string }> = {
  pending: { icon: Clock, color: 'text-yellow-500', label: 'Pending' },
  running: { icon: Loader2, color: 'text-blue-500', label: 'Running' },
  passed: { icon: CheckCircle2, color: 'text-green-500', label: 'Passed' },
  failed: { icon: XCircle, color: 'text-red-500', label: 'Failed' },
  partial: { icon: AlertTriangle, color: 'text-yellow-500', label: 'Partial' },
};

const severityColors: Record<string, string> = {
  low: 'bg-yellow-100 text-yellow-800 border-yellow-300',
  medium: 'bg-orange-100 text-orange-800 border-orange-300',
  high: 'bg-red-100 text-red-800 border-red-300',
};

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '-';
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readinessColor(score: number): string {
  if (score >= 85) return 'text-green-500';
  if (score >= 70) return 'text-yellow-500';
  return 'text-red-500';
}

export default function BackupVerificationTab({ deviceId }: { deviceId: string }) {
  const [verifications, setVerifications] = useState<Verification[]>([]);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [triggering, setTriggering] = useState<VerificationType | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [vRes, rRes] = await Promise.all([
        fetchWithAuth(`/backup/verifications?deviceId=${deviceId}&limit=50`),
        fetchWithAuth(`/backup/recovery-readiness?deviceId=${deviceId}`),
      ]);

      if (vRes.ok) {
        const vPayload = await vRes.json();
        setVerifications(Array.isArray(vPayload.data) ? vPayload.data : []);
      }

      if (rRes.ok) {
        const rPayload = await rRes.json();
        const devices = rPayload.data?.devices ?? rPayload.data ?? [];
        const match = Array.isArray(devices)
          ? devices.find((d: Readiness) => d.deviceId === deviceId)
          : null;
        setReadiness(match ?? null);
      }

      // Surface error if either failed
      if (!vRes.ok || !rRes.ok) {
        const failedStatus = !vRes.ok ? vRes.status : rRes.status;
        setError(`Failed to load data (${failedStatus})`);
      } else {
        setError(undefined);
      }
    } catch (err) {
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Poll while any verification is pending/running
  useEffect(() => {
    const hasPending = verifications.some(
      (v) => v.status === 'pending' || v.status === 'running'
    );
    if (hasPending && !pollRef.current) {
      pollRef.current = setInterval(fetchData, 3000);
    } else if (!hasPending && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [verifications, fetchData]);

  const triggerVerification = async (type: VerificationType) => {
    setTriggering(type);
    setError(undefined);
    try {
      const body: Record<string, unknown> = { deviceId, verificationType: type };
      if (type === 'full_recovery') body.highImpactApproved = true;

      const res = await fetchWithAuth('/backup/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error((errData as { error?: string }).error || `${res.status} ${res.statusText}`);
      }

      await fetchData();
    } catch (err) {
      setError(friendlyFetchError(err));
    } finally {
      setTriggering(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading verification data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Recovery Readiness Card */}
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <h3 className="text-lg font-semibold">Recovery Readiness</h3>
        </div>
        {readiness ? (
          <div className="grid gap-4 sm:grid-cols-4">
            <div className="text-center">
              <p className={`text-3xl font-bold ${readinessColor(readiness.readinessScore)}`}>
                {readiness.readinessScore}
              </p>
              <p className="text-xs text-muted-foreground">Score (0-100)</p>
            </div>
            <div className="text-center">
              <p className="text-xl font-semibold">{readiness.estimatedRtoMinutes ?? '-'}</p>
              <p className="text-xs text-muted-foreground">Est. RTO (min)</p>
            </div>
            <div className="text-center">
              <p className="text-xl font-semibold">{readiness.estimatedRpoMinutes ?? '-'}</p>
              <p className="text-xs text-muted-foreground">Est. RPO (min)</p>
            </div>
            <div>
              {readiness.riskFactors.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {readiness.riskFactors.map((rf) => (
                    <span
                      key={rf.code}
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${severityColors[rf.severity] || ''}`}
                      title={rf.message}
                    >
                      {rf.code.replace(/_/g, ' ')}
                    </span>
                  ))}
                </div>
              ) : (
                <span className="text-xs text-green-600">No risk factors</span>
              )}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No readiness data. Run a verification to generate.
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-lg font-semibold">Verification Actions</h3>
            <p className="text-sm text-muted-foreground">
              Run checks to validate backup integrity and recoverability.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => triggerVerification('integrity')}
              disabled={triggering !== null}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
            >
              {triggering === 'integrity' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileCheck className="h-4 w-4" />
              )}
              Integrity Check
            </button>
            <button
              type="button"
              onClick={() => triggerVerification('test_restore')}
              disabled={triggering !== null}
              className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-60"
            >
              {triggering === 'test_restore' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              Test Restore
            </button>
            <button
              type="button"
              onClick={fetchData}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-60"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* Verification History */}
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <FileCheck className="h-4 w-4 text-primary" />
          <h3 className="font-semibold">Verification History</h3>
        </div>
        {verifications.length === 0 ? (
          <p className="text-sm text-muted-foreground">No verifications yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-4">Type</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2 pr-4">Started</th>
                  <th className="pb-2 pr-4">Duration</th>
                  <th className="pb-2 pr-4">Files OK</th>
                  <th className="pb-2 pr-4">Files Failed</th>
                  <th className="pb-2">Size</th>
                </tr>
              </thead>
              <tbody>
                {verifications.map((v) => {
                  const cfg = statusConfig[v.status] || statusConfig.failed;
                  const Icon = cfg.icon;
                  const duration = v.completedAt
                    ? Math.round(
                        (new Date(v.completedAt).getTime() - new Date(v.startedAt).getTime()) / 1000
                      )
                    : null;
                  return (
                    <tr key={v.id} className="border-b last:border-0">
                      <td className="py-2 pr-4 capitalize">
                        {v.verificationType.replace(/_/g, ' ')}
                      </td>
                      <td className="py-2 pr-4">
                        <span className={`inline-flex items-center gap-1 ${cfg.color}`}>
                          <Icon
                            className={`h-3.5 w-3.5 ${v.status === 'running' ? 'animate-spin' : ''}`}
                          />
                          {cfg.label}
                        </span>
                        {v.details && Boolean((v.details as Record<string, unknown>).simulated) && (
                          <span className="ml-1 inline-flex items-center rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 border border-gray-300">
                            simulated
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {new Date(v.startedAt).toLocaleString()}
                      </td>
                      <td className="py-2 pr-4">
                        {formatDuration(v.restoreTimeSeconds ?? duration)}
                      </td>
                      <td className="py-2 pr-4 text-green-600">{v.filesVerified}</td>
                      <td className="py-2 pr-4 text-red-600">{v.filesFailed}</td>
                      <td className="py-2">{formatBytes(v.sizeBytes)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
