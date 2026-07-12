import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { Monitor, CheckCircle2, AlertTriangle, BarChart3 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';

type BaselineSummary = {
  baselineId: string;
  baselineName: string;
  osType: string;
  total: number;
  compliant: number;
  nonCompliant: number;
  averageScore: number;
};

type ComplianceData = {
  totalDevices: number;
  compliant: number;
  nonCompliant: number;
  averageScore: number;
  baselines: BaselineSummary[];
};

const osLabelKey: Record<string, string> = { windows: 'windows', macos: 'macos', linux: 'linux' };
const osBadge: Record<string, string> = {
  windows: 'bg-blue-500/15 text-blue-700 border-blue-500/30',
  macos: 'bg-purple-500/15 text-purple-700 border-purple-500/30',
  linux: 'bg-orange-500/15 text-orange-700 border-orange-500/30',
};

function scoreColor(score: number): string {
  if (score >= 90) return 'text-green-600';
  if (score >= 70) return 'text-yellow-600';
  return 'text-red-600';
}

function scoreBarColor(score: number): string {
  if (score >= 90) return 'bg-green-500';
  if (score >= 70) return 'bg-yellow-500';
  return 'bg-red-500';
}

export default function ComplianceDashboard() {
  const { t } = useTranslation('security');
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const [data, setData] = useState<ComplianceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const params = new URLSearchParams();
      if (currentOrgId) params.set('orgId', currentOrgId);
      const response = await fetchWithAuth(`/audit-baselines/compliance?${params.toString()}`);
      if (!response.ok) throw new Error(t('auditBaselinesComplianceDashboard.messages.fetchFailed'));
      const json = await response.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auditBaselinesComplianceDashboard.messages.genericError'));
    } finally {
      setLoading(false);
    }
  }, [currentOrgId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">{t('auditBaselinesComplianceDashboard.loading')}</p>
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
          {t('auditBaselinesComplianceDashboard.actions.tryAgain')}
        </button>
      </div>
    );
  }

  if (!data || data.totalDevices === 0) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center shadow-xs">
        <BarChart3 className="mx-auto h-10 w-10 text-muted-foreground" />
        <h3 className="mt-4 text-sm font-semibold">{t('auditBaselinesComplianceDashboard.empty.title')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('auditBaselinesComplianceDashboard.empty.description')}
        </p>
      </div>
    );
  }

  const compliantPct = data.totalDevices > 0
    ? Math.round((data.compliant / data.totalDevices) * 100)
    : 0;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <div className="flex items-center gap-3">
            <div className="rounded-full border bg-muted/30 p-2">
              <Monitor className="h-4 w-4 text-muted-foreground" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t('auditBaselinesComplianceDashboard.cards.devicesEvaluated')}</p>
              <p className="text-xl font-semibold">{data.totalDevices}</p>
            </div>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <div className="flex items-center gap-3">
            <div className="rounded-full border bg-muted/30 p-2">
              <CheckCircle2 className="h-4 w-4 text-green-500" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t('auditBaselinesComplianceDashboard.cards.compliant')}</p>
              <p className="text-xl font-semibold">
                {compliantPct}%
                <span className="ml-1 text-sm font-normal text-muted-foreground">
                  ({data.compliant}/{data.totalDevices})
                </span>
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <div className="flex items-center gap-3">
            <div className="rounded-full border bg-muted/30 p-2">
              <AlertTriangle className="h-4 w-4 text-red-500" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t('auditBaselinesComplianceDashboard.cards.nonCompliant')}</p>
              <p className="text-xl font-semibold">{data.nonCompliant}</p>
            </div>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <div className="flex items-center gap-3">
            <div className="rounded-full border bg-muted/30 p-2">
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t('auditBaselinesComplianceDashboard.cards.averageScore')}</p>
              <p className={cn('text-xl font-semibold', scoreColor(data.averageScore))}>
                {data.averageScore}
              </p>
            </div>
          </div>
        </div>
      </div>

      {data.baselines.length > 0 && (
        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <h3 className="text-sm font-semibold">{t('auditBaselinesComplianceDashboard.byBaseline')}</h3>
          <table className="mt-4 w-full text-sm">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">{t('auditBaselinesComplianceDashboard.table.baseline')}</th>
                <th className="px-4 py-3">{t('auditBaselinesComplianceDashboard.table.os')}</th>
                <th className="px-4 py-3 text-right">{t('auditBaselinesComplianceDashboard.table.devices')}</th>
                <th className="px-4 py-3 text-right">{t('auditBaselinesComplianceDashboard.table.avgScore')}</th>
                <th className="px-4 py-3">{t('auditBaselinesComplianceDashboard.table.status')}</th>
              </tr>
            </thead>
            <tbody>
              {data.baselines.map((bl) => (
                <tr key={bl.baselineId} className="border-b last:border-0 hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <a
                      href={`/audit-baselines/${bl.baselineId}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {bl.baselineName}
                    </a>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium',
                        osBadge[bl.osType] ?? ''
                      )}
                    >
                      {osLabelKey[bl.osType] ? t(/* i18n-dynamic */ `auditBaselinesComplianceDashboard.os.${osLabelKey[bl.osType]}`) : bl.osType}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">{bl.total}</td>
                  <td className="px-4 py-3 text-right">
                    <span className={cn('font-semibold', scoreColor(bl.averageScore))}>
                      {bl.averageScore}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="h-2 w-24 rounded-full bg-muted">
                        <div
                          className={cn('h-2 rounded-full', scoreBarColor(bl.averageScore))}
                          style={{ width: `${bl.averageScore}%` }}
                        />
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {t('auditBaselinesComplianceDashboard.compliantRatio', {
                          compliant: bl.compliant,
                          total: bl.total,
                        })}
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
