import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Gauge, Plus } from 'lucide-react';

import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { usePermissions } from '@/lib/permissions';
import { ActionError, runAction } from '@/lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { showToast } from '../shared/Toast';

type MeasurementWindow = 'daily' | 'weekly' | 'monthly';

const MEASUREMENT_WINDOWS: readonly MeasurementWindow[] = ['daily', 'weekly', 'monthly'];

const DEFAULT_UPTIME_TARGET = '99.9';

const inputClass =
  'h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring';

type SLAEmptyStateProps = {
  /** Called after a definition was created, so the page can reload the SLA tab. */
  onCreated: () => void;
};

/**
 * Shown on the SLA tab when the listing loaded and holds no definition (#9940).
 * Creates an org-wide definition through `POST /analytics/sla`, the only create
 * path; site/device targeting stays API-only.
 */
export default function SLAEmptyState({ onCreated }: SLAEmptyStateProps) {
  const { t } = useTranslation('reports');
  const { can } = usePermissions();
  // Mirrors the route gate (`requireAnalyticsWrite` = organizations:write).
  // UX only: the API re-checks, and also requires MFA.
  const canCreate = can('organizations', 'write');
  const currentOrgId = useOrgStore(s => s.currentOrgId);
  const organizations = useOrgStore(s => s.organizations);

  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState('');
  const [uptimeTarget, setUptimeTarget] = useState(DEFAULT_UPTIME_TARGET);
  const [measurementWindow, setMeasurementWindow] = useState<MeasurementWindow>('monthly');
  const [excludeWeekends, setExcludeWeekends] = useState(false);
  const [excludeMaintenanceWindows, setExcludeMaintenanceWindows] = useState(false);
  const [pickedOrgId, setPickedOrgId] = useState('');

  const windowLabels: Record<MeasurementWindow, string> = {
    daily: t('analytics.slaEmptyState.form.windows.daily'),
    weekly: t('analytics.slaEmptyState.form.windows.weekly'),
    monthly: t('analytics.slaEmptyState.form.windows.monthly')
  };

  // A partner viewing "All organizations" must say which org owns the
  // definition; the API rejects an org-less create when it can reach several.
  const needsOrgPick = !currentOrgId && organizations.length > 1;
  const orgId = currentOrgId
    ?? (needsOrgPick ? pickedOrgId || undefined : organizations[0]?.id);

  const trimmedName = name.trim();
  const parsedTarget = uptimeTarget.trim() === '' ? undefined : Number(uptimeTarget);
  const targetValid = parsedTarget === undefined
    || (Number.isFinite(parsedTarget) && parsedTarget >= 0 && parsedTarget <= 100);
  const canSubmit = trimmedName.length > 0 && targetValid && (!needsOrgPick || Boolean(pickedOrgId)) && !submitting;

  const reset = () => {
    setName('');
    setUptimeTarget(DEFAULT_UPTIME_TARGET);
    setMeasurementWindow('monthly');
    setExcludeWeekends(false);
    setExcludeMaintenanceWindows(false);
    setPickedOrgId('');
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await runAction({
        request: () => fetchWithAuth('/analytics/sla', {
          method: 'POST',
          body: JSON.stringify({
            ...(orgId ? { orgId } : {}),
            name: trimmedName,
            ...(parsedTarget !== undefined ? { uptimeTarget: parsedTarget } : {}),
            measurementWindow,
            targetType: 'organization',
            excludeWeekends,
            excludeMaintenanceWindows
          })
        }),
        errorFallback: t('analytics.slaEmptyState.errors.create'),
        successMessage: t('analytics.slaEmptyState.created'),
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      reset();
      setOpen(false);
      onCreated();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('analytics.slaEmptyState.errors.create') });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="flex h-full flex-col gap-3 rounded-lg border border-dashed bg-card p-5 shadow-xs lg:col-span-3"
      data-testid="analytics-sla-empty"
    >
      <div className="flex items-start gap-3">
        <Gauge className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{t('analytics.slaEmptyState.title')}</h3>
          <p className="text-sm text-muted-foreground">{t('analytics.slaEmptyState.description')}</p>
        </div>
      </div>

      {!canCreate ? (
        <p className="text-xs text-muted-foreground" data-testid="analytics-sla-no-permission">
          {t('analytics.slaEmptyState.noPermission')}
        </p>
      ) : !open ? (
        <div>
          <button
            type="button"
            onClick={() => setOpen(true)}
            data-testid="analytics-sla-create-open"
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('analytics.slaEmptyState.create')}
          </button>
        </div>
      ) : (
        <form
          onSubmit={handleSubmit}
          data-testid="analytics-sla-create-form"
          className="grid gap-3 sm:grid-cols-2"
        >
          {needsOrgPick && (
            <label className="space-y-1 text-sm sm:col-span-2">
              <span className="font-medium">{t('analytics.slaEmptyState.form.organization')}</span>
              <select
                value={pickedOrgId}
                onChange={event => setPickedOrgId(event.target.value)}
                data-testid="analytics-sla-org"
                required
                className={inputClass}
              >
                <option value="">{t('analytics.slaEmptyState.form.selectOrganization')}</option>
                {organizations.map(org => (
                  <option key={org.id} value={org.id}>{org.name}</option>
                ))}
              </select>
            </label>
          )}
          <label className="space-y-1 text-sm sm:col-span-2">
            <span className="font-medium">{t('analytics.slaEmptyState.form.name')}</span>
            <input
              type="text"
              value={name}
              onChange={event => setName(event.target.value)}
              maxLength={255}
              required
              data-testid="analytics-sla-name"
              className={inputClass}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">{t('analytics.slaEmptyState.form.uptimeTarget')}</span>
            <input
              type="number"
              min={0}
              max={100}
              step="0.01"
              value={uptimeTarget}
              onChange={event => setUptimeTarget(event.target.value)}
              aria-invalid={!targetValid}
              data-testid="analytics-sla-uptime-target"
              className={inputClass}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">{t('analytics.slaEmptyState.form.measurementWindow')}</span>
            <select
              value={measurementWindow}
              onChange={event => setMeasurementWindow(event.target.value as MeasurementWindow)}
              data-testid="analytics-sla-window"
              className={inputClass}
            >
              {MEASUREMENT_WINDOWS.map(value => (
                <option key={value} value={value}>
                  {windowLabels[value]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={excludeWeekends}
              onChange={event => setExcludeWeekends(event.target.checked)}
              data-testid="analytics-sla-exclude-weekends"
            />
            {t('analytics.slaEmptyState.form.excludeWeekends')}
          </label>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={excludeMaintenanceWindows}
              onChange={event => setExcludeMaintenanceWindows(event.target.checked)}
              data-testid="analytics-sla-exclude-maintenance"
            />
            {t('analytics.slaEmptyState.form.excludeMaintenance')}
          </label>
          <p className="text-xs text-muted-foreground sm:col-span-2">{t('analytics.slaEmptyState.form.scopeNote')}</p>
          <div className="flex gap-2 sm:col-span-2">
            <button
              type="submit"
              disabled={!canSubmit}
              data-testid="analytics-sla-create-submit"
              className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('analytics.slaEmptyState.form.submit')}
            </button>
            <button
              type="button"
              onClick={() => {
                reset();
                setOpen(false);
              }}
              disabled={submitting}
              data-testid="analytics-sla-create-cancel"
              className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
            >
              {t('analytics.slaEmptyState.form.cancel')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
