import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArrowRight, Pencil, Play, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { formatDateTime, mapNetworkBaseline, type NetworkBaseline } from './networkTypes';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { ResponsiveTable, DataCard, CardField, CardActions } from '../shared/ResponsiveTable';

type SiteOption = {
  id: string;
  name: string;
};

type BaselineFormState = {
  siteId: string;
  subnet: string;
  enabled: boolean;
  intervalHours: number;
  alertNewDevice: boolean;
  alertDisappeared: boolean;
  alertChanged: boolean;
  alertRogueDevice: boolean;
};

type NetworkBaselinesPanelProps = {
  currentOrgId: string | null;
  currentSiteId: string | null;
  siteOptions: SiteOption[];
  timezone?: string;
  onViewChanges: (baselineId: string) => void;
};

const cidrRegex = /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/;

function createDefaultForm(currentSiteId: string | null, siteOptions: SiteOption[]): BaselineFormState {
  return {
    siteId: currentSiteId ?? siteOptions[0]?.id ?? '',
    subnet: '',
    enabled: true,
    intervalHours: 4,
    alertNewDevice: true,
    alertDisappeared: true,
    alertChanged: true,
    alertRogueDevice: false
  };
}

function mapBaselineToForm(baseline: NetworkBaseline): BaselineFormState {
  return {
    siteId: baseline.siteId,
    subnet: baseline.subnet,
    enabled: baseline.scanSchedule.enabled,
    intervalHours: baseline.scanSchedule.intervalHours,
    alertNewDevice: baseline.alertSettings.newDevice,
    alertDisappeared: baseline.alertSettings.disappeared,
    alertChanged: baseline.alertSettings.changed,
    alertRogueDevice: baseline.alertSettings.rogueDevice
  };
}

async function extractError(response: Response, fallback: string): Promise<string> {
  const data = await response.json().catch(() => null);
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (typeof record.error === 'string' && record.error.trim().length > 0) {
      return record.error;
    }
    if (typeof record.message === 'string' && record.message.trim().length > 0) {
      return record.message;
    }
  }
  return `${fallback} (HTTP ${response.status})`;
}

