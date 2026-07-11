import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, ActionError } from '@/lib/runAction';
import { fetchTicketConfig, priorityLabel } from '@/lib/ticketConfigApi';
import type { TicketConfig } from '@/lib/ticketConfigApi';
import { priorityConfig } from '../tickets/ticketConfig';
import type { TicketPriority } from '../tickets/ticketConfig';

const PRIORITIES = Object.keys(priorityConfig) as TicketPriority[];

type SlaOverride = {
  responseMinutes?: number;
  resolutionMinutes?: number;
};

type OrgTicketSettings = {
  orgId: string;
  slaOverrides: Partial<Record<TicketPriority, SlaOverride>>;
  defaultHourlyRate: string | null;
  defaultBillable: boolean | null;
};

type DraftSlaRow = {
  responseMinutes: string;
  resolutionMinutes: string;
};

type OrgTicketSettingsEditorProps = {
  orgId: string;
  onDirty: () => void;
  onSave: () => void;
};

export default function OrgTicketSettingsEditor({ orgId, onDirty, onSave }: OrgTicketSettingsEditorProps) {
  const { t } = useTranslation('settings');
  const [settings, setSettings] = useState<OrgTicketSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [partnerConfig, setPartnerConfig] = useState<TicketConfig | null>(null);

  // Draft state for the form
  const [slaRows, setSlaRows] = useState<Record<TicketPriority, DraftSlaRow>>(
    () => Object.fromEntries(PRIORITIES.map(p => [p, { responseMinutes: '', resolutionMinutes: '' }])) as Record<TicketPriority, DraftSlaRow>
  );
  const [hourlyRate, setHourlyRate] = useState('');
  const [billable, setBillable] = useState<'inherit' | 'true' | 'false'>('inherit');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const [res, config] = await Promise.all([
        fetchWithAuth(`/orgs/organizations/${orgId}/ticket-settings`),
        fetchTicketConfig()
      ]);
      if (res.status === 401) {
        void navigateTo('/login', { replace: true });
        return;
      }
      if (!res.ok) throw new Error(`ticket settings load failed: ${res.status}`);
      const body = (await res.json()) as { data: OrgTicketSettings };
      const data = body.data;
      setSettings(data);
      setPartnerConfig(config);

      // Populate draft fields from fetched settings
      const newRows = Object.fromEntries(
        PRIORITIES.map(p => {
          const override = data.slaOverrides?.[p];
          return [p, {
            responseMinutes: override?.responseMinutes != null ? String(override.responseMinutes) : '',
            resolutionMinutes: override?.resolutionMinutes != null ? String(override.resolutionMinutes) : ''
          }];
        })
      ) as Record<TicketPriority, DraftSlaRow>;
      setSlaRows(newRows);
      setHourlyRate(data.defaultHourlyRate ?? '');
      setBillable(
        data.defaultBillable === true ? 'true' :
        data.defaultBillable === false ? 'false' :
        'inherit'
      );
    } catch (err) {
      console.warn('[OrgTicketSettingsEditor] load failed', err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { void load(); }, [load]);

  const updateSlaRow = (priority: TicketPriority, field: keyof DraftSlaRow, value: string) => {
    setSlaRows(prev => ({ ...prev, [priority]: { ...prev[priority], [field]: value } }));
    onDirty();
  };

  const save = useCallback(async () => {
    if (!settings || saving) return;
    setSaving(true);
    try {
      // Build slaOverrides from all non-blank cells (blank means absent = cleared)
      const slaOverrides: Partial<Record<TicketPriority, SlaOverride>> = {};
      for (const p of PRIORITIES) {
        const row = slaRows[p];
        const responseMinutes = row.responseMinutes.trim() !== '' ? Number(row.responseMinutes) : undefined;
        const resolutionMinutes = row.resolutionMinutes.trim() !== '' ? Number(row.resolutionMinutes) : undefined;
        if (responseMinutes !== undefined || resolutionMinutes !== undefined) {
          slaOverrides[p] = {};
          if (responseMinutes !== undefined) slaOverrides[p]!.responseMinutes = responseMinutes;
          if (resolutionMinutes !== undefined) slaOverrides[p]!.resolutionMinutes = resolutionMinutes;
        }
      }

      const rateStr = hourlyRate.trim();
      const defaultHourlyRate = rateStr !== '' ? Number(rateStr) : null;
      const defaultBillable = billable === 'true' ? true : billable === 'false' ? false : null;

      await runAction({
        request: () => fetchWithAuth(`/orgs/organizations/${orgId}/ticket-settings`, {
          method: 'PATCH',
          body: JSON.stringify({ slaOverrides, defaultHourlyRate, defaultBillable })
        }),
        errorFallback: t('orgTicketSettingsEditor.errors.save'),
        successMessage: t('orgTicketSettingsEditor.toasts.saved'),
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      onSave();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    } finally {
      setSaving(false);
    }
  }, [settings, saving, slaRows, hourlyRate, billable, orgId, onSave, t]);

  // Compute placeholder for a given priority+field:
  // If partnerConfig has a value, show the number; otherwise show "Partner default"
  const getPlaceholder = (priority: TicketPriority, field: 'response' | 'resolution'): string => {
    if (!partnerConfig) return t('orgTicketSettingsEditor.partnerDefault');
    const pSetting = partnerConfig.priorities[priority];
    if (!pSetting) return t('orgTicketSettingsEditor.partnerDefault');
    const val = field === 'response' ? pSetting.responseSlaMinutes : pSetting.resolutionSlaMinutes;
    return val != null ? String(val) : t('orgTicketSettingsEditor.partnerDefault');
  };

  if (loading) {
    return <p className="text-sm text-muted-foreground">{t('orgTicketSettingsEditor.loading')}</p>;
  }

  if (loadError || !settings) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground" data-testid="org-ticket-load-error">
        {t('orgTicketSettingsEditor.errors.load')}{' '}
        <button type="button" onClick={() => void load()} className="underline hover:text-foreground">
          {t('common:actions.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="org-ticket-settings">
      <section className="rounded-lg border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">{t('orgTicketSettingsEditor.sla.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('orgTicketSettingsEditor.sla.description')}
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="pb-2 pr-4 font-medium">{t('orgTicketSettingsEditor.sla.priority')}</th>
                <th className="pb-2 pr-4 font-medium">{t('orgTicketSettingsEditor.sla.response')}</th>
                <th className="pb-2 font-medium">{t('orgTicketSettingsEditor.sla.resolution')}</th>
              </tr>
            </thead>
            <tbody className="space-y-2">
              {PRIORITIES.map(p => (
                <tr key={p}>
                  <td className="py-1.5 pr-4 font-medium capitalize">
                    {priorityLabel(partnerConfig, p)}
                  </td>
                  <td className="py-1.5 pr-4">
                    <input
                      type="number"
                      min={1}
                      value={slaRows[p].responseMinutes}
                      onChange={(e) => updateSlaRow(p, 'responseMinutes', e.target.value)}
                      placeholder={getPlaceholder(p, 'response')}
                      className="w-28 rounded-md border bg-background px-3 py-1.5 text-sm"
                      data-testid={`org-ticket-sla-${p}-response`}
                    />
                  </td>
                  <td className="py-1.5">
                    <input
                      type="number"
                      min={1}
                      value={slaRows[p].resolutionMinutes}
                      onChange={(e) => updateSlaRow(p, 'resolutionMinutes', e.target.value)}
                      placeholder={getPlaceholder(p, 'resolution')}
                      className="w-28 rounded-md border bg-background px-3 py-1.5 text-sm"
                      data-testid={`org-ticket-sla-${p}-resolution`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">{t('orgTicketSettingsEditor.billing.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('orgTicketSettingsEditor.billing.description')}
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium" htmlFor="org-ticket-rate">{t('orgTicketSettingsEditor.billing.hourlyRate')}</label>
            <input
              id="org-ticket-rate"
              type="number"
              min={0}
              step="0.01"
              value={hourlyRate}
              onChange={(e) => { setHourlyRate(e.target.value); onDirty(); }}
              placeholder={t('orgTicketSettingsEditor.partnerDefault')}
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
              data-testid="org-ticket-rate"
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="org-ticket-billable">{t('orgTicketSettingsEditor.billing.billable')}</label>
            <select
              id="org-ticket-billable"
              value={billable}
              onChange={(e) => { setBillable(e.target.value as 'inherit' | 'true' | 'false'); onDirty(); }}
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
              data-testid="org-ticket-billable"
            >
              <option value="inherit">{t('orgTicketSettingsEditor.billing.inherit')}</option>
              <option value="true">{t('orgTicketSettingsEditor.billing.billableOption')}</option>
              <option value="false">{t('orgTicketSettingsEditor.billing.nonBillableOption')}</option>
            </select>
          </div>
        </div>
      </section>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          data-testid="org-ticket-save"
        >
          {saving ? t('common:states.saving') : t('orgTicketSettingsEditor.actions.save')}
        </button>
      </div>
    </div>
  );
}
