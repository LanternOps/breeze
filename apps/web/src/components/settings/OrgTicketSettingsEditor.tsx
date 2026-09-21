import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { showToast } from '../shared/Toast';
import { runAction, ActionError } from '@/lib/runAction';
import { fetchTicketConfig, priorityLabel } from '@/lib/ticketConfigApi';
import type { TicketConfig } from '@/lib/ticketConfigApi';
import { priorityConfig } from '../tickets/ticketConfig';
import type { TicketPriority } from '../tickets/ticketConfig';
import InheritedField from '../shared/InheritedField';

const PRIORITIES = Object.keys(priorityConfig) as TicketPriority[];

type SlaOverride = {
  responseMinutes?: number;
  resolutionMinutes?: number;
};

type OrgTicketSettings = {
  orgId: string;
  slaOverrides: Partial<Record<TicketPriority, SlaOverride>>;
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

      const patch = { slaOverrides };

      await runAction({
        request: () => fetchWithAuth(`/orgs/organizations/${orgId}/ticket-settings`, {
          method: 'PATCH',
          body: JSON.stringify(patch)
        }),
        errorFallback: t('orgTicketSettingsEditor.errors.save'),
        successMessage: t('orgTicketSettingsEditor.toasts.saved'),
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      onSave();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('orgTicketSettingsEditor.errors.save') });
    } finally {
      setSaving(false);
    }
  }, [settings, saving, slaRows, orgId, onSave, t]);

  // The inherited (partner-default) SLA number for a given priority+field, or
  // null when the partner has no value configured — feeds InheritedField's
  // inheritedValue prop (rule 4: always show the VALUE, not just the source).
  const partnerSlaValue = (priority: TicketPriority, field: 'response' | 'resolution'): string | null => {
    const pSetting = partnerConfig?.priorities[priority];
    if (!pSetting) return null;
    const val = field === 'response' ? pSetting.responseSlaMinutes : pSetting.resolutionSlaMinutes;
    return val != null ? String(val) : null;
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
        <p className="mt-1 text-xs text-amber-700" data-testid="org-ticket-sla-direction-note">
          {t('orgTicketSettingsEditor.sla.categoryOverridesNote')}
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
                    <InheritedField
                      id={`org-ticket-sla-${p}-response`}
                      label=""
                      hideLabel
                      value={slaRows[p].responseMinutes}
                      onChange={(v) => updateSlaRow(p, 'responseMinutes', v)}
                      inheritedValue={partnerSlaValue(p, 'response')}
                      inheritedSource={t('orgTicketSettingsEditor.partnerDefault')}
                      type="number"
                      min={1}
                      data-testid={`org-ticket-sla-${p}-response`}
                    />
                  </td>
                  <td className="py-1.5">
                    <InheritedField
                      id={`org-ticket-sla-${p}-resolution`}
                      label=""
                      hideLabel
                      value={slaRows[p].resolutionMinutes}
                      onChange={(v) => updateSlaRow(p, 'resolutionMinutes', v)}
                      inheritedValue={partnerSlaValue(p, 'resolution')}
                      inheritedSource={t('orgTicketSettingsEditor.partnerDefault')}
                      type="number"
                      min={1}
                      data-testid={`org-ticket-sla-${p}-resolution`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
