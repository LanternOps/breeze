import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Loader2, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDateTime as formatUserDateTime } from '@/lib/dateTimeFormat';
import { fetchWithAuth } from '../../stores/auth';
import { friendlyFetchError } from '../../lib/utils';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';

type RiskFactor = {
  code: string;
  severity: 'low' | 'medium' | 'high';
  message: string;
};

type DeviceReadiness = {
  deviceId: string;
  deviceName?: string | null;
  readinessScore: number;
  estimatedRtoMinutes?: number | null;
  estimatedRpoMinutes?: number | null;
  riskFactors: RiskFactor[];
};

type Verification = {
  id: string;
  deviceId: string;
  deviceName?: string | null;
  verificationType: string;
  status: string;
  startedAt: string;
  filesVerified: number;
  filesFailed: number;
  details?: Record<string, unknown> | null;
};

type FleetHealth = {
  verification?: {
    total?: number;
    passedLast24h?: number;
    failedLast24h?: number;
    partialLast24h?: number;
    coveragePercent?: number;
  };
  readiness?: {
    averageScore?: number;
    lowReadinessCount?: number;
    criticalDevicesAtRisk?: number;
  };
  escalations?: {
    verificationFailures?: number;
    criticalVerificationFailures?: number;
  };
};

function readinessColor(score: number): string {
  if (score >= 85) return 'text-success';
  if (score >= 70) return 'text-warning';
  return 'text-destructive';
}

function formatMinutes(minutes?: number | null): string {
  if (minutes == null || !Number.isFinite(minutes)) return '--';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = Math.round(minutes % 60);
  return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
}

