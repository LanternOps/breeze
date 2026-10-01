import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { navigateTo } from '@/lib/navigation';
import { ActionError, handleActionError, runAction } from '@/lib/runAction';
import { Switch } from '../pam/ui';
import '../../lib/i18n';
import { useStableT } from '@/lib/i18n/useStableT';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

type BuiltInRule = {
  id: string;
  name: string;
  orgId: string | null;
  isActive: boolean;
  systemManaged?: boolean;
};

/**
 * Built-in system alert rules (#7626): patch job failures, reboot pending too
 * long, policy violations. Breeze raises these itself, so they are never
 * converted to monitors (#7206) — and this on/off switch, per organization, is
 * the one control an operator has over them. Hidden until the first such rule
 * exists (they are created the first time their alert fires).
 */
export default function BuiltInAlertRules({ orgId }: { orgId?: string | null }) {
  const { t } = useTranslation(['monitoring', 'common']);
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  const organizations = useOrgStore((s) => s.organizations) ?? [];
  const [rows, setRows] = useState<BuiltInRule[]>([]);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState<string | null>(null);

  const fetchRules = useCallback(async () => {
    try {
      setError(undefined);
      const query = `/alerts/rules?limit=200&systemManaged=true${orgId ? `&orgId=${encodeURIComponent(orgId)}` : ''}`;
      const response = await fetchWithAuth(query);
      if (!response.ok) throw new Error(stableT('monitoring:builtInRules.errors.fetch'));
      const data = await response.json();
      const all: BuiltInRule[] = Array.isArray(data?.data) ? data.data : [];
      setRows(all.filter((rule) => rule.systemManaged === true));
    } catch (err) {
      setError(err instanceof Error ? err.message : stableT('monitoring:builtInRules.errors.fetch'));
    }
  }, [orgId, stableT]);

  useEffect(() => {
    void fetchRules();
  }, [fetchRules]);

  const handleToggle = async (rule: BuiltInRule) => {
    const next = !rule.isActive;
    setSaving(rule.id);
    try {
      const updated = await runAction<Partial<BuiltInRule>>({
        request: () =>
          fetchWithAuth(`/alerts/rules/${rule.id}/active`, {
            method: 'PATCH',
            body: JSON.stringify({ isActive: next }),
          }),
        errorFallback: t('monitoring:builtInRules.errors.toggle'),
        successMessage: next
          ? t('monitoring:builtInRules.switchedOn', { name: rule.name })
          : t('monitoring:builtInRules.switchedOff', { name: rule.name }),
        onUnauthorized: UNAUTHORIZED,
      });
      const isActive = typeof updated?.isActive === 'boolean' ? updated.isActive : next;
      setRows((prev) => prev.map((row) => (row.id === rule.id ? { ...row, isActive } : row)));
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      handleActionError(err, t('monitoring:builtInRules.errors.toggle'));
    } finally {
      setSaving(null);
    }
  };

  if (!error && rows.length === 0) return null;

  const orgName = (id: string | null) => organizations.find((org) => org.id === id)?.name ?? '—';

  return (
    <div className="space-y-2" data-testid="builtin-alert-rules">
      <div>
        <h2 className="text-sm font-semibold">{t('monitoring:builtInRules.title')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('monitoring:builtInRules.description')}</p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-md border bg-card shadow-xs">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs font-medium uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-3">{t('monitoring:builtInRules.columns.name')}</th>
                <th className="px-4 py-3">{t('monitoring:builtInRules.columns.organization')}</th>
                <th className="px-4 py-3">{t('monitoring:builtInRules.columns.active')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((rule) => (
                <tr key={rule.id} data-testid={`builtin-alert-rules-row-${rule.id}`}>
                  <td className="px-4 py-3">{rule.name}</td>
                  <td className="px-4 py-3">{orgName(rule.orgId)}</td>
                  <td className="px-4 py-3">
                    <Switch
                      checked={rule.isActive}
                      onToggle={() => void handleToggle(rule)}
                      disabled={saving === rule.id}
                      testId={`builtin-alert-rules-active-${rule.id}`}
                      ariaLabel={t('monitoring:builtInRules.toggle', { name: rule.name })}
                    />
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
