import { useCallback, useEffect, useState } from 'react';
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
        errorFallback: 'Failed to save ticket settings',
        successMessage: 'Ticket settings saved',
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      onSave();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    } finally {
      setSaving(false);
    }
  }, [settings, saving, slaRows, hourlyRate, billable, orgId, onSave]);

  // Compute placeholder for a given priority+field:
  // If partnerConfig has a value, show the number; otherwise show "Partner default"
  const getPlaceholder = (priority: TicketPriority, field: 'response' | 'resolution'): string => {
    if (!partnerConfig) return 'Partner default';
    const pSetting = partnerConfig.priorities[priority];
    if (!pSetting) return 'Partner default';
    const val = field === 'response' ? pSetting.responseSlaMinutes : pSetting.resolutionSlaMinutes;
    return val != null ? String(val) : 'Partner default';
  };

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading ticket settings…</p>;
  }

  if (loadError || !settings) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground" data-testid="org-ticket-load-error">
        Ticket settings failed to load.{' '}
        <button type="button" onClick={() => void load()} className="underline hover:text-foreground">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="org-ticket-settings">
      <section className="rounded-lg border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold">SLA overrides</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Override the partner-wide SLA defaults for this organization. Leave a cell blank to inherit the partner default.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="pb-2 pr-4 font-medium">Priority</th>
                <th className="pb-2 pr-4 font-medium">Response (min)</th>
                <th className="pb-2 font-medium">Resolution (min)</th>
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

      <section className="rounded-lg border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Billing defaults</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Default billing settings for time entries on tickets for this organization.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium" htmlFor="org-ticket-rate">Default hourly rate ($)</label>
            <input
              id="org-ticket-rate"
              type="number"
              min={0}
              step="0.01"
              value={hourlyRate}
              onChange={(e) => { setHourlyRate(e.target.value); onDirty(); }}
              placeholder="Partner default"
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
              data-testid="org-ticket-rate"
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="org-ticket-billable">Default billable</label>
            <select
              id="org-ticket-billable"
              value={billable}
              onChange={(e) => { setBillable(e.target.value as 'inherit' | 'true' | 'false'); onDirty(); }}
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
              data-testid="org-ticket-billable"
            >
              <option value="inherit">Inherit</option>
              <option value="true">Billable</option>
              <option value="false">Non-billable</option>
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
          {saving ? 'Saving…' : 'Save ticket settings'}
        </button>
      </div>
    </div>
  );
}
