import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import {
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  ChevronRight,
  AlertTriangle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { extractApiError } from '@/lib/apiError';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import type { Baseline } from './BaselineFormModal';

type ApplyApproval = {
  id: string;
  orgId: string;
  baselineId: string;
  baselineName?: string;
  requestedBy: string;
  approvedBy: string | null;
  status: string;
  requestPayload: {
    baselineId?: string;
    deviceIds?: string[];
    eligibleDeviceIds?: string[];
  };
  expiresAt: string;
  approvedAt: string | null;
  consumedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type Device = {
  id: string;
  hostname: string;
  osType: string;
  status: string;
};

type Props = {
  baseline?: Baseline;
  mode?: 'approvals-only';
};

const statusConfig: Record<string, { labelKey: string; color: string; icon: typeof Clock }> = {
  pending: { labelKey: 'pending', color: 'bg-yellow-500/15 text-yellow-700 border-yellow-500/30', icon: Clock },
  approved: { labelKey: 'approved', color: 'bg-green-500/15 text-green-700 border-green-500/30', icon: CheckCircle2 },
  rejected: { labelKey: 'rejected', color: 'bg-red-500/15 text-red-700 border-red-500/30', icon: XCircle },
  expired: { labelKey: 'expired', color: 'bg-gray-500/15 text-gray-600 border-gray-500/30', icon: Clock },
  consumed: { labelKey: 'consumed', color: 'bg-blue-500/15 text-blue-700 border-blue-500/30', icon: CheckCircle2 },
};

export default function BaselineApplyTab({ baseline, mode }: Props) {
  const { t } = useTranslation('security');
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const [step, setStep] = useState<'select' | 'preview' | 'requested' | 'execute'>(
    mode === 'approvals-only' ? 'requested' : 'select'
  );
  const [approvals, setApprovals] = useState<ApplyApproval[]>([]);
  const [approvalsLoading, setApprovalsLoading] = useState(true);
  const [devices, setDevices] = useState<Device[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<Set<string>>(new Set());
  const [dryRunResult, setDryRunResult] = useState<{
    skipped: Array<{ deviceId: string; hostname: string; reason: string }>;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [decisionSubmitting, setDecisionSubmitting] = useState<string | null>(null);

  const fetchApprovals = useCallback(async () => {
    try {
      setApprovalsLoading(true);
      const params = new URLSearchParams();
      if (currentOrgId) params.set('orgId', currentOrgId);
      if (baseline) params.set('baselineId', baseline.id);
      const response = await fetchWithAuth(`/audit-baselines/apply-requests?${params.toString()}`);
      if (!response.ok) {
        const errBody = await response.json().catch(() => null);
        throw new Error(extractApiError(errBody, t('auditBaselinesBaselineApplyTab.messages.fetchApprovalsFailed')));
      }
      const data = await response.json();
      setApprovals(Array.isArray(data.data) ? data.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auditBaselinesBaselineApplyTab.messages.genericError'));
    } finally {
      setApprovalsLoading(false);
    }
  }, [currentOrgId, baseline]);

  const fetchDevices = useCallback(async () => {
    if (!baseline) return;
    try {
      setDevicesLoading(true);
      const params = new URLSearchParams();
      if (currentOrgId) params.set('orgId', currentOrgId);
      const response = await fetchWithAuth(`/devices?${params.toString()}`);
      if (!response.ok) {
        const errBody = await response.json().catch(() => null);
        throw new Error(extractApiError(errBody, t('auditBaselinesBaselineApplyTab.messages.fetchDevicesFailed')));
      }
      const data = await response.json();
      const allDevices: Device[] = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];
      // Filter to matching OS type
      setDevices(allDevices.filter((d) => d.osType === baseline.osType));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auditBaselinesBaselineApplyTab.messages.genericError'));
    } finally {
      setDevicesLoading(false);
    }
  }, [currentOrgId, baseline]);

  useEffect(() => {
    fetchApprovals();
  }, [fetchApprovals]);

  useEffect(() => {
    if (step === 'select' && baseline) {
      fetchDevices();
    }
  }, [step, baseline, fetchDevices]);

  const handleToggleDevice = (deviceId: string) => {
    setSelectedDeviceIds((prev) => {
      const next = new Set(prev);
      if (next.has(deviceId)) {
        next.delete(deviceId);
      } else {
        next.add(deviceId);
      }
      return next;
    });
  };

  const handleToggleAll = () => {
    if (selectedDeviceIds.size === devices.length) {
      setSelectedDeviceIds(new Set());
    } else {
      setSelectedDeviceIds(new Set(devices.map((d) => d.id)));
    }
  };

  const handleDryRun = async () => {
    if (!baseline || selectedDeviceIds.size === 0) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const body: Record<string, unknown> = {
        baselineId: baseline.id,
        deviceIds: Array.from(selectedDeviceIds),
        dryRun: true,
      };
      if (currentOrgId) body.orgId = currentOrgId;

      const response = await fetchWithAuth('/audit-baselines/apply', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(extractApiError(data, t('auditBaselinesBaselineApplyTab.messages.dryRunFailed')));
      }
      const data = await response.json();
      setDryRunResult({ skipped: data.skipped ?? [] });
      setStep('preview');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auditBaselinesBaselineApplyTab.messages.genericError'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRequestApproval = async () => {
    if (!baseline || selectedDeviceIds.size === 0) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const body: Record<string, unknown> = {
        baselineId: baseline.id,
        deviceIds: Array.from(selectedDeviceIds),
      };
      if (currentOrgId) body.orgId = currentOrgId;

      const response = await fetchWithAuth('/audit-baselines/apply-requests', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(extractApiError(data, t('auditBaselinesBaselineApplyTab.messages.createApprovalFailed')));
      }
      setStep('requested');
      fetchApprovals();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auditBaselinesBaselineApplyTab.messages.genericError'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDecision = async (approvalId: string, decision: 'approved' | 'rejected') => {
    setDecisionSubmitting(approvalId);
    setError(undefined);
    try {
      const body: Record<string, unknown> = { decision };
      if (currentOrgId) body.orgId = currentOrgId;

      const response = await fetchWithAuth(`/audit-baselines/apply-requests/${approvalId}/decision`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(extractApiError(data, t('auditBaselinesBaselineApplyTab.messages.processDecisionFailed')));
      }
      fetchApprovals();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auditBaselinesBaselineApplyTab.messages.genericError'));
    } finally {
      setDecisionSubmitting(null);
    }
  };

  const handleExecuteApply = async (approval: ApplyApproval) => {
    if (!baseline && !approval.baselineId) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const deviceIds = approval.requestPayload?.deviceIds ?? [];
      const body: Record<string, unknown> = {
        baselineId: approval.baselineId,
        deviceIds,
        approvalRequestId: approval.id,
      };
      if (currentOrgId) body.orgId = currentOrgId;

      const response = await fetchWithAuth('/audit-baselines/apply', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(extractApiError(data, t('auditBaselinesBaselineApplyTab.messages.applyFailed')));
      }
      fetchApprovals();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auditBaselinesBaselineApplyTab.messages.genericError'));
    } finally {
      setSubmitting(false);
    }
  };

  // Approvals-only mode (main page "Approvals" tab)
  if (mode === 'approvals-only') {
    return (
      <div className="space-y-4">
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {renderApprovalsList()}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Step indicator */}
      <div className="flex items-center gap-2 text-sm">
        {(['select', 'preview', 'requested'] as const).map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            {i > 0 && <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            <button
              type="button"
              onClick={() => {
                if (s === 'select') {
                  setStep('select');
                  setDryRunResult(null);
                }
              }}
              className={cn(
                'rounded-full px-3 py-1 font-medium transition',
                step === s
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {t(/* i18n-dynamic */ `auditBaselinesBaselineApplyTab.steps.${s}`)}
            </button>
          </div>
        ))}
      </div>

      {/* Step: Select Devices */}
      {step === 'select' && (
        <div className="space-y-4">
          {devicesLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : devices.length === 0 ? (
            <div className="rounded-lg border bg-card p-6 text-center shadow-xs">
              <p className="text-sm text-muted-foreground">
                {t('auditBaselinesBaselineApplyTab.noDevices', { osType: baseline?.osType })}
              </p>
            </div>
          ) : (
            <>
              <div className="rounded-lg border bg-card shadow-xs">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40">
                    <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedDeviceIds.size === devices.length && devices.length > 0}
                          onChange={handleToggleAll}
                          className="h-4 w-4 rounded border"
                        />
                      </th>
                      <th className="px-4 py-3">{t('auditBaselinesBaselineApplyTab.table.hostname')}</th>
                      <th className="px-4 py-3">{t('auditBaselinesBaselineApplyTab.table.os')}</th>
                      <th className="px-4 py-3">{t('auditBaselinesBaselineApplyTab.table.status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {devices.map((device) => (
                      <tr key={device.id} className="border-b last:border-0 hover:bg-muted/20">
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            checked={selectedDeviceIds.has(device.id)}
                            onChange={() => handleToggleDevice(device.id)}
                            className="h-4 w-4 rounded border"
                          />
                        </td>
                        <td className="px-4 py-3 font-medium">{device.hostname}</td>
                        <td className="px-4 py-3 text-muted-foreground">{device.osType}</td>
                        <td className="px-4 py-3">
                          <span
                            className={cn(
                              'inline-flex rounded-full border px-2 py-0.5 text-xs font-medium',
                              device.status === 'online'
                                ? 'bg-green-500/15 text-green-700 border-green-500/30'
                                : 'bg-gray-500/15 text-gray-600 border-gray-500/30'
                            )}
                          >
                            {device.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  {t('auditBaselinesBaselineApplyTab.selectedDevices', {
                    selected: selectedDeviceIds.size,
                    total: devices.length,
                  })}
                </p>
                <button
                  type="button"
                  onClick={handleDryRun}
                  disabled={selectedDeviceIds.size === 0 || submitting}
                  className={cn(
                    'inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90',
                    'disabled:cursor-not-allowed disabled:opacity-60'
                  )}
                >
                  {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t('auditBaselinesBaselineApplyTab.actions.previewChanges')}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Step: Preview */}
      {step === 'preview' && dryRunResult && (
        <div className="space-y-4">
          <div className="rounded-lg border bg-card p-6 shadow-xs">
            <h3 className="text-sm font-semibold">{t('auditBaselinesBaselineApplyTab.dryRun.title')}</h3>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div className="rounded-md border bg-muted/20 p-3">
                <p className="text-xs text-muted-foreground">{t('auditBaselinesBaselineApplyTab.dryRun.eligibleDevices')}</p>
                <p className="text-lg font-semibold">{selectedDeviceIds.size - dryRunResult.skipped.length}</p>
              </div>
              <div className="rounded-md border bg-muted/20 p-3">
                <p className="text-xs text-muted-foreground">{t('auditBaselinesBaselineApplyTab.dryRun.skipped')}</p>
                <p className="text-lg font-semibold">{dryRunResult.skipped.length}</p>
              </div>
            </div>

            {dryRunResult.skipped.length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-medium text-muted-foreground">{t('auditBaselinesBaselineApplyTab.dryRun.skippedDevices')}</p>
                <div className="mt-2 space-y-1">
                  {dryRunResult.skipped.map((s) => (
                    <div key={s.deviceId} className="flex items-center gap-2 rounded-md border bg-yellow-500/5 px-3 py-2 text-xs">
                      <AlertTriangle className="h-3.5 w-3.5 text-yellow-600" />
                      <span className="font-medium">{s.hostname}</span>
                      <span className="text-muted-foreground">{s.reason}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-4 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm">
              <p className="font-medium text-yellow-700">{t('auditBaselinesBaselineApplyTab.approvalRequired.title')}</p>
              <p className="mt-1 text-xs text-yellow-600">
                {t('auditBaselinesBaselineApplyTab.approvalRequired.description')}
              </p>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => {
                setStep('select');
                setDryRunResult(null);
              }}
              className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
            >
              {t('auditBaselinesBaselineApplyTab.actions.back')}
            </button>
            <button
              type="button"
              onClick={handleRequestApproval}
              disabled={submitting}
              className={cn(
                'inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90',
                'disabled:cursor-not-allowed disabled:opacity-60'
              )}
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('auditBaselinesBaselineApplyTab.actions.requestApproval')}
            </button>
          </div>
        </div>
      )}

      {/* Step: Approval Requests */}
      {step === 'requested' && renderApprovalsList()}
    </div>
  );

  function renderApprovalsList() {
    if (approvalsLoading) {
      return (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      );
    }

    if (approvals.length === 0) {
      return (
        <div className="rounded-lg border bg-card p-8 text-center shadow-xs">
          <h3 className="text-sm font-semibold">{t('auditBaselinesBaselineApplyTab.emptyApprovals.title')}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {baseline
              ? t('auditBaselinesBaselineApplyTab.emptyApprovals.withBaselineDescription')
              : t('auditBaselinesBaselineApplyTab.emptyApprovals.description')}
          </p>
        </div>
      );
    }

    return (
      <div className="rounded-lg border bg-card shadow-xs">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {mode === 'approvals-only' && (
                <th className="px-4 py-3">{t('auditBaselinesBaselineApplyTab.approvalsTable.baseline')}</th>
              )}
              <th className="px-4 py-3">{t('auditBaselinesBaselineApplyTab.approvalsTable.status')}</th>
              <th className="px-4 py-3 text-right">{t('auditBaselinesBaselineApplyTab.approvalsTable.devices')}</th>
              <th className="px-4 py-3">{t('auditBaselinesBaselineApplyTab.approvalsTable.created')}</th>
              <th className="px-4 py-3">{t('auditBaselinesBaselineApplyTab.approvalsTable.expires')}</th>
              <th className="px-4 py-3 text-right">{t('auditBaselinesBaselineApplyTab.approvalsTable.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {approvals.map((approval) => {
              const sc = statusConfig[approval.status] ?? statusConfig.pending;
              const StatusIcon = sc.icon;
              const deviceCount = approval.requestPayload?.deviceIds?.length ?? 0;
              const isExpired = new Date(approval.expiresAt) <= new Date();

              return (
                <tr key={approval.id} className="border-b last:border-0 hover:bg-muted/20">
                  {mode === 'approvals-only' && (
                    <td className="px-4 py-3">
                      <a
                        href={`/audit-baselines/${approval.baselineId}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {approval.baselineName ?? approval.baselineId.slice(0, 8)}
                      </a>
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
                        sc.color
                      )}
                    >
                      <StatusIcon className="h-3 w-3" />
                      {t(/* i18n-dynamic */ `auditBaselinesBaselineApplyTab.status.${sc.labelKey}`)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">{deviceCount}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatDateTime(approval.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {isExpired && approval.status === 'pending' ? (
                      <span className="text-red-600">{t('auditBaselinesBaselineApplyTab.status.expired')}</span>
                    ) : (
                      formatDateTime(approval.expiresAt)
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      {approval.status === 'pending' && !isExpired && (
                        <>
                          <button
                            type="button"
                            onClick={() => handleDecision(approval.id, 'approved')}
                            disabled={decisionSubmitting === approval.id}
                            className="inline-flex items-center gap-1 rounded-md bg-green-500/15 px-2.5 py-1 text-xs font-medium text-green-700 transition hover:bg-green-500/25 disabled:opacity-60"
                          >
                            {decisionSubmitting === approval.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <CheckCircle2 className="h-3 w-3" />
                            )}
                            {t('auditBaselinesBaselineApplyTab.actions.approve')}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDecision(approval.id, 'rejected')}
                            disabled={decisionSubmitting === approval.id}
                            className="inline-flex items-center gap-1 rounded-md bg-red-500/15 px-2.5 py-1 text-xs font-medium text-red-700 transition hover:bg-red-500/25 disabled:opacity-60"
                          >
                            <XCircle className="h-3 w-3" />
                            {t('auditBaselinesBaselineApplyTab.actions.reject')}
                          </button>
                        </>
                      )}
                      {approval.status === 'approved' && !approval.consumedAt && (
                        <button
                          type="button"
                          onClick={() => handleExecuteApply(approval)}
                          disabled={submitting}
                          className={cn(
                            'inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition hover:opacity-90',
                            'disabled:cursor-not-allowed disabled:opacity-60'
                          )}
                        >
                          {submitting ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <ChevronRight className="h-3 w-3" />
                          )}
                          {t('auditBaselinesBaselineApplyTab.actions.execute')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }
}
