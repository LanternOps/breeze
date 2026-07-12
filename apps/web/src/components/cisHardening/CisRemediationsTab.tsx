import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { Loader2 } from 'lucide-react';
import { cn, friendlyFetchError, formatRelativeTime } from '@/lib/utils';
import { fetchWithAuth } from '@/stores/auth';
import HelpTooltip from '../shared/HelpTooltip';

type Remediation = {
  id: string;
  checkId: string;
  deviceId: string;
  baselineId: string | null;
  action: string;
  status: string;
  approvalStatus: string;
  createdAt: string;
  executedAt: string | null;
  deviceHostname: string;
  baselineName: string | null;
};

const statusBadge: Record<string, string> = {
  pending_approval: 'bg-amber-500/20 text-amber-800 border-amber-500/40',
  queued: 'bg-blue-500/20 text-blue-700 border-blue-500/30',
  in_progress: 'bg-sky-500/20 text-sky-700 border-sky-500/30',
  completed: 'bg-emerald-500/20 text-emerald-700 border-emerald-500/30',
  failed: 'bg-red-500/20 text-red-700 border-red-500/40',
  cancelled: 'bg-gray-500/20 text-gray-700 border-gray-500/30',
};

const approvalBadge: Record<string, string> = {
  pending: 'bg-amber-500/20 text-amber-800 border-amber-500/40',
  approved: 'bg-emerald-500/20 text-emerald-700 border-emerald-500/30',
  rejected: 'bg-red-500/20 text-red-700 border-red-500/40',
};

interface CisRemediationsTabProps {
  refreshKey: number;
}

export default function CisRemediationsTab({ refreshKey }: CisRemediationsTabProps) {
  const { t } = useTranslation('security');
  const [remediations, setRemediations] = useState<Remediation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [statusFilter, setStatusFilter] = useState('all');
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async () => {
    setError(undefined);
    setLoading(true);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const params = new URLSearchParams({ limit: '200' });
      if (statusFilter !== 'all') params.set('status', statusFilter);

      const response = await fetchWithAuth(`/cis/remediations?${params.toString()}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

      const payload = await response.json();
      setRemediations(Array.isArray(payload.data) ? payload.data : []);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    fetchData();
    return () => abortRef.current?.abort();
  }, [fetchData, refreshKey]);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">
          {t('cisHardeningCisRemediationsTab.title')}
          <HelpTooltip text={t('cisHardeningCisRemediationsTab.tooltip')} />
        </h3>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        >
          <option value="all">{t('cisHardeningCisRemediationsTab.filters.allStatuses')}</option>
          <option value="pending_approval">{t('cisHardeningCisRemediationsTab.status.pendingApproval')}</option>
          <option value="queued">{t('cisHardeningCisRemediationsTab.status.queued')}</option>
          <option value="in_progress">{t('cisHardeningCisRemediationsTab.status.inProgress')}</option>
          <option value="completed">{t('cisHardeningCisRemediationsTab.status.completed')}</option>
          <option value="failed">{t('cisHardeningCisRemediationsTab.status.failed')}</option>
          <option value="cancelled">{t('cisHardeningCisRemediationsTab.status.cancelled')}</option>
        </select>
      </div>

      <div className="mt-4 overflow-x-auto rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">{t('cisHardeningCisRemediationsTab.table.checkId')}</th>
              <th className="px-4 py-3">{t('cisHardeningCisRemediationsTab.table.device')}</th>
              <th className="px-4 py-3">{t('cisHardeningCisRemediationsTab.table.baseline')}</th>
              <th className="px-4 py-3">{t('cisHardeningCisRemediationsTab.table.action')}</th>
              <th className="px-4 py-3">{t('cisHardeningCisRemediationsTab.table.status')}</th>
              <th className="px-4 py-3">{t('cisHardeningCisRemediationsTab.table.approval')}</th>
              <th className="px-4 py-3">{t('cisHardeningCisRemediationsTab.table.requested')}</th>
              <th className="px-4 py-3">{t('cisHardeningCisRemediationsTab.table.completed')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('cisHardeningCisRemediationsTab.loading')}
                  </span>
                </td>
              </tr>
            ) : remediations.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {t('cisHardeningCisRemediationsTab.empty')}
                </td>
              </tr>
            ) : (
              remediations.map((rem) => (
                <tr key={rem.id} className="text-sm">
                  <td className="px-4 py-3">
                    <code className="font-mono text-xs">{rem.checkId}</code>
                  </td>
                  <td className="px-4 py-3 font-medium">{rem.deviceHostname}</td>
                  <td className="px-4 py-3 text-muted-foreground">{rem.baselineName ?? '-'}</td>
                  <td className="px-4 py-3 capitalize text-muted-foreground">
                    {t(/* i18n-dynamic */ `cisHardeningCisRemediationsTab.actions.${rem.action}`, { defaultValue: rem.action })}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold capitalize',
                        statusBadge[rem.status] ?? statusBadge.cancelled
                      )}
                    >
                      {t(/* i18n-dynamic */ `cisHardeningCisRemediationsTab.status.${rem.status}`, {
                        defaultValue: rem.status.replace(/_/g, ' '),
                      })}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold capitalize',
                        approvalBadge[rem.approvalStatus] ?? approvalBadge.pending
                      )}
                    >
                      {t(/* i18n-dynamic */ `cisHardeningCisRemediationsTab.approval.${rem.approvalStatus}`, {
                        defaultValue: rem.approvalStatus.replace(/_/g, ' '),
                      })}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {formatRelativeTime(new Date(rem.createdAt))}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {rem.executedAt ? formatRelativeTime(new Date(rem.executedAt)) : '-'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
