import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { AlertTriangle } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, ActionError } from '@/lib/runAction';
import { usePermissions } from '@/lib/permissions';
import { formatDateTime } from '@/lib/dateTimeFormat';
import type { OrgAuditRetentionPolicy } from '@breeze/shared';

type OrgAuditRetentionSettingsProps = {
  orgId: string;
  onDirty: () => void;
  onSave: () => void;
};

/**
 * Settings surface for `audit_retention_policies` (#4633). Before this
 * existed, the table shipped with the daily prune worker
 * (apps/api/src/jobs/auditRetention.ts) but nothing ever created a row for an
 * org, so retention was a silent no-op on every fresh install — the operator
 * had to insert one by hand in psql.
 */
export default function OrgAuditRetentionSettings({ orgId, onDirty, onSave }: OrgAuditRetentionSettingsProps) {
  const { t } = useTranslation('settings');
  const { can } = usePermissions();
  const canManage = can('audit', 'manage');

  const [policy, setPolicy] = useState<OrgAuditRetentionPolicy | null>(null);
  const [retentionDays, setRetentionDays] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [issue, setIssue] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetchWithAuth(`/orgs/organizations/${orgId}/audit-retention`);
      if (res.status === 401) {
        void navigateTo('/login', { replace: true });
        return;
      }
      if (!res.ok) throw new Error(`audit retention load failed: ${res.status}`);
      const body = (await res.json()) as { data: OrgAuditRetentionPolicy };
      setPolicy(body.data);
      setRetentionDays(String(body.data.retentionDays));
    } catch (err) {
      console.warn('[OrgAuditRetentionSettings] load failed', err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    if (saving) return;
    const parsed = Number(retentionDays);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3650) {
      setIssue(t('orgAuditRetentionSettings.issues.range'));
      return;
    }
    setIssue(null);
    setSaving(true);
    try {
      // Apply the saved policy straight from the PUT response rather than
      // re-fetching: a re-fetch that fails (transient network blip, token
      // about to expire) would otherwise flip the whole panel to the
      // full-page load-error screen right after the "Saved" toast, making a
      // successful save look like it failed.
      const { data } = await runAction<{ data: OrgAuditRetentionPolicy }>({
        request: () => fetchWithAuth(`/orgs/organizations/${orgId}/audit-retention`, {
          method: 'PUT',
          body: JSON.stringify({ retentionDays: parsed })
        }),
        errorFallback: t('orgAuditRetentionSettings.errors.save'),
        successMessage: t('orgAuditRetentionSettings.toasts.saved'),
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      setPolicy(data);
      setRetentionDays(String(data.retentionDays));
      onSave();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    } finally {
      setSaving(false);
    }
  }, [orgId, retentionDays, saving, onSave, t]);

  if (loading) {
    return <p className="text-sm text-muted-foreground">{t('orgAuditRetentionSettings.loading')}</p>;
  }

  if (loadError || !policy) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground" data-testid="org-audit-retention-load-error">
        {t('orgAuditRetentionSettings.errors.load')}{' '}
        <button type="button" onClick={() => void load()} className="underline hover:text-foreground">
          {t('common:actions.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="org-audit-retention-settings">
      <section className="rounded-lg border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">{t('orgAuditRetentionSettings.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('orgAuditRetentionSettings.description')}
        </p>

        {!policy.configured && (
          <div
            className="mt-4 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200"
            data-testid="org-audit-retention-unconfigured"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t('orgAuditRetentionSettings.unconfiguredWarning')}</span>
          </div>
        )}

        <div className="mt-4 max-w-xs">
          <label className="text-sm font-medium" htmlFor="org-audit-retention-days">
            {t('orgAuditRetentionSettings.retentionDays')}
          </label>
          <input
            id="org-audit-retention-days"
            type="number"
            min={1}
            max={3650}
            value={retentionDays}
            disabled={!canManage}
            onChange={(e) => { setRetentionDays(e.target.value); onDirty(); }}
            className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm disabled:opacity-60"
            data-testid="org-audit-retention-days"
          />
          {issue && (
            <p className="mt-1 text-xs text-destructive" data-testid="org-audit-retention-issue">{issue}</p>
          )}
          {!canManage && (
            <p className="mt-1 text-xs text-muted-foreground">{t('orgAuditRetentionSettings.readOnly')}</p>
          )}
        </div>

        {policy.lastCleanupAt && (
          <p className="mt-3 text-xs text-muted-foreground">
            {t('orgAuditRetentionSettings.lastCleanup', { date: formatDateTime(policy.lastCleanupAt) })}
          </p>
        )}
      </section>

      {canManage && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            data-testid="org-audit-retention-save"
          >
            {saving ? t('common:states.saving') : t('orgAuditRetentionSettings.actions.save')}
          </button>
        </div>
      )}
    </div>
  );
}
