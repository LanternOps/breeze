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

// Customer work approval overrides (#8196). Blank string = inherit; the API
// returns the RESOLVED value + source, so a field is an override iff source==='org'.
const APPROVAL_FIELDS = ['enabled', 'budgetTrigger', 'afterHoursTrigger', 'enforcement', 'requestTtlHours'] as const;
type ApprovalField = (typeof APPROVAL_FIELDS)[number];
type ApprovalSource = 'org' | 'partner' | 'default';
type ApprovalDraft = Record<ApprovalField, string>;
type ApprovalResolved = Record<ApprovalField, { value: string; source: ApprovalSource }>;
const TTL_MIN = 1;
const TTL_MAX = 720;
const BLANK_APPROVAL: ApprovalDraft = { enabled: '', budgetTrigger: '', afterHoursTrigger: '', enforcement: '', requestTtlHours: '' };
const APPROVAL_TESTID: Record<ApprovalField, string> = {
  enabled: 'org-approval-enabled',
  budgetTrigger: 'org-approval-budget-trigger',
  afterHoursTrigger: 'org-approval-after-hours-trigger',
  enforcement: 'org-approval-enforcement',
  requestTtlHours: 'org-approval-ttl',
};

function parseApproval(data: unknown): { draft: ApprovalDraft; resolved: ApprovalResolved } | null {
  if (!data || typeof data !== 'object') return null;
  const rec = data as Record<string, { value?: unknown; source?: unknown } | undefined>;
  const draft = { ...BLANK_APPROVAL };
  const resolved = {} as ApprovalResolved;
  for (const key of APPROVAL_FIELDS) {
    const field = rec[key];
    if (!field || field.value === undefined || field.value === null) return null;
    const source: ApprovalSource = field.source === 'org' || field.source === 'partner' ? field.source : 'default';
    resolved[key] = { value: String(field.value), source };
    if (source === 'org') draft[key] = String(field.value);
  }
  return { draft, resolved };
}

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

  const [approvalBase, setApprovalBase] = useState<ApprovalDraft>(BLANK_APPROVAL);
  const [approval, setApproval] = useState<ApprovalDraft>(BLANK_APPROVAL);
  const [approvalResolved, setApprovalResolved] = useState<ApprovalResolved | null>(null);
  const [approvalLoadFailed, setApprovalLoadFailed] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);

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

  const loadApproval = useCallback(async () => {
    setApprovalLoadFailed(false);
    try {
      const res = await fetchWithAuth(`/orgs/${orgId}/ticketing/approval-settings`);
      if (!res.ok) throw new Error(`approval settings load failed: ${res.status}`);
      const body = (await res.json()) as { data?: unknown };
      const parsed = parseApproval(body.data);
      if (!parsed) throw new Error('approval settings response malformed');
      setApprovalBase(parsed.draft);
      setApproval(parsed.draft);
      setApprovalResolved(parsed.resolved);
    } catch (err) {
      console.warn('[OrgTicketSettingsEditor] approval settings load failed', err);
      setApprovalResolved(null);
      setApprovalLoadFailed(true);
    }
  }, [orgId]);

  useEffect(() => { void loadApproval(); }, [loadApproval]);

  const updateApproval = (field: ApprovalField, value: string) => {
    setApproval(prev => ({ ...prev, [field]: value }));
    onDirty();
  };

  const updateSlaRow = (priority: TicketPriority, field: keyof DraftSlaRow, value: string) => {
    setSlaRows(prev => ({ ...prev, [priority]: { ...prev[priority], [field]: value } }));
    onDirty();
  };

  const save = useCallback(async () => {
    if (!settings || saving) return;
    const ttlDraft = approval.requestTtlHours.trim();
    if (approvalResolved && ttlDraft !== '') {
      const ttl = Number(ttlDraft);
      if (!Number.isInteger(ttl) || ttl < TTL_MIN || ttl > TTL_MAX) {
        setApprovalError(t('orgTicketSettingsEditor.approval.ttlRange', { min: TTL_MIN, max: TTL_MAX }));
        return;
      }
    }
    setApprovalError(null);
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
      // Only changed fields go out; `null` clears an override (= inherit).
      const approvalPatch: Record<string, unknown> = {};
      if (approvalResolved) {
        for (const field of APPROVAL_FIELDS) {
          if (approval[field] === approvalBase[field]) continue;
          if (approval[field].trim() === '') approvalPatch[field] = null;
          else if (field === 'requestTtlHours') approvalPatch[field] = Number(approval[field]);
          else if (field === 'enforcement') approvalPatch[field] = approval[field];
          else approvalPatch[field] = approval[field] === 'true';
        }
      }
      if (Object.keys(approvalPatch).length > 0) {
        await runAction({
          request: () => fetchWithAuth(`/orgs/${orgId}/ticketing/approval-settings`, {
            method: 'PATCH',
            body: JSON.stringify(approvalPatch)
          }),
          errorFallback: t('orgTicketSettingsEditor.errors.save'),
          onUnauthorized: () => void navigateTo('/login', { replace: true })
        });
        // Re-fetch so a cleared field shows the inherited value and its source.
        await loadApproval();
      }
      onSave();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('orgTicketSettingsEditor.errors.save') });
    } finally {
      setSaving(false);
    }
  }, [settings, saving, slaRows, orgId, onSave, t, approval, approvalBase, approvalResolved, loadApproval]);

  // The inherited (partner-default) SLA number for a given priority+field, or
  // null when the partner has no value configured — feeds InheritedField's
  // inheritedValue prop (rule 4: always show the VALUE, not just the source).
  const partnerSlaValue = (priority: TicketPriority, field: 'response' | 'resolution'): string | null => {
    const pSetting = partnerConfig?.priorities[priority];
    if (!pSetting) return null;
    const val = field === 'response' ? pSetting.responseSlaMinutes : pSetting.resolutionSlaMinutes;
    return val != null ? String(val) : null;
  };

  const sourceLabel = (source: ApprovalSource) =>
    source === 'org'
      ? t('orgTicketSettingsEditor.approval.sourceOrg')
      : source === 'partner'
        ? t('orgTicketSettingsEditor.approval.sourcePartner')
        : t('orgTicketSettingsEditor.approval.sourceDefault');

  // Human text for an inherited value (booleans / enforcement are stored as strings).
  const valueLabel = (field: ApprovalField, value: string) => {
    if (field === 'enforcement') {
      return value === 'hard'
        ? t('orgTicketSettingsEditor.approval.enforcementHard')
        : t('orgTicketSettingsEditor.approval.enforcementSoft');
    }
    if (field === 'requestTtlHours') return value;
    return value === 'true' ? t('orgTicketSettingsEditor.approval.on') : t('orgTicketSettingsEditor.approval.off');
  };

  const clearButton = (field: ApprovalField) =>
    approval[field] !== '' ? (
      <button
        type="button"
        onClick={() => updateApproval(field, '')}
        className="mt-1 text-xs text-muted-foreground underline hover:text-foreground"
        data-testid={`${APPROVAL_TESTID[field]}-clear`}
      >
        {t('orgTicketSettingsEditor.approval.clear')}
      </button>
    ) : null;

  // Select-style override (boolean / enum). '' = inherit, showing the inherited value + source.
  const approvalSelect = (field: Exclude<ApprovalField, 'requestTtlHours'>, label: string, options: { value: string; label: string }[]) => {
    const resolved = approvalResolved?.[field];
    const inheriting = approval[field] === '';
    return (
      <div key={field}>
        <label className="text-sm font-medium" htmlFor={APPROVAL_TESTID[field]}>{label}</label>
        <select
          id={APPROVAL_TESTID[field]}
          data-testid={APPROVAL_TESTID[field]}
          className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm disabled:opacity-50"
          value={approval[field]}
          disabled={!approvalResolved}
          onChange={(e) => updateApproval(field, e.target.value)}
        >
          <option value="">
            {resolved && approvalBase[field] === ''
              ? t('orgTicketSettingsEditor.approval.inheritValue', { value: valueLabel(field, resolved.value) })
              : t('orgTicketSettingsEditor.approval.inherit')}
          </option>
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {resolved && inheriting && approvalBase[field] === '' ? (
          <p className="mt-1 text-xs text-muted-foreground" data-testid={`${APPROVAL_TESTID[field]}-source`}>
            {t('common:inheritedField.inheritsFrom', { source: sourceLabel(resolved.source) })}
          </p>
        ) : inheriting ? (
          <p className="mt-1 text-xs text-muted-foreground" data-testid={`${APPROVAL_TESTID[field]}-source`}>
            {t('orgTicketSettingsEditor.approval.pendingInherit')}
          </p>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground" data-testid={`${APPROVAL_TESTID[field]}-source`}>
            {sourceLabel('org')}
          </p>
        )}
        {clearButton(field)}
      </div>
    );
  };

  const onOffOptions = [
    { value: 'true', label: t('orgTicketSettingsEditor.approval.on') },
    { value: 'false', label: t('orgTicketSettingsEditor.approval.off') },
  ];

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
                      label={`${priorityLabel(partnerConfig, p)} ${t('orgTicketSettingsEditor.sla.response')}`}
                      hideLabel
                      value={slaRows[p].responseMinutes}
                      onChange={(v) => updateSlaRow(p, 'responseMinutes', v)}
                      inheritedValue={partnerSlaValue(p, 'response')}
                      inheritedSource={t('orgTicketSettingsEditor.partnerDefault')}
                      type="number"
                      min={1}
                      inputWidthClassName="w-28"
                      data-testid={`org-ticket-sla-${p}-response`}
                    />
                  </td>
                  <td className="py-1.5">
                    <InheritedField
                      id={`org-ticket-sla-${p}-resolution`}
                      label={`${priorityLabel(partnerConfig, p)} ${t('orgTicketSettingsEditor.sla.resolution')}`}
                      hideLabel
                      value={slaRows[p].resolutionMinutes}
                      onChange={(v) => updateSlaRow(p, 'resolutionMinutes', v)}
                      inheritedValue={partnerSlaValue(p, 'resolution')}
                      inheritedSource={t('orgTicketSettingsEditor.partnerDefault')}
                      type="number"
                      min={1}
                      inputWidthClassName="w-28"
                      data-testid={`org-ticket-sla-${p}-resolution`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border bg-card p-6 shadow-xs" data-testid="org-approval-section">
        <h2 className="text-lg font-semibold">{t('orgTicketSettingsEditor.approval.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('orgTicketSettingsEditor.approval.description')}</p>
        {approvalLoadFailed && (
          <div className="mt-3 text-sm text-destructive" role="alert" data-testid="org-approval-load-error">
            {t('orgTicketSettingsEditor.approval.loadFailed')}{' '}
            <button type="button" onClick={() => void loadApproval()} className="underline">
              {t('common:actions.retry')}
            </button>
          </div>
        )}
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {approvalSelect('enabled', t('orgTicketSettingsEditor.approval.enabled'), onOffOptions)}
          {approvalSelect('budgetTrigger', t('orgTicketSettingsEditor.approval.budgetTrigger'), onOffOptions)}
          {approvalSelect('afterHoursTrigger', t('orgTicketSettingsEditor.approval.afterHoursTrigger'), onOffOptions)}
          {approvalSelect('enforcement', t('orgTicketSettingsEditor.approval.enforcement'), [
            { value: 'soft', label: t('orgTicketSettingsEditor.approval.enforcementSoft') },
            { value: 'hard', label: t('orgTicketSettingsEditor.approval.enforcementHard') },
          ])}
          <div>
            <InheritedField
              id="org-approval-ttl"
              label={t('orgTicketSettingsEditor.approval.ttl')}
              value={approval.requestTtlHours}
              onChange={(v) => updateApproval('requestTtlHours', v)}
              inheritedValue={approvalResolved && approvalBase.requestTtlHours === '' ? approvalResolved.requestTtlHours.value : null}
              inheritedSource={approvalResolved ? sourceLabel(approvalResolved.requestTtlHours.source) : t('orgTicketSettingsEditor.partnerDefault')}
              type="number"
              min={TTL_MIN}
              max={TTL_MAX}
              disabled={!approvalResolved}
              data-testid="org-approval-ttl"
            />
            {clearButton('requestTtlHours')}
          </div>
        </div>
        {approvalError && (
          <p className="mt-2 text-sm text-destructive" data-testid="org-approval-error">{approvalError}</p>
        )}
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
