import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { ActionError, runAction } from '@/lib/runAction';
import { showToast } from '../shared/Toast';
import { ScopeBadge } from '../shared/ScopeBadge';
import '../../lib/i18n';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

type LegacyRule = {
  id: string;
  name: string;
  templateId: string | null;
  templateName?: string | null;
  targetType: string;
  targetId: string | null;
  orgId: string | null;
  partnerId: string | null;
  isActive: boolean;
  managedByMonitorId: string | null;
  convertedToMonitorId: string | null;
};

export default function LegacyRulesTable({ onConverted }: { onConverted?: () => void }) {
  const { t } = useTranslation(['monitoring', 'common']);
  const [rows, setRows] = useState<LegacyRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [converting, setConverting] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const fetchRules = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/alerts/rules?limit=200');
      if (!response.ok) throw new Error(t('monitoring:legacy.errors.fetch'));
      const data = await response.json();
      const all: LegacyRule[] = Array.isArray(data?.data) ? data.data : [];
      setRows(all.filter((rule) => rule.managedByMonitorId == null));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('monitoring:legacy.errors.fetch'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchRules();
  }, [fetchRules]);

  const handleConvert = async (rule: LegacyRule) => {
    setConverting(rule.id);
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[rule.id];
      return next;
    });
    try {
      const data = await runAction<{ data?: { monitorId?: string } }>({
        request: () => fetchWithAuth(`/monitor-definitions/convert-from-rule/${rule.id}`, { method: 'POST' }),
        errorFallback: t('monitoring:legacy.errors.convert'),
        successMessage: t('monitoring:legacy.converted'),
        onUnauthorized: UNAUTHORIZED,
        friendly: (code) => code === 'RULE_NOT_CONVERTIBLE' ? t('monitoring:legacy.notConvertible') : undefined,
      });
      onConverted?.();
      const monitorId = data?.data?.monitorId;
      if (monitorId) void navigateTo(`/alerts/monitors/${monitorId}`);
      else void fetchRules();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('monitoring:legacy.errors.convert') });
      setRowErrors((prev) => ({
        ...prev,
        [rule.id]: err instanceof Error ? err.message : t('monitoring:legacy.errors.convert'),
      }));
    } finally {
      setConverting(null);
    }
  };

  return (
    <div className="space-y-6" data-testid="legacy-rules-table">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {!loading && rows.length === 0 && !error && (
        <div className="rounded-md border border-dashed p-6 text-center">
          <p className="text-sm text-muted-foreground">{t('monitoring:legacy.empty')}</p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-md border bg-card shadow-xs">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs font-medium uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-3">{t('monitoring:legacy.columns.name')}</th>
                <th className="px-4 py-3">{t('monitoring:legacy.columns.template')}</th>
                <th className="px-4 py-3">{t('monitoring:legacy.columns.target')}</th>
                <th className="px-4 py-3">{t('monitoring:legacy.columns.owner')}</th>
                <th className="px-4 py-3">{t('monitoring:legacy.columns.active')}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((rule) => (
                <tr key={rule.id} data-testid={`legacy-rules-row-${rule.id}`}>
                  <td className="px-4 py-3">{rule.name}</td>
                  <td className="px-4 py-3">{rule.templateName ?? '—'}</td>
                  <td className="px-4 py-3">{rule.targetType}</td>
                  <td className="px-4 py-3">
                    <ScopeBadge orgId={rule.orgId} partnerId={rule.partnerId} isSystem={false} />
                  </td>
                  <td className="px-4 py-3">{rule.isActive ? '✓' : '—'}</td>
                  <td className="px-4 py-3 text-right">
                    {rule.convertedToMonitorId ? (
                      <span className="inline-flex items-center rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-700">
                        {t('monitoring:legacy.converted')}
                      </span>
                    ) : (
                      <button
                        type="button"
                        data-testid={`legacy-rules-convert-${rule.id}`}
                        disabled={converting === rule.id}
                        onClick={() => void handleConvert(rule)}
                        className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {t('monitoring:legacy.convert')}
                      </button>
                    )}
                    {rowErrors[rule.id] && (
                      <p className="mt-1 text-xs text-destructive">{rowErrors[rule.id]}</p>
                    )}
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