export default function NetworkBaselinesPanel({
  currentOrgId,
  currentSiteId,
  siteOptions,
  timezone,
  onViewChanges
}: NetworkBaselinesPanelProps) {
  const { t } = useTranslation('discovery');
  const [baselines, setBaselines] = useState<NetworkBaseline[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [canManage, setCanManage] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<NetworkBaseline | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [form, setForm] = useState<BaselineFormState>(() => createDefaultForm(currentSiteId, siteOptions));

  const siteNameById = useMemo(
    () => new Map(siteOptions.map((site) => [site.id, site.name])),
    [siteOptions]
  );

  const editingBaseline = useMemo(
    () => baselines.find((baseline) => baseline.id === editingId) ?? null,
    [baselines, editingId]
  );

  const fetchBaselines = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (currentOrgId) params.set('orgId', currentOrgId);
      if (currentSiteId) params.set('siteId', currentSiteId);
      params.set('limit', '200');

      const query = params.toString();
      const response = await fetchWithAuth(`/network/baselines${query ? `?${query}` : ''}`);
      if (!response.ok) {
        throw new Error(await extractError(response, t('networkBaselinesPanel.errors.load')));
      }

      const payload = await response.json();
      const items = Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload)
          ? payload
          : [];

      const mapped = items
        .map((row: unknown) => mapNetworkBaseline(row))
        .filter((row: NetworkBaseline | null): row is NetworkBaseline => row !== null);

      setBaselines(mapped);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : t('networkBaselinesPanel.errors.load'));
    } finally {
      setLoading(false);
    }
  }, [currentOrgId, currentSiteId, t]);

  useEffect(() => {
    fetchBaselines();
  }, [fetchBaselines]);

  useEffect(() => {
    if (editingId) return;
    setForm((previous) => ({
      ...previous,
      siteId: currentSiteId ?? previous.siteId ?? siteOptions[0]?.id ?? ''
    }));
  }, [currentSiteId, editingId, siteOptions]);

  const resetForm = useCallback(() => {
    setEditingId(null);
    setForm(createDefaultForm(currentSiteId, siteOptions));
  }, [currentSiteId, siteOptions]);

  const handleEdit = (baseline: NetworkBaseline) => {
    setEditingId(baseline.id);
    setForm(mapBaselineToForm(baseline));
    setInfo(null);
    setError(null);
  };

  const validateForm = (): string | null => {
    if (!form.siteId.trim()) return t('networkBaselinesPanel.validation.selectSite');
    if (!cidrRegex.test(form.subnet.trim())) return t('networkBaselinesPanel.validation.cidr');
    if (!Number.isInteger(form.intervalHours) || form.intervalHours < 1 || form.intervalHours > 168) {
      return t('networkBaselinesPanel.validation.interval');
    }
    return null;
  };

  const handleSubmit = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();

    const validationError = validateForm();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError(null);
    setInfo(null);

    const scanSchedule = {
      enabled: form.enabled,
      intervalHours: form.intervalHours
    };
    const alertSettings = {
      newDevice: form.alertNewDevice,
      disappeared: form.alertDisappeared,
      changed: form.alertChanged,
      rogueDevice: form.alertRogueDevice
    };

    try {
      if (editingId) {
        const response = await fetchWithAuth(`/network/baselines/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify({ scanSchedule, alertSettings })
        });

        if (!response.ok) {
          if (response.status === 403) {
            setCanManage(false);
          }
          throw new Error(await extractError(response, t('networkBaselinesPanel.errors.update')));
        }

        setInfo(t('networkBaselinesPanel.messages.updated'));
      } else {
        const response = await fetchWithAuth('/network/baselines', {
          method: 'POST',
          body: JSON.stringify({
            orgId: currentOrgId ?? undefined,
            siteId: form.siteId.trim(),
            subnet: form.subnet.trim(),
            scanSchedule,
            alertSettings
          })
        });

        if (!response.ok) {
          if (response.status === 403) {
            setCanManage(false);
          }
          throw new Error(await extractError(response, t('networkBaselinesPanel.errors.create')));
        }

        setInfo(t('networkBaselinesPanel.messages.created'));
      }

      await fetchBaselines();
      resetForm();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('networkBaselinesPanel.errors.save'));
    } finally {
      setSaving(false);
    }
  };

  const handleRunNow = async (baseline: NetworkBaseline) => {
    setError(null);
    setInfo(null);

    try {
      const response = await fetchWithAuth(`/network/baselines/${baseline.id}/scan`, {
        method: 'POST'
      });

      if (!response.ok) {
        if (response.status === 403) {
          setCanManage(false);
        }
        throw new Error(await extractError(response, t('networkBaselinesPanel.errors.run')));
      }

      const payload = await response.json().catch(() => null);
      const queueJobId = payload && typeof payload === 'object' && typeof (payload as { queueJobId?: unknown }).queueJobId === 'string'
        ? (payload as { queueJobId: string }).queueJobId
        : null;

      setInfo(queueJobId ? t('networkBaselinesPanel.messages.scanQueuedWithId', { id: queueJobId }) : t('networkBaselinesPanel.messages.scanQueued'));
      await fetchBaselines();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : t('networkBaselinesPanel.errors.run'));
    }
  };

  const handleDelete = (baseline: NetworkBaseline) => {
    setDeleteTarget(baseline);
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;

    setDeleting(true);
    setError(null);
    setInfo(null);

    try {
      const response = await fetchWithAuth(`/network/baselines/${deleteTarget.id}?deleteChanges=true`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        if (response.status === 403) {
          setCanManage(false);
        }
        throw new Error(await extractError(response, t('networkBaselinesPanel.errors.delete')));
      }

      setInfo(t('networkBaselinesPanel.messages.deleted', { subnet: deleteTarget.subnet }));
      await fetchBaselines();
      if (editingId === deleteTarget.id) {
        resetForm();
      }
      setDeleteTarget(null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : t('networkBaselinesPanel.errors.delete'));
    } finally {
      setDeleting(false);
    }
  };

  if (loading && baselines.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card p-10 shadow-xs">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">{t('networkBaselinesPanel.loading')}</p>
        </div>
      </div>
    );
  }

  const enabledAlertsFor = (baseline: NetworkBaseline): string[] => {
    const enabledAlerts: string[] = [];
    if (baseline.alertSettings.newDevice) enabledAlerts.push(t('networkBaselinesPanel.alertNames.new'));
    if (baseline.alertSettings.disappeared) enabledAlerts.push(t('networkBaselinesPanel.alertNames.gone'));
    if (baseline.alertSettings.changed) enabledAlerts.push(t('networkBaselinesPanel.alertNames.changed'));
    if (baseline.alertSettings.rogueDevice) enabledAlerts.push(t('networkBaselinesPanel.alertNames.rogue'));
    return enabledAlerts;
  };

  const renderSubnet = (baseline: NetworkBaseline) => {
    const enabledAlerts = enabledAlertsFor(baseline);
    return (
      <>
        <div className="font-mono text-sm">{baseline.subnet}</div>
        <div className="text-xs text-muted-foreground">
          {t('networkBaselinesPanel.alertsSummary', { alerts: enabledAlerts.length > 0 ? enabledAlerts.join(', ') : t('common:labels.none') })}
        </div>
      </>
    );
  };

  const renderSchedule = (baseline: NetworkBaseline) => (
    <>
      <div className="text-sm">
        {baseline.scanSchedule.enabled
          ? t('networkBaselinesPanel.everyHoursShort', { count: baseline.scanSchedule.intervalHours })
          : t('networkBaselinesPanel.paused')}
      </div>
      <div className="text-xs text-muted-foreground">
        {t('networkBaselinesPanel.next', { time: formatDateTime(baseline.scanSchedule.nextScanAt, timezone) })}
      </div>
    </>
  );

  const renderActions = (baseline: NetworkBaseline) => (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        onClick={() => onViewChanges(baseline.id)}
        className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
        title={t('networkBaselinesPanel.actions.viewChanges')}
      >
        {t('networkBaselinesPanel.actions.changes')}
        <ArrowRight className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={() => handleRunNow(baseline)}
        disabled={!canManage}
        className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted disabled:opacity-40"
        title={t('networkBaselinesPanel.actions.runNow')}
      >
        <Play className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => handleEdit(baseline)}
        disabled={!canManage}
        className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted disabled:opacity-40"
        title={t('common:actions.edit')}
      >
        <Pencil className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => handleDelete(baseline)}
        disabled={!canManage}
        className="flex h-8 w-8 items-center justify-center rounded-md border border-destructive/30 text-destructive hover:bg-destructive/10 disabled:opacity-40"
        title={t('common:actions.delete')}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );

  return (
    <>
    <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">{t('networkBaselinesPanel.title')}</h2>
            <p className="text-sm text-muted-foreground">{t('networkBaselinesPanel.configuredCount', { count: baselines.length })}</p>
          </div>
          <button
            type="button"
            onClick={() => fetchBaselines()}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
          >
            <RefreshCw className="h-4 w-4" />
            {t('common:actions.refresh')}
          </button>
        </div>

        {!canManage && (
          <div className="mt-4 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-800">
            {t('networkBaselinesPanel.permissionManage')}
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {info && (
          <div className="mt-4 rounded-md border border-green-500/40 bg-green-500/10 px-3 py-2 text-sm text-green-700">
            {info}
          </div>
        )}

        <ResponsiveTable
          className="mt-6"
          table={
            <table className="min-w-full divide-y">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">{t('networkBaselinesPanel.columns.subnet')}</th>
                  <th className="px-4 py-3">{t('common:labels.site')}</th>
                  <th className="px-4 py-3">{t('networkBaselinesPanel.columns.schedule')}</th>
                  <th className="px-4 py-3">{t('networkBaselinesPanel.columns.lastScan')}</th>
                  <th className="px-4 py-3">{t('networkBaselinesPanel.columns.knownDevices')}</th>
                  <th className="px-4 py-3 text-right">{t('common:labels.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {baselines.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">
                      {t('networkBaselinesPanel.empty')}
                    </td>
                  </tr>
                ) : (
                  baselines.map((baseline) => (
                    <tr key={baseline.id} className="transition hover:bg-muted/40">
                      <td className="px-4 py-3">{renderSubnet(baseline)}</td>
                      <td className="px-4 py-3 text-sm">{siteNameById.get(baseline.siteId) ?? baseline.siteId}</td>
                      <td className="px-4 py-3">{renderSchedule(baseline)}</td>
                      <td className="px-4 py-3 text-sm">{formatDateTime(baseline.lastScanAt, timezone)}</td>
                      <td className="px-4 py-3 text-sm">{baseline.knownDevices.length}</td>
                      <td className="px-4 py-3">{renderActions(baseline)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          }
          cards={
            baselines.length === 0 ? (
              <DataCard>
                <p className="py-2 text-center text-sm text-muted-foreground">
                  {t('networkBaselinesPanel.empty')}
                </p>
              </DataCard>
            ) : (
              baselines.map((baseline) => {
                const enabledAlerts = enabledAlertsFor(baseline);
                return (
                <DataCard key={baseline.id}>
                  <div className="font-mono text-sm font-semibold">{baseline.subnet}</div>
                  <div className="text-xs text-muted-foreground">
                    {t('networkBaselinesPanel.alertsSummary', { alerts: enabledAlerts.length > 0 ? enabledAlerts.join(', ') : t('common:labels.none') })}
                  </div>
                  <div className="mt-3 space-y-2 border-t pt-3">
                    <CardField label={t('common:labels.site')}>
                      <span className="text-sm">{siteNameById.get(baseline.siteId) ?? baseline.siteId}</span>
                    </CardField>
                    <div>
                      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('networkBaselinesPanel.columns.schedule')}</span>
                      <div className="mt-1">{renderSchedule(baseline)}</div>
                    </div>
                    <CardField label={t('networkBaselinesPanel.columns.lastScan')}>
                      <span className="text-sm">{formatDateTime(baseline.lastScanAt, timezone)}</span>
                    </CardField>
                    <CardField label={t('networkBaselinesPanel.columns.knownDevices')}>
                      <span className="text-sm">{baseline.knownDevices.length}</span>
                    </CardField>
                  </div>
                  <CardActions>{renderActions(baseline)}</CardActions>
                </DataCard>
                );
              })
            )
          }
        />
      </div>

      <form onSubmit={handleSubmit} className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">{editingBaseline ? t('networkBaselinesPanel.form.editTitle') : t('networkBaselinesPanel.form.createTitle')}</h2>
            <p className="text-sm text-muted-foreground">
              {editingBaseline
                ? t('networkBaselinesPanel.form.editDescription')
                : t('networkBaselinesPanel.form.createDescription')}
            </p>
          </div>
          {editingBaseline && (
            <button
              type="button"
              onClick={resetForm}
              className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
            >
              {t('common:actions.cancel')}
            </button>
          )}
        </div>

        <div className="mt-4 space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('common:labels.site')}</label>
            <select
              value={form.siteId}
              onChange={(event) => setForm((previous) => ({ ...previous, siteId: event.target.value }))}
              disabled={!!editingBaseline}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
            >
              <option value="">{t('networkBaselinesPanel.options.selectSite')}</option>
              {siteOptions.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('networkBaselinesPanel.fields.subnetCidr')}</label>
            <input
              type="text"
              value={form.subnet}
              onChange={(event) => setForm((previous) => ({ ...previous, subnet: event.target.value }))}
              placeholder={t('networkBaselinesPanel.placeholders.subnet')}
              disabled={!!editingBaseline}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm font-mono focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
            />
            {editingBaseline && (
              <p className="mt-1 text-xs text-muted-foreground">{t('networkBaselinesPanel.form.immutableHint')}</p>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => setForm((previous) => ({ ...previous, enabled: event.target.checked }))}
              className="h-4 w-4 rounded border"
            />
            {t('networkBaselinesPanel.fields.enableScheduledScans')}
          </label>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('networkBaselinesPanel.fields.scanInterval')}</label>
            <input
              type="number"
              min={1}
              max={168}
              value={form.intervalHours}
              onChange={(event) => setForm((previous) => ({ ...previous, intervalHours: Number(event.target.value) || 1 }))}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="rounded-md border p-3">
            <p className="text-xs font-medium text-muted-foreground">{t('networkBaselinesPanel.fields.alertSettings')}</p>
            <div className="mt-2 space-y-2 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.alertNewDevice}
                  onChange={(event) => setForm((previous) => ({ ...previous, alertNewDevice: event.target.checked }))}
                  className="h-4 w-4 rounded border"
                />
                {t('networkBaselinesPanel.alertLabels.newDevice')}
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.alertDisappeared}
                  onChange={(event) => setForm((previous) => ({ ...previous, alertDisappeared: event.target.checked }))}
                  className="h-4 w-4 rounded border"
                />
                {t('networkBaselinesPanel.alertLabels.disappeared')}
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.alertChanged}
                  onChange={(event) => setForm((previous) => ({ ...previous, alertChanged: event.target.checked }))}
                  className="h-4 w-4 rounded border"
                />
                {t('networkBaselinesPanel.alertLabels.changed')}
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.alertRogueDevice}
                  onChange={(event) => setForm((previous) => ({ ...previous, alertRogueDevice: event.target.checked }))}
                  className="h-4 w-4 rounded border"
                />
                {t('networkBaselinesPanel.alertLabels.rogue')}
              </label>
            </div>
          </div>
        </div>

        <button
          type="submit"
          disabled={saving || !canManage}
          className="mt-6 w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving
            ? (editingBaseline ? t('common:states.saving') : t('networkBaselinesPanel.actions.creating'))
            : (editingBaseline ? t('networkBaselinesPanel.actions.saveSettings') : t('networkBaselinesPanel.actions.create'))}
        </button>
      </form>
    </div>
    <ConfirmDialog
      open={deleteTarget !== null}
      onClose={() => setDeleteTarget(null)}
      onConfirm={handleConfirmDelete}
      title={t('networkBaselinesPanel.deleteDialog.title')}
      message={t('networkBaselinesPanel.deleteDialog.message', { subnet: deleteTarget?.subnet })}
      confirmLabel={t('networkBaselinesPanel.deleteDialog.confirm')}
      variant="destructive"
      isLoading={deleting}
    />
    </>
  );
}
