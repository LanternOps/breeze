import { useState } from 'react';
import { useDeliveryResource } from './useDeliveryResource';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { Drawer } from '../../shared/Drawer';
import type { ChannelChoice } from './useDeliveryResource';
import type { EditableEscalationPolicy } from './deliveryActions';

type Step = { delayMinutes: number; channelIds: string[]; userIds: string[]; repeat?: { everyMinutes: number; maxTimes: number } };
export type EscalationDrawerValues = { name: string; steps: Step[]; ownerScope: 'organization' | 'partner' };

export default function EscalationPolicyDrawer({ open, policy, channels, orgId, ownerScope, showOwnerScope, saving, onSave, onCancel }: {
  open: boolean; policy: EditableEscalationPolicy | null; channels: ChannelChoice[]; orgId: string | null;
  ownerScope: 'organization' | 'partner'; showOwnerScope: boolean; saving: boolean;
  onSave: (values: EscalationDrawerValues) => void; onCancel: () => void;
}) {
  const { t } = useTranslation('alerts');
  const [values, setValues] = useState<EscalationDrawerValues>(() => ({
    name: policy?.name ?? '',
    steps: policy?.steps?.length ? policy.steps.map((s) => ({ ...s, channelIds: [...s.channelIds], userIds: [...(s.userIds ?? [])] })) : [{ delayMinutes: 15, channelIds: [], userIds: [] }],
    ownerScope,
  }));
  const targetQuery = new URLSearchParams({ rail: 'users', ownerScope: values.ownerScope });
  if (orgId && values.ownerScope !== 'partner') targetQuery.set('orgId', orgId);
  const users = useDeliveryResource<{ id: string; name: string }>(`/alerts/delivery/rails?${targetQuery}`);
  const setStep = (i: number, patch: Partial<Step>) => setValues((v) => ({ ...v, steps: v.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const toggleChannel = (i: number, id: string) => setStep(i, { channelIds: values.steps[i]!.channelIds.includes(id) ? values.steps[i]!.channelIds.filter((c) => c !== id) : [...values.steps[i]!.channelIds, id] });
  const occurrenceLimitExceeded = values.steps.reduce((total, step) => total + 1 + (step.repeat?.maxTimes ?? 0), 0) > 50;
  const canSave = !occurrenceLimitExceeded && users.status === 'success' && values.name.trim().length > 0 && values.name.trim().length <= 255 && values.steps.length > 0 && values.steps.length <= 10
    && values.steps.every((s) => Number.isInteger(s.delayMinutes) && s.delayMinutes >= 1 && s.delayMinutes <= 10080 && s.channelIds.length + s.userIds.length > 0 && s.channelIds.length <= 100 && s.userIds.length <= 100
      && (!s.repeat || (Number.isInteger(s.repeat.everyMinutes) && s.repeat.everyMinutes >= 1 && s.repeat.everyMinutes <= 1440
        && Number.isInteger(s.repeat.maxTimes) && s.repeat.maxTimes >= 1 && s.repeat.maxTimes <= 10)));

  return (
    <Drawer open={open} onClose={onCancel} title={policy ? t('deliveryPage.escalation.edit') : t('deliveryPage.escalation.new')} width="max-w-lg" dataTestId="escalation-policy-drawer" closeDisabled={saving}>
      <div className="space-y-5 p-5">
        {!policy && showOwnerScope && (
          <fieldset className="space-y-2 rounded-md border p-3" data-testid="escalation-owner">
            <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">{t('notificationChannelsPage.scope')}</legend>
            {(['partner', 'organization'] as const).map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-sm">
                <input type="radio" checked={values.ownerScope === scope} onChange={() => setValues((v) => ({ ...v, ownerScope: scope, steps: v.steps.map(step => ({ ...step, userIds: [] })) }))} data-testid={`escalation-owner-${scope === 'partner' ? 'partner' : 'org'}`} />
                {scope === 'partner' ? t('notificationChannelsPage.allOrganizations') : t('notificationChannelsPage.thisOrganizationOnly')}
              </label>
            ))}
          </fieldset>
        )}
        <label className="block text-xs font-medium text-muted-foreground">{t('notificationChannelsPage.name')}
          <input maxLength={255} value={values.name} onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))} data-testid="escalation-name" className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm" />
        </label>
        <div className="space-y-3">
          <p className="text-xs font-medium text-muted-foreground">{t('deliveryPage.escalation.steps')}</p>
          {values.steps.map((step, i) => (
            <div key={i} className="space-y-2 rounded-md border p-3" data-testid={`escalation-step-${i}`}>
              <div className="flex items-end gap-3">
                <label className="block flex-1 text-xs font-medium text-muted-foreground">{t('deliveryPage.escalation.delayMinutes')}
                  <input type="number" min={1} max={10080} value={step.delayMinutes} onChange={(e) => setStep(i, { delayMinutes: Number(e.target.value) })} data-testid={`escalation-step-${i}-delay`} className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm" />
                </label>
                {values.steps.length > 1 && (
                  <button type="button" onClick={() => setValues((v) => ({ ...v, steps: v.steps.filter((_, j) => j !== i) }))} aria-label={t('deliveryPage.escalation.removeStep')} data-testid={`escalation-step-${i}-remove`} className="h-9 rounded-md p-2 text-destructive hover:bg-muted"><Trash2 className="h-4 w-4" /></button>
                )}
              </div>
              <p className="text-xs font-medium text-muted-foreground">{t('deliveryPage.escalation.notifyChannels')}</p>
              {channels.map((ch) => (
                <label key={ch.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-muted">
                  <input type="checkbox" aria-label={ch.name} data-testid={`escalation-step-${i}-channel-${ch.id}`} checked={step.channelIds.includes(ch.id)} onChange={() => toggleChannel(i, ch.id)} className="h-4 w-4 rounded border-muted" />
                  <span className="text-sm">{ch.name}</span><span className="text-xs text-muted-foreground">({ch.type})</span>
                </label>
              ))}
              <p>{t('deliveryPage.escalation.notifyUsers')}</p>
              {users.status === 'error' && <div role="alert">{t('deliveryPage.loadFailed')} <button type="button" onClick={users.reload} data-testid={`escalation-step-${i}-users-retry`}>{t('common:actions.retry')}</button></div>}
              {users.status === 'loading' && <p role="status">{t('deliveryPage.loading')}</p>}
              {users.data.map(user => <label key={user.id} className="flex gap-2">
                <input type="checkbox" data-testid={`escalation-step-${i}-user-${user.id}`} checked={step.userIds.includes(user.id)}
                  onChange={() => setStep(i, { userIds: step.userIds.includes(user.id)
                    ? step.userIds.filter(id => id !== user.id) : [...step.userIds, user.id] })} />{user.name}
              </label>)}
              <label className="flex gap-2"><input type="checkbox" checked={!!step.repeat}
                data-testid={`escalation-step-${i}-repeat`}
                onChange={e => setStep(i, { repeat: e.target.checked ? { everyMinutes: 15, maxTimes: 1 } : undefined })} />
                {t('deliveryPage.escalation.repeat')}
              </label>
              {step.repeat && <div className="grid grid-cols-2 gap-3">
                <label>{t('deliveryPage.escalation.everyMinutes')}<input type="number" min={1} max={1440}
                  data-testid={`escalation-step-${i}-every`} value={step.repeat.everyMinutes}
                  onChange={e => setStep(i, { repeat: { ...step.repeat!, everyMinutes: Number(e.target.value) } })} /></label>
                <label>{t('deliveryPage.escalation.maxTimes')}<input type="number" min={1} max={10}
                  data-testid={`escalation-step-${i}-times`} value={step.repeat.maxTimes}
                  onChange={e => setStep(i, { repeat: { ...step.repeat!, maxTimes: Number(e.target.value) } })} /></label>
              </div>}

            </div>
          ))}
          {values.steps.length < 10 && (
            <button type="button" onClick={() => setValues((v) => ({ ...v, steps: [...v.steps, { delayMinutes: (v.steps.at(-1)?.delayMinutes ?? 0) + 15, channelIds: [], userIds: [] }] }))} data-testid="escalation-add-step" className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted">
              <Plus className="h-3.5 w-3.5" /> {t('deliveryPage.escalation.addStep')}
            </button>
          )}
        </div>
        {occurrenceLimitExceeded && <p role="alert" className="text-sm text-destructive">{t('deliveryPage.escalation.occurrenceLimit')}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onCancel} data-testid="escalation-policy-drawer-cancel" disabled={saving} className="h-9 rounded-md border px-4 text-sm font-medium text-muted-foreground hover:text-foreground">{t('common:actions.cancel')}</button>
          <button type="button" onClick={() => onSave(values)} disabled={!canSave || saving} data-testid="escalation-policy-drawer-save" className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60">{t('common:actions.save')}</button>
        </div>
      </div>
    </Drawer>
  );
}