function formatTime(iso?: string | null): string {
  return formatUserDateTime(iso, { fallback: '--', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function BackupVerificationOverview() {
  const { t } = useTranslation('backup');
  const [health, setHealth] = useState<FleetHealth | null>(null);
  const [devices, setDevices] = useState<DeviceReadiness[]>([]);
  const [failures, setFailures] = useState<Verification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);

      const [healthRes, readinessRes, verificationsRes] = await Promise.all([
        fetchWithAuth('/backup/health'),
        fetchWithAuth('/backup/recovery-readiness'),
        fetchWithAuth('/backup/verifications?limit=50')
      ]);

      if (!healthRes.ok) throw new Error('Failed to load fleet health data');
      if (!readinessRes.ok) throw new Error('Failed to load readiness data');
      if (!verificationsRes.ok) throw new Error('Failed to load verification history');

      const healthPayload = await healthRes.json();
      const readinessPayload = await readinessRes.json();
      const verificationsPayload = await verificationsRes.json();

      const healthData = healthPayload?.data ?? healthPayload ?? {};
      setHealth(healthData);

      const readinessData: DeviceReadiness[] = Array.isArray(readinessPayload?.data?.devices)
        ? readinessPayload.data.devices
        : Array.isArray(readinessPayload?.data)
          ? readinessPayload.data
          : Array.isArray(readinessPayload)
            ? readinessPayload
            : [];
      setDevices(readinessData);

      const rawVerifications: Verification[] = Array.isArray(verificationsPayload?.data)
        ? verificationsPayload.data
        : Array.isArray(verificationsPayload)
          ? verificationsPayload
          : [];
      setFailures(
        rawVerifications.filter((v) => v.status === 'failed' && v.details?.simulated !== true)
      );
    } catch (err) {
      console.error('[BackupVerificationOverview] fetchData:', err);
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
          <p className="mt-4 text-sm text-muted-foreground">{t('backupVerificationOverview.loadingVerificationOverview')}</p>
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
          onClick={fetchData}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t('backupVerificationOverview.tryAgain')} </button>
      </div>
    );
  }

  const avgReadiness = health?.readiness?.averageScore ?? 0;
  const highReadiness = devices.filter((device) => device.readinessScore >= 85).length;
  const lowReadiness = health?.readiness?.lowReadinessCount ?? 0;
  const recentFailures = health?.escalations?.verificationFailures ?? failures.length;
  const lowDevices = devices.filter((d) => d.readinessScore < 85).sort((a, b) => a.readinessScore - b.readinessScore);

  return (
    <div className="space-y-6">
      {/* Fleet readiness summary */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border bg-card px-5 py-4">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <ShieldCheck className="h-4 w-4" />
            {t('backupVerificationOverview.avgReadiness')} </div>
          <div className="mt-2">
            <span className={cn('text-2xl font-semibold', readinessColor(avgReadiness))}>
              {avgReadiness}
            </span>
            <span className="text-sm text-muted-foreground"> / 100</span>
          </div>
        </div>
        <div className="rounded-lg border bg-card px-5 py-4">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <CheckCircle2 className="h-4 w-4" />
            {t('backupVerificationOverview.highReadiness')} </div>
          <div className="mt-2">
            <span className="text-2xl font-semibold text-success">{highReadiness}</span>
          </div>
        </div>
        <div className="rounded-lg border bg-card px-5 py-4">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <AlertTriangle className="h-4 w-4" />
            {t('backupVerificationOverview.lowReadiness')} </div>
          <div className="mt-2">
            <span className="text-2xl font-semibold text-warning">{lowReadiness}</span>
          </div>
        </div>
        <div className="rounded-lg border bg-card px-5 py-4">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Clock className="h-4 w-4" />
            {t('backupVerificationOverview.recentFailures')} </div>
          <div className="mt-2">
            <span className="text-2xl font-semibold text-destructive">{recentFailures}</span>
          </div>
        </div>
      </div>

      {/* Recent failures table */}
      <div className="rounded-lg border bg-card p-5 shadow-xs">
        <h3 className="text-base font-semibold text-foreground">{t('backupVerificationOverview.recentFailures')}</h3>
        <p className="text-sm text-muted-foreground">{t('backupVerificationOverview.failedVerificationChecksAcrossAllDevices')}</p>
        {failures.length === 0 ? (
          <div className="mt-4 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            {t('backupVerificationOverview.noFailedVerificationsAllChecksPassing')} </div>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs font-medium text-muted-foreground">
                  <th className="pb-2 pr-4">{t('backupVerificationOverview.device')}</th>
                  <th className="pb-2 pr-4">{t('backupVerificationOverview.type')}</th>
                  <th className="pb-2 pr-4">{t('backupVerificationOverview.started')}</th>
                  <th className="pb-2 pr-4">{t('backupVerificationOverview.filesOk')}</th>
                  <th className="pb-2">{t('backupVerificationOverview.filesFailed')}</th>
                </tr>
              </thead>
              <tbody>
                {failures.map((v) => (
                  <tr key={v.id} className="border-b last:border-0">
                    <td className="py-2 pr-4 font-medium text-foreground">
                      {v.deviceName ?? v.deviceId.slice(0, 8)}
                    </td>
                    <td className="py-2 pr-4 capitalize text-muted-foreground">
                      {v.verificationType.replace(/_/g, ' ')}
                    </td>
                    <td className="py-2 pr-4 text-muted-foreground">{formatTime(v.startedAt)}</td>
                    <td className="py-2 pr-4 text-success">{v.filesVerified}</td>
                    <td className="py-2 text-destructive">{v.filesFailed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Low readiness devices table */}
      <div className="rounded-lg border bg-card p-5 shadow-xs">
        <h3 className="text-base font-semibold text-foreground">{t('backupVerificationOverview.lowReadinessDevices')}</h3>
        <p className="text-sm text-muted-foreground">{t('backupVerificationOverview.devicesScoringBelowThe85PointReadinessThreshold')}</p>
        {lowDevices.length === 0 ? (
          <div className="mt-4 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            {t('backupVerificationOverview.allDevicesMeetTheReadinessThreshold')} </div>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs font-medium text-muted-foreground">
                  <th className="pb-2 pr-4">{t('backupVerificationOverview.device')}</th>
                  <th className="pb-2 pr-4">{t('backupVerificationOverview.score')}</th>
                  <th className="pb-2 pr-4">{t('backupVerificationOverview.estRto')}</th>
                  <th className="pb-2 pr-4">{t('backupVerificationOverview.estRpo')}</th>
                  <th className="pb-2">{t('backupVerificationOverview.riskFactors')}</th>
                </tr>
              </thead>
              <tbody>
                {lowDevices.map((d) => (
                  <tr key={d.deviceId} className="border-b last:border-0">
                    <td className="py-2 pr-4 font-medium text-foreground">
                      {d.deviceName ?? d.deviceId.slice(0, 8)}
                    </td>
                    <td className={cn('py-2 pr-4 font-semibold', readinessColor(d.readinessScore))}>
                      {d.readinessScore}
                    </td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {formatMinutes(d.estimatedRtoMinutes)}
                    </td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {formatMinutes(d.estimatedRpoMinutes)}
                    </td>
                    <td className="py-2 text-muted-foreground">{d.riskFactors.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
